import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  githubMutationResultSchema,
  githubBranchPublishCandidateManifestRequestSchema,
  githubBranchPublishCandidateChunkRequestSchema,
  githubReadResultSchema,
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeClaimRequestV2Schema,
  sessionRuntimeCompletionRequestSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionRuntimeGitHubMutationRequestSchema,
  sessionRuntimeGitHubReadRequestSchema,
  sessionRuntimeWorkItemCommentRequestSchema,
  sessionRuntimeWorkItemCreateRequestSchema,
  sessionRuntimeWorkItemGetRequestSchema,
  sessionRuntimeWorkItemRelateRequestSchema,
  sessionRuntimeWorkItemSearchRequestSchema,
  sessionRuntimeWorkItemUpdateRequestSchema,
  workItemAdmissionRequestSchema,
  type SessionCommandResult,
  type GitHubMutationResult,
  type GitHubReadResult,
  type WorkItemCommentResult,
  type WorkItemCreateResult,
  type WorkItemProjection,
  type WorkItemRelateResult,
  type WorkItemSearchResult,
  type WorkItemUpdateResult,
  type SessionRuntimePermissionResult,
  type WorkItemAdmissionResult,
} from "@codeops/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import type { SessionRuntimeDispatchClaim } from "./session-broker-runtime-outbox.js";
import { WorkItemAdmissionDuplicateError, WorkItemAdmissionNotFoundError } from "./work-item-admission.js";
import {
  ClaimedDispatchAuthorityConflictError,
  ClaimedDispatchAuthorityNotFoundError,
} from "./claimed-dispatch-authority.js";
import {
  GitHubBranchCandidateConflictError,
  GitHubBranchCandidateInvalidRequestError,
  GitHubBranchCandidateNotFoundError,
} from "./github-branch-publish-candidates.js";
import { SessionRuntimeGitHubMutationConflictError } from "./session-runtime-github-mutations.js";

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
const workItemAdmissionPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/work-item-admissions$/i;
const githubReadPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/github-reads$/i;
const githubMutationPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/github-mutations$/i;
const githubCandidateManifestPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/github-branch-candidates\/manifests$/i;
const githubCandidateChunkPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/github-branch-candidates\/chunks\/(\d{1,2})$/i;

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

function githubBranchCandidateFailure(
  error: unknown,
): SessionRuntimeHttpResult | undefined {
  if (error instanceof GitHubBranchCandidateInvalidRequestError) {
    return { status: 400, body: { status: "invalid-request" } };
  }
  if (error instanceof GitHubBranchCandidateNotFoundError ||
      error instanceof ClaimedDispatchAuthorityNotFoundError) {
    return { status: 404, body: { status: "not-found" } };
  }
  if (error instanceof GitHubBranchCandidateConflictError ||
      error instanceof ClaimedDispatchAuthorityConflictError) {
    return { status: 409, body: { status: "conflict" } };
  }
  return undefined;
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
  readonly admitWorkItem?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<WorkItemAdmissionResult>;
  readonly readGitHub?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<GitHubReadResult>;
  readonly mutateGitHub?: (input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
  }) => Promise<GitHubMutationResult>;
  readonly createGitHubBranchCandidateManifest?: (input: {
    readonly dispatchId: string; readonly workerId: string; readonly request: unknown;
  }) => Promise<void>;
  readonly storeGitHubBranchCandidateChunk?: (input: {
    readonly dispatchId: string; readonly workerId: string; readonly request: unknown;
  }) => Promise<void>;
}): Promise<SessionRuntimeHttpResult | null> {
  if (input.method !== "POST" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const isClaim = url.pathname === claimPath;
  const completionMatch = url.pathname.match(completionPath);
  const permissionSubmissionMatch = url.pathname.match(permissionSubmissionPath);
  const permissionPollMatch = url.pathname.match(permissionPollPath);
  const workItemMatch = url.pathname.match(workItemPath);
  const workItemAdmissionMatch = url.pathname.match(workItemAdmissionPath);
  const githubReadMatch = url.pathname.match(githubReadPath);
  const githubMutationMatch = url.pathname.match(githubMutationPath);
  const githubCandidateManifestMatch = url.pathname.match(githubCandidateManifestPath);
  const githubCandidateChunkMatch = url.pathname.match(githubCandidateChunkPath);
  if (
    !isClaim &&
    completionMatch === null &&
    permissionSubmissionMatch === null &&
    permissionPollMatch === null
    && workItemMatch === null
    && workItemAdmissionMatch === null
    && githubReadMatch === null
    && githubMutationMatch === null
    && githubCandidateManifestMatch === null
    && githubCandidateChunkMatch === null
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
    const requestBody = await readRequestBody(input.readBody);
    const request = z.union([
      sessionRuntimeClaimRequestSchema,
      sessionRuntimeClaimRequestV2Schema,
    ]).safeParse(requestBody);
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
    const extended = request.data.version === "codeops.session-runtime-claim-request/v2";
    return {
      status: 200,
      body: {
        version: extended
          ? "codeops.session-runtime-claim-response/v2"
          : "codeops.session-runtime-claim-response/v1",
        claim: claim === null || extended ? claim : {
          dispatch: claim.dispatch,
          claimToken: claim.claimToken,
          claimExpiresAt: claim.claimExpiresAt,
          claimCount: claim.claimCount,
        },
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

  if (workItemAdmissionMatch !== null) {
    if (input.admitWorkItem === undefined) return { status: 404, body: { status: "not-found" } };
    const admission = workItemAdmissionRequestSchema.safeParse(await readRequestBody(input.readBody));
    if (!admission.success) throw new InvalidSessionRuntimeRequestError("session runtime work-item admission body is invalid");
    try {
      return { status: 200, body: await input.admitWorkItem({
        dispatchId: dispatchId.parse(workItemAdmissionMatch[1]), workerId: input.workerId, request: admission.data }) };
    } catch (error) {
      if (error instanceof WorkItemAdmissionDuplicateError) return { status: 409, body: { status: "conflict" } };
      if (error instanceof WorkItemAdmissionNotFoundError) return { status: 404, body: { status: "not-found" } };
      throw error;
    }
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

  if (githubMutationMatch !== null) {
    if (input.mutateGitHub === undefined) {
      return { status: 404, body: { status: "not-found" } };
    }
    const githubMutationRequest =
      sessionRuntimeGitHubMutationRequestSchema.safeParse(
        await readRequestBody(input.readBody),
      );
    if (!githubMutationRequest.success) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime GitHub mutation body is invalid",
      );
    }
    try {
      return {
        status: 200,
        body: githubMutationResultSchema.parse(await input.mutateGitHub({
          dispatchId: dispatchId.parse(githubMutationMatch[1]),
          workerId: input.workerId,
          request: githubMutationRequest.data,
        })),
      };
    } catch (error) {
      if (error instanceof SessionRuntimeGitHubMutationConflictError) {
        return { status: 409, body: { status: "conflict" } };
      }
      throw error;
    }
  }

  if (githubCandidateManifestMatch !== null) {
    if (input.createGitHubBranchCandidateManifest === undefined) {
      return { status: 404, body: { status: "not-found" } };
    }
    const candidate = githubBranchPublishCandidateManifestRequestSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!candidate.success) throw new InvalidSessionRuntimeRequestError(
      "session runtime GitHub candidate manifest body is invalid",
    );
    try {
      await input.createGitHubBranchCandidateManifest({
        dispatchId: dispatchId.parse(githubCandidateManifestMatch[1]),
        workerId: input.workerId, request: candidate.data,
      });
    } catch (error) {
      const failure = githubBranchCandidateFailure(error);
      if (failure !== undefined) return failure;
      throw error;
    }
    return { status: 200, body: { status: "stored" } };
  }

  if (githubCandidateChunkMatch !== null) {
    if (input.storeGitHubBranchCandidateChunk === undefined) {
      return { status: 404, body: { status: "not-found" } };
    }
    const candidate = githubBranchPublishCandidateChunkRequestSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!candidate.success || candidate.data.ordinal !== Number(githubCandidateChunkMatch[2])) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime GitHub candidate chunk body is invalid",
      );
    }
    try {
      await input.storeGitHubBranchCandidateChunk({
        dispatchId: dispatchId.parse(githubCandidateChunkMatch[1]),
        workerId: input.workerId, request: candidate.data,
      });
    } catch (error) {
      const failure = githubBranchCandidateFailure(error);
      if (failure !== undefined) return failure;
      throw error;
    }
    return { status: 200, body: { status: "stored" } };
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
