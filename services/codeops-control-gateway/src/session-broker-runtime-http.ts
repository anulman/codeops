import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  githubReadResultSchema,
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeCompletionRequestSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionRuntimeGitHubReadRequestSchema,
  sessionRuntimeWorkItemCommentRequestSchema,
  sessionRuntimeWorkItemCreateRequestSchema,
  sessionRuntimeWorkItemGetRequestSchema,
  sessionRuntimeWorkItemRelateRequestSchema,
  sessionRuntimeWorkItemSearchRequestSchema,
  sessionRuntimeWorkItemUpdateRequestSchema,
  type SessionCommandResult,
  type GitHubReadResult,
  type WorkItemCommentResult,
  type WorkItemCreateResult,
  type WorkItemProjection,
  type WorkItemRelateResult,
  type WorkItemSearchResult,
  type WorkItemUpdateResult,
  type SessionRuntimePermissionResult,
} from "@codeops/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import type { SessionRuntimeDispatchClaim } from "./session-broker-runtime-outbox.js";

const dispatchId = z.string().uuid();
const claimPath = "/v1/session-runtime/claims";
const completionPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/completions$/i;
const permissionSubmissionPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/permissions$/i;
const permissionPollPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/permissions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/poll$/;
const workItemPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/work-items(?:\/(get|search|comment|update|relate))?$/i;
const githubReadPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/github-reads$/i;

function header(
  headers: IncomingHttpHeaders,
  name: "authorization" | "content-type",
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function requireJson(headers: IncomingHttpHeaders): void {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      header(headers, "content-type") ?? "",
    )
  ) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime content type must be application/json",
    );
  }
}

async function readRequestBody(
  readBody: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await readBody();
  } catch {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime body is not valid bounded JSON",
    );
  }
}

export class InvalidSessionRuntimeRequestError extends Error {}

export interface SessionRuntimeHttpResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function serveSessionRuntime(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly workerId: string;
  readonly readBody: () => Promise<unknown>;
  readonly claim: (input: {
    readonly workerId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly identity: unknown;
    readonly leaseMs: number;
  }) => Promise<SessionRuntimeDispatchClaim | null>;
  readonly complete: (input: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly completion: unknown;
  }) => Promise<SessionCommandResult>;
  readonly submitPermission: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly submission: unknown;
  }) => Promise<SessionRuntimePermissionResult>;
  readonly pollPermission: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly poll: unknown;
  }) => Promise<SessionRuntimePermissionResult>;
  readonly createWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemCreateResult>;
  readonly getWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemProjection>;
  readonly searchWorkItems?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemSearchResult>;
  readonly commentWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemCommentResult>;
  readonly updateWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemUpdateResult>;
  readonly relateWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemRelateResult>;
  readonly readGitHub?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<GitHubReadResult>;
}): Promise<SessionRuntimeHttpResult | null> {
  if (input.method !== "POST" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const isClaim = url.pathname === claimPath;
  const completionMatch = url.pathname.match(completionPath);
  const permissionSubmissionMatch = url.pathname.match(permissionSubmissionPath);
  const permissionPollMatch = url.pathname.match(permissionPollPath);
  const workItemMatch = url.pathname.match(workItemPath);
  const githubReadMatch = url.pathname.match(githubReadPath);
  if (
    !isClaim &&
    completionMatch === null &&
    permissionSubmissionMatch === null &&
    permissionPollMatch === null
    && workItemMatch === null
    && githubReadMatch === null
  ) return null;
  if ([...url.searchParams].length !== 0) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime routes do not accept query parameters",
    );
  }
  if (!authenticateBearer(header(input.headers, "authorization"), input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  requireJson(input.headers);

  if (isClaim) {
    const request = sessionRuntimeClaimRequestSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!request.success) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime claim body is invalid",
      );
    }
    const claim = await input.claim({
      workerId: input.workerId,
      sessionId: request.data.sessionId,
      generation: request.data.generation,
      leaseId: request.data.leaseId,
      identity: request.data.identity,
      leaseMs: request.data.leaseMs,
    });
    return {
      status: 200,
      body: {
        version: "codeops.session-runtime-claim-response/v1",
        claim,
      },
    };
  }

  if (workItemMatch !== null) {
    const operation = workItemMatch[2] ?? "create";
    const operations = {
      create: [sessionRuntimeWorkItemCreateRequestSchema, input.createWorkItem],
      get: [sessionRuntimeWorkItemGetRequestSchema, input.getWorkItem],
      search: [sessionRuntimeWorkItemSearchRequestSchema, input.searchWorkItems],
      comment: [sessionRuntimeWorkItemCommentRequestSchema, input.commentWorkItem],
      update: [sessionRuntimeWorkItemUpdateRequestSchema, input.updateWorkItem],
      relate: [sessionRuntimeWorkItemRelateRequestSchema, input.relateWorkItem],
    } as const;
    const selected = operations[operation as keyof typeof operations];
    if (selected === undefined || selected[1] === undefined) {
      return { status: 404, body: { status: "not-found" } };
    }
    const workItemRequest = selected[0].safeParse(
      await readRequestBody(input.readBody),
    );
    if (!workItemRequest.success) {
      throw new InvalidSessionRuntimeRequestError(
        `session runtime work-item ${operation} body is invalid`,
      );
    }
    return {
      status: 200,
      body: await selected[1]({
        dispatchId: dispatchId.parse(workItemMatch[1]),
        workerId: input.workerId,
        request: workItemRequest.data,
      } as never),
    };
  }

  if (githubReadMatch !== null) {
    if (input.readGitHub === undefined) {
      return { status: 404, body: { status: "not-found" } };
    }
    const githubReadRequest = sessionRuntimeGitHubReadRequestSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!githubReadRequest.success) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime GitHub read body is invalid",
      );
    }
    return {
      status: 200,
      body: githubReadResultSchema.parse(await input.readGitHub({
        dispatchId: dispatchId.parse(githubReadMatch[1]),
        workerId: input.workerId,
        request: githubReadRequest.data,
      })),
    };
  }

  if (permissionSubmissionMatch !== null) {
    const submission = sessionRuntimePermissionSubmissionSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!submission.success) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime permission submission body is invalid",
      );
    }
    return {
      status: 200,
      body: await input.submitPermission({
        dispatchId: dispatchId.parse(permissionSubmissionMatch[1]),
        workerId: input.workerId,
        submission: submission.data,
      }),
    };
  }

  if (permissionPollMatch !== null) {
    const poll = sessionRuntimePermissionPollSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!poll.success || poll.data.requestId !== permissionPollMatch[2]) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime permission poll path and body identities do not match",
      );
    }
    return {
      status: 200,
      body: await input.pollPermission({
        dispatchId: dispatchId.parse(permissionPollMatch[1]),
        workerId: input.workerId,
        poll: poll.data,
      }),
    };
  }

  const request = sessionRuntimeCompletionRequestSchema.safeParse(
    await readRequestBody(input.readBody),
  );
  if (!request.success) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime completion body is invalid",
    );
  }
  const pathDispatchId = dispatchId.parse(completionMatch![1]);
  if (request.data.completion.dispatchId !== pathDispatchId) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime completion path and body identities do not match",
    );
  }
  return {
    status: 200,
    body: await input.complete({
      dispatchId: pathDispatchId,
      claimToken: request.data.claimToken,
      workerId: input.workerId,
      completion: request.data.completion,
    }),
  };
}
