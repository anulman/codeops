import type { IncomingHttpHeaders } from "node:http";
import {
  SESSION_BROKER_VERSION,
  sessionSnapshotSchema,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";
import { authenticateBearer } from "./bearer-auth.js";

const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const requestSchema = z
  .object({
    version: z.literal("codeops.github-session-steering/v1"),
    binding: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        number: z.number().int().positive().max(10_000_000),
        workItemId: z.string().uuid(),
        state: z.literal("open"),
        headSha: gitSha,
        headRef: z.string().min(1).max(200),
        baseRef: z.string().min(1).max(200),
      })
      .passthrough(),
    event: z
      .object({
        kind: z.enum([
          "issue_comment",
          "pull_request_review_comment",
          "pull_request",
        ]),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        number: z.number().int().positive().max(10_000_000),
        actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        actorType: z.literal("User"),
        headSha: gitSha.optional(),
        currentHeadSha: gitSha,
        headRef: z.string().min(1).max(200),
        baseRef: z.string().min(1).max(200),
      })
      .passthrough(),
    prompt: z.string().min(1).max(65_536),
    idempotencyKey: z.string().uuid(),
    principalId: z.string().regex(/^github:[1-9][0-9]{0,15}$/),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.event.repository !== request.binding.repository ||
      request.event.number !== request.binding.number ||
      request.principalId !== `github:${request.event.actorId}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GitHub event, binding, and principal identities must match",
      });
    }
    if (
      request.event.currentHeadSha !== request.binding.headSha ||
      request.event.headRef !== request.binding.headRef ||
      request.event.baseRef !== request.binding.baseRef ||
      (request.event.headSha !== undefined &&
        request.event.headSha !== request.event.currentHeadSha)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GitHub event must identify the exact bound current pull request",
      });
    }
  });

export class InvalidGitHubSessionSteeringRequestError extends Error {}
export class GitHubSessionTargetNotFoundError extends Error {}
export class AmbiguousGitHubSessionTargetError extends Error {}

function authorization(headers: IncomingHttpHeaders): string | undefined {
  return typeof headers.authorization === "string"
    ? headers.authorization
    : undefined;
}

export function resolveGitHubSessionTarget(input: {
  readonly sessions: readonly unknown[];
  readonly binding: z.infer<typeof requestSchema>["binding"];
  readonly now?: Date;
}): SessionSnapshot {
  const now = (input.now ?? new Date()).getTime();
  const matches = input.sessions
    .map((session) => sessionSnapshotSchema.parse(session))
    .filter((session) => {
      const prompt = session.capabilities.find(({ action }) => action === "prompt");
      return (
        session.state === "running" &&
        prompt?.availability === "enabled" &&
        session.lease?.status === "active" &&
        Date.parse(session.lease.expiresAt) > now &&
        session.identity.repository === input.binding.repository &&
        session.identity.branch === input.binding.headRef &&
        session.identity.workItemId === input.binding.workItemId &&
        session.identity.pullRequestNumber === input.binding.number &&
        session.identity.pullRequestHeadSha === input.binding.headSha
      );
    });
  if (matches.length === 0) throw new GitHubSessionTargetNotFoundError();
  if (matches.length !== 1) throw new AmbiguousGitHubSessionTargetError();
  return matches[0]!;
}

export async function serveGitHubSessionSteering(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly listSessions: () => Promise<readonly SessionSnapshot[]>;
  readonly enqueue: (input: {
    readonly command: unknown;
    readonly principalId: string;
  }) => Promise<SessionRuntimeDispatch>;
  readonly now?: () => Date;
}): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null> {
  if (input.method !== "POST" || input.url !== "/v1/github-session-events") {
    return null;
  }
  if (!authenticateBearer(authorization(input.headers), input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  const contentType = input.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new InvalidGitHubSessionSteeringRequestError();
  }
  let request: z.infer<typeof requestSchema>;
  try {
    request = requestSchema.parse(await input.readBody());
  } catch {
    throw new InvalidGitHubSessionSteeringRequestError();
  }
  const session = resolveGitHubSessionTarget({
    sessions: await input.listSessions(),
    binding: request.binding,
    now: (input.now ?? (() => new Date()))(),
  });
  const dispatch = await input.enqueue({
    principalId: request.principalId,
    command: {
      version: SESSION_BROKER_VERSION.command,
      sessionId: session.sessionId,
      generation: session.generation,
      leaseId: session.lease!.leaseId,
      idempotencyKey: request.idempotencyKey,
      type: "prompt",
      prompt: request.prompt,
    },
  });
  return {
    status: 202,
    body: {
      version: "codeops.github-session-steering-result/v1",
      status: "accepted",
      sessionId: session.sessionId,
      workItemId: request.binding.workItemId,
      idempotencyKey: request.idempotencyKey,
      dispatchId: dispatch.dispatchId,
    },
  };
}
