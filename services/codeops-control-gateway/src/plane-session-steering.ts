import type { IncomingHttpHeaders } from "node:http";
import {
  isWorkspaceSessionIdentity,
  planeSessionRequestSchema,
  SESSION_BROKER_VERSION,
  sessionSnapshotSchema,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { authenticateBearer } from "./bearer-auth.js";

const requestSchema = z
  .object({
    version: z.literal("codeops.plane-session-steering/v1"),
    request: planeSessionRequestSchema,
    principalId: z.string().regex(/^plane:[0-9a-f-]{36}$/),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.principalId !== `plane:${input.request.requestedBy}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plane request and principal identities must match",
      });
    }
  });

export class InvalidPlaneSessionSteeringRequestError extends Error {}
export class PlaneSessionTargetNotFoundError extends Error {}
export class AmbiguousPlaneSessionTargetError extends Error {}

function authorization(headers: IncomingHttpHeaders): string | undefined {
  return typeof headers.authorization === "string"
    ? headers.authorization
    : undefined;
}

function hasRepository(session: SessionSnapshot, repository: string): boolean {
  return isWorkspaceSessionIdentity(session.identity)
    ? session.identity.workspace.sources.some(
        (source) => source.repository === repository,
      )
    : session.identity.repository === repository;
}

function requestRepository(
  request: z.infer<typeof planeSessionRequestSchema>,
): string {
  return `${request.repository.owner}/${request.repository.name}`;
}

export function resolvePlaneSessionTarget(input: {
  readonly sessions: readonly unknown[];
  readonly request: z.infer<typeof planeSessionRequestSchema>;
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
        session.identity.workItemId === input.request.workItemId &&
        hasRepository(session, requestRepository(input.request))
      );
    });
  const coordinators = matches.filter(
    (session) => session.identity.agentRole === "coordinator",
  );
  const candidates = coordinators.length > 0 ? coordinators : matches;
  if (candidates.length === 0) throw new PlaneSessionTargetNotFoundError();
  if (candidates.length !== 1) throw new AmbiguousPlaneSessionTargetError();
  return candidates[0]!;
}

function prompt(request: z.infer<typeof planeSessionRequestSchema>): string {
  return [
    `Plane ${request.intent} request for work item ${request.workItemId}.`,
    `Plane revision: ${request.planeRevisionDigest}.`,
    `Exact repository base: ${requestRepository(request)}@${request.baseSha}.`,
    `Ticket: ${request.ticketSnapshot.name}`,
    "",
    request.comment,
    "",
    "Use the attached ticket snapshot in this request as current context. Reload the work item before any update and use its exact revision.",
  ].join("\n");
}

export async function servePlaneSessionSteering(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly resolveToken: (repository: string) => string;
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
  const route = input.method === "POST"
    ? input.url?.match(
        /^\/v1\/repositories\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/plane-session-events$/,
      )
    : null;
  if (route === null || route === undefined) return null;
  const repository = `${route[1]}/${route[2]}`;
  let token: string;
  try {
    token = input.resolveToken(repository);
  } catch {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (!authenticateBearer(authorization(input.headers), token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (
    typeof input.headers["content-type"] !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      input.headers["content-type"],
    )
  ) {
    throw new InvalidPlaneSessionSteeringRequestError();
  }
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await input.readBody());
  } catch {
    throw new InvalidPlaneSessionSteeringRequestError();
  }
  if (requestRepository(body.request) !== repository) {
    throw new InvalidPlaneSessionSteeringRequestError();
  }
  const session = resolvePlaneSessionTarget({
    sessions: await input.listSessions(),
    request: body.request,
    now: (input.now ?? (() => new Date()))(),
  });
  const dispatch = await input.enqueue({
    principalId: body.principalId,
    command: {
      version: SESSION_BROKER_VERSION.command,
      sessionId: session.sessionId,
      generation: session.generation,
      leaseId: session.lease!.leaseId,
      idempotencyKey: body.request.triggerCommentId,
      type: "prompt",
      prompt: prompt(body.request),
    },
  });
  return {
    status: 202,
    body: {
      version: "codeops.plane-session-steering-result/v1",
      status: "accepted",
      sessionId: session.sessionId,
      workItemId: body.request.workItemId,
      repository,
      requestId: body.request.requestId,
      dispatchId: dispatch.dispatchId,
    },
  };
}
