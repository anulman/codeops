import {
  canonicalJsonText,
  githubMutationResultSchema,
  githubBranchPublishCandidateManifestRequestSchema,
  githubBranchPublishCandidateChunkRequestSchema,
  githubReadResultSchema,
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeClaimRequestV2Schema,
  sessionRuntimeClaimResponseV2Schema,
  sessionRuntimeClaimRenewalRequestSchema,
  sessionRuntimeClaimRenewalResponseSchema,
  sessionRuntimeCheckpointMaterialSchema,
  sessionRuntimeCompletionRequestSchema,
  sessionRuntimeCompletionResponseSchema,
  sessionRuntimeCompletionSchema,
  sessionRuntimeForkMaterialSchema,
  sessionRuntimeLeaseMaterialSchema,
  sessionRuntimeModelAuthorityRequestSchema,
  sessionRuntimeModelAuthorityResponseSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionResultSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionRuntimeGitHubMutationRequestSchema,
  sessionRuntimeGitHubReadRequestSchema,
  sessionTimelineUpdateSchema,
  sessionRuntimeWorkItemCommentRequestSchema,
  sessionRuntimeWorkItemCreateRequestSchema,
  sessionRuntimeWorkItemGetRequestSchema,
  sessionRuntimeWorkItemRelateRequestSchema,
  sessionRuntimeWorkItemSearchRequestSchema,
  sessionRuntimeWorkItemUpdateRequestSchema,
  workItemCommentResultSchema,
  workItemCreateResultSchema,
  workItemProjectionSchema,
  workItemRelateResultSchema,
  workItemSearchResultSchema,
  workItemUpdateResultSchema,
  type SessionCommandResult,
  type GitHubMutationResult,
  type GitHubMutationOperation,
  type GitHubBranchPublishCandidateManifestRequest,
  type GitHubBranchPublishCandidateChunkRequest,
  type GitHubReadResult,
  type SessionIdentity,
  type SessionRuntimeCompletion,
  type SessionRuntimeDispatch,
  type SessionRuntimeDispatchClaimV2,
  type SessionRuntimePermissionResult,
  type SessionRuntimePermissionSubmission,
  type SessionRuntimeModelAuthorityResponse,
  type SessionRuntimeGitHubMutationRequest,
  type SessionRuntimeGitHubReadRequest,
  type WorkItemCommentInput,
  type WorkItemCommentResult,
  type WorkItemCreateInput,
  type WorkItemCreateResult,
  type WorkItemGetInput,
  type WorkItemProjection,
  type WorkItemRelateInput,
  type WorkItemRelateResult,
  type WorkItemSearchInput,
  type WorkItemSearchResult,
  type WorkItemUpdateInput,
  type WorkItemUpdateResult,
} from "@codeops/codeops-contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,4096}$/;

export class SessionRuntimeTransportError extends Error {}

export const runtimeExecutionResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("prompt"),
      material: z
        .object({
          response: z.string().max(200_000),
          stopReason: z.enum([
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
          ]),
          updates: z
            .array(sessionTimelineUpdateSchema)
            .max(2_000)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("checkpoint"),
      material: sessionRuntimeCheckpointMaterialSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("hibernate"),
      material: sessionRuntimeCheckpointMaterialSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resume"),
      material: sessionRuntimeLeaseMaterialSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("fork"),
      material: sessionRuntimeForkMaterialSchema,
    })
    .strict(),
]);

export type RuntimeExecutionResult = z.infer<
  typeof runtimeExecutionResultSchema
>;

export type RuntimePermissionSubmission = Omit<
  SessionRuntimePermissionSubmission,
  "version" | "claimToken"
>;

export type RuntimeGitHubReadRequest =
  SessionRuntimeGitHubReadRequest extends infer Request
    ? Request extends unknown
      ? Omit<Request, "version" | "claimToken">
      : never
    : never;

export type RuntimeGitHubMutationRequest =
  SessionRuntimeGitHubMutationRequest extends infer Request
    ? Request extends unknown
      ? Omit<Request, "version" | "claimToken">
      : never
    : never;

export interface RuntimeExecutionContext {
  readonly isAdmittedInitialDispatch: boolean;
  issueModelAuthority(): Promise<SessionRuntimeModelAuthorityResponse>;
  bindGitHubMutationOperationId?(
    operation: GitHubMutationOperation,
    input: unknown,
  ): string;
  requestPermission(
    submission: RuntimePermissionSubmission,
  ): Promise<NonNullable<SessionRuntimePermissionResult["decision"]>>;
  createWorkItem(input: {
    readonly operationId: string;
    readonly workItem: WorkItemCreateInput;
  }): Promise<WorkItemCreateResult>;
  getWorkItem(input: {
    readonly operationId: string;
    readonly workItem: WorkItemGetInput;
  }): Promise<WorkItemProjection>;
  searchWorkItems(input: {
    readonly operationId: string;
    readonly workItem: WorkItemSearchInput;
  }): Promise<WorkItemSearchResult>;
  commentWorkItem(input: {
    readonly operationId: string;
    readonly workItem: WorkItemCommentInput;
  }): Promise<WorkItemCommentResult>;
  updateWorkItem(input: {
    readonly operationId: string;
    readonly workItem: WorkItemUpdateInput;
  }): Promise<WorkItemUpdateResult>;
  relateWorkItem(input: {
    readonly operationId: string;
    readonly workItem: WorkItemRelateInput;
  }): Promise<WorkItemRelateResult>;
  readGitHub(
    input: RuntimeGitHubReadRequest,
  ): Promise<GitHubReadResult>;
  mutateGitHub(
    input: RuntimeGitHubMutationRequest,
  ): Promise<GitHubMutationResult>;
  storeGitHubBranchCandidate(input: {
    readonly manifest: Omit<GitHubBranchPublishCandidateManifestRequest, "version" | "claimToken">;
    readonly chunks: readonly Omit<GitHubBranchPublishCandidateChunkRequest, "version" | "claimToken">[];
  }): Promise<void>;
}

export type RuntimeExecutor = (
  dispatch: SessionRuntimeDispatch,
  context: RuntimeExecutionContext,
) => Promise<RuntimeExecutionResult>;

export function buildSessionRuntimeCompletion(
  claim: SessionRuntimeDispatchClaimV2,
  rawExecution: unknown,
  completedAt: Date,
): SessionRuntimeCompletion {
  const execution = runtimeExecutionResultSchema.parse(rawExecution);
  const { dispatch } = claim;
  if (execution.type !== dispatch.command.type) {
    throw new SessionRuntimeTransportError(
      "session runtime executor result type drifted from the claimed command",
    );
  }
  const envelope = {
    version: "codeops.session-runtime-completion/v1" as const,
    dispatchId: dispatch.dispatchId,
    sessionId: dispatch.command.sessionId,
    generation: dispatch.command.generation,
    leaseId: dispatch.command.leaseId,
    idempotencyKey: dispatch.command.idempotencyKey,
    observedEventCursor: dispatch.snapshot.eventCursor,
    completedAt: completedAt.toISOString(),
  };
  return sessionRuntimeCompletionSchema.parse({
    ...envelope,
    type: execution.type,
    material: execution.material,
  });
}

export function exactGatewayOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime gateway URL must be one credential-free HTTP origin",
    );
  }
  return parsed.origin;
}

export function exactToken(raw: string): string {
  const token = raw.trim();
  if (token !== raw || !TOKEN_PATTERN.test(token)) {
    throw new SessionRuntimeTransportError(
      "session runtime token must be 32 to 4096 printable non-space bytes",
    );
  }
  return token;
}

export async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null) {
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw new SessionRuntimeTransportError(
        "session runtime response exceeds the 1 MiB transport bound",
      );
    }
  }
  if (response.body === null) {
    throw new SessionRuntimeTransportError(
      "session runtime response body is missing",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SessionRuntimeTransportError(
        "session runtime response exceeds the 1 MiB transport bound",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SessionRuntimeTransportError(
      "session runtime response is not valid bounded UTF-8 JSON",
    );
  }
}

export function requireSuccess(response: Response): void {
  if (response.status !== 200) {
    throw new SessionRuntimeTransportError(
      `session runtime gateway returned HTTP ${response.status}`,
    );
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime response content type must be application/json",
    );
  }
}

function requireCompletionIdentity(
  claim: SessionRuntimeDispatchClaimV2,
  completion: SessionRuntimeCompletion,
): void {
  const { dispatch, claimExpiresAt } = claim;
  const { command, snapshot } = dispatch;
  if (
    completion.dispatchId !== dispatch.dispatchId ||
    completion.sessionId !== command.sessionId ||
    completion.generation !== command.generation ||
    completion.leaseId !== command.leaseId ||
    completion.idempotencyKey !== command.idempotencyKey ||
    completion.type !== command.type ||
    completion.observedEventCursor !== snapshot.eventCursor ||
    Date.parse(completion.completedAt) < Date.parse(dispatch.dispatchedAt) ||
    Date.parse(completion.completedAt) >= Date.parse(claimExpiresAt)
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime completion drifted from the exact live claim",
    );
  }
}

export class SessionRuntimeTransport {
  readonly #origin: string;
  readonly #token: string;
  readonly #authority: {
    readonly sessionId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly identity: SessionIdentity;
  };
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(input: {
    readonly gatewayOrigin: string;
    readonly token: string;
    readonly authority: {
      readonly sessionId: string;
      readonly generation: number;
      readonly leaseId: string;
      readonly identity: SessionIdentity;
    };
    readonly fetch?: typeof fetch;
    readonly requestTimeoutMs?: number;
  }) {
    this.#origin = exactGatewayOrigin(input.gatewayOrigin);
    this.#token = exactToken(input.token);
    const authority = sessionRuntimeClaimRequestSchema.parse({
      version: "codeops.session-runtime-claim-request/v1",
      ...input.authority,
      leaseMs: 1_000,
    });
    this.#authority = {
      sessionId: authority.sessionId,
      generation: authority.generation,
      leaseId: authority.leaseId,
      identity: authority.identity,
    };
    this.#fetch = input.fetch ?? fetch;
    this.#requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1_000 ||
      this.#requestTimeoutMs > 30_000
    ) {
      throw new SessionRuntimeTransportError(
        "session runtime request timeout must be between 1 and 30 seconds",
      );
    }
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      requireSuccess(response);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof SessionRuntimeTransportError) throw error;
      throw new SessionRuntimeTransportError(
        `session runtime gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async claim(leaseMs: number): Promise<SessionRuntimeDispatchClaimV2 | null> {
    const request = sessionRuntimeClaimRequestV2Schema.parse({
      version: "codeops.session-runtime-claim-request/v2",
      ...this.#authority,
      leaseMs,
    });
    const response = sessionRuntimeClaimResponseV2Schema.parse(
      await this.#post("/v1/session-runtime/claims", request),
    );
    return response.claim;
  }

  async renewClaim(
    claim: SessionRuntimeDispatchClaimV2,
    leaseMs: number,
  ): Promise<SessionRuntimeDispatchClaimV2> {
    const request = sessionRuntimeClaimRenewalRequestSchema.parse({
      version: "codeops.session-runtime-claim-renewal-request/v1",
      claimToken: claim.claimToken,
      leaseMs,
    });
    const response = sessionRuntimeClaimRenewalResponseSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/claim-renewal`,
        request,
      ),
    );
    if (
      response.claim.dispatch.dispatchId !== claim.dispatch.dispatchId ||
      response.claim.claimToken !== claim.claimToken ||
      response.claim.claimCount !== claim.claimCount ||
      canonicalJsonText(response.claim.dispatch) !== canonicalJsonText(claim.dispatch) ||
      Date.parse(response.claim.claimExpiresAt) <= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "session runtime claim renewal drifted from the exact claim",
      );
    }
    return response.claim;
  }

  async complete(
    claim: SessionRuntimeDispatchClaimV2,
    rawCompletion: unknown,
    now: () => Date = () => new Date(),
  ): Promise<SessionCommandResult> {
    if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before completion submission",
      );
    }
    const completion = sessionRuntimeCompletionSchema.parse(rawCompletion);
    requireCompletionIdentity(claim, completion);
    const request = sessionRuntimeCompletionRequestSchema.parse({
      version: "codeops.session-runtime-completion-request/v1",
      claimToken: claim.claimToken,
      completion,
    });
    return sessionRuntimeCompletionResponseSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/completions`,
        request,
      ),
    );
  }

  async #requestPermission(
    claim: SessionRuntimeDispatchClaimV2,
    input: RuntimePermissionSubmission,
    now: () => Date,
  ): Promise<NonNullable<SessionRuntimePermissionResult["decision"]>> {
    if (claim.dispatch.command.type !== "prompt") {
      throw new SessionRuntimeTransportError(
        "only a claimed prompt may request ACP permission",
      );
    }
    const submission = sessionRuntimePermissionSubmissionSchema.parse({
      version: "codeops.session-runtime-permission-submission/v1",
      claimToken: claim.claimToken,
      ...input,
    });
    const path = `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/permissions`;
    let result = sessionRuntimePermissionResultSchema.parse(
      await this.#post(path, submission),
    );
    if (
      result.dispatchId !== claim.dispatch.dispatchId ||
      result.requestId !== submission.request.requestId
    ) {
      throw new SessionRuntimeTransportError(
        "session runtime permission response drifted from the exact claim",
      );
    }
    while (result.disposition === "pending") {
      if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
        throw new SessionRuntimeTransportError(
          "session runtime claim expired while waiting for permission",
        );
      }
      await delay(250);
      const poll = sessionRuntimePermissionPollSchema.parse({
        version: "codeops.session-runtime-permission-poll/v1",
        claimToken: claim.claimToken,
        requestId: submission.request.requestId,
      });
      result = sessionRuntimePermissionResultSchema.parse(
        await this.#post(
          `${path}/${submission.request.requestId}/poll`,
          poll,
        ),
      );
      if (
        result.dispatchId !== claim.dispatch.dispatchId ||
        result.requestId !== submission.request.requestId
      ) {
        throw new SessionRuntimeTransportError(
          "session runtime permission poll drifted from the exact claim",
        );
      }
    }
    if (result.decision === null) {
      throw new SessionRuntimeTransportError(
        "decided session runtime permission omitted its decision",
      );
    }
    return result.decision;
  }

  async #issueModelAuthority(
    claim: SessionRuntimeDispatchClaimV2,
    now: () => Date,
  ): Promise<SessionRuntimeModelAuthorityResponse> {
    if (
      !["prompt", "resume"].includes(claim.dispatch.command.type) ||
      now().getTime() >= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "only one live claimed prompt or resume may request model authority",
      );
    }
    const request = sessionRuntimeModelAuthorityRequestSchema.parse({
      version: "codeops.session-runtime-model-authority-request/v1",
      claimToken: claim.claimToken,
    });
    const result = sessionRuntimeModelAuthorityResponseSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/model-authority`,
        request,
      ),
    );
    if (
      result.dispatchId !== claim.dispatch.dispatchId ||
      Date.parse(result.expiresAt) <= now().getTime() ||
      Date.parse(result.expiresAt) > Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "session runtime model authority drifted from the exact live claim",
      );
    }
    return result;
  }

  async #createWorkItem(
    claim: SessionRuntimeDispatchClaimV2,
    input: {
      readonly operationId: string;
      readonly workItem: WorkItemCreateInput;
    },
    now: () => Date,
  ): Promise<WorkItemCreateResult> {
    if (
      claim.dispatch.command.type !== "prompt" ||
      now().getTime() >= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "only one live claimed prompt may create a work item",
      );
    }
    const request = sessionRuntimeWorkItemCreateRequestSchema.parse({
      version: "codeops.session-runtime-work-item-create-request/v1",
      claimToken: claim.claimToken,
      operationId: input.operationId,
      input: input.workItem,
    });
    return workItemCreateResultSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/work-items`,
        request,
      ),
    );
  }

  async #operateWorkItem(
    claim: SessionRuntimeDispatchClaimV2,
    operation: "get" | "search" | "comment" | "update" | "relate",
    input: { readonly operationId: string; readonly workItem: unknown },
    now: () => Date,
  ): Promise<unknown> {
    if (
      claim.dispatch.command.type !== "prompt" ||
      now().getTime() >= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        `only one live claimed prompt may ${operation} a work item`,
      );
    }
    const schemas = {
      get: sessionRuntimeWorkItemGetRequestSchema,
      search: sessionRuntimeWorkItemSearchRequestSchema,
      comment: sessionRuntimeWorkItemCommentRequestSchema,
      update: sessionRuntimeWorkItemUpdateRequestSchema,
      relate: sessionRuntimeWorkItemRelateRequestSchema,
    } as const;
    const results = {
      get: workItemProjectionSchema,
      search: workItemSearchResultSchema,
      comment: workItemCommentResultSchema,
      update: workItemUpdateResultSchema,
      relate: workItemRelateResultSchema,
    } as const;
    const request = schemas[operation].parse({
      version: `codeops.session-runtime-work-item-${operation}-request/v1`,
      claimToken: claim.claimToken,
      operationId: input.operationId,
      input: input.workItem,
    });
    return results[operation].parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/work-items/${operation}`,
        request,
      ),
    );
  }

  async #readGitHub(
    claim: SessionRuntimeDispatchClaimV2,
    input: RuntimeGitHubReadRequest,
    now: () => Date,
  ): Promise<GitHubReadResult> {
    if (
      claim.dispatch.command.type !== "prompt" ||
      now().getTime() >= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "only one live claimed prompt may read GitHub",
      );
    }
    const request = sessionRuntimeGitHubReadRequestSchema.parse({
      version: "codeops.session-runtime-github-read-request/v1",
      claimToken: claim.claimToken,
      ...input,
    });
    return githubReadResultSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/github-reads`,
        request,
      ),
    );
  }

  async #mutateGitHub(
    claim: SessionRuntimeDispatchClaimV2,
    input: RuntimeGitHubMutationRequest,
    now: () => Date,
  ): Promise<GitHubMutationResult> {
    if (
      claim.dispatch.command.type !== "prompt" ||
      now().getTime() >= Date.parse(claim.claimExpiresAt)
    ) {
      throw new SessionRuntimeTransportError(
        "only one live claimed prompt may mutate GitHub",
      );
    }
    const request = sessionRuntimeGitHubMutationRequestSchema.parse({
      version: "codeops.session-runtime-github-mutation-request/v1",
      claimToken: claim.claimToken,
      ...input,
    });
    return githubMutationResultSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/github-mutations`,
        request,
      ),
    );
  }

  async #storeGitHubBranchCandidate(
    claim: SessionRuntimeDispatchClaimV2,
    input: Parameters<RuntimeExecutionContext["storeGitHubBranchCandidate"]>[0],
    now: () => Date,
  ): Promise<void> {
    if (claim.dispatch.command.type !== "prompt" ||
        now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "only one live claimed prompt may store a GitHub branch candidate",
      );
    }
    const manifest = githubBranchPublishCandidateManifestRequestSchema.parse({
      version: "codeops.github-branch-publish-candidate-manifest-request/v1",
      claimToken: claim.claimToken,
      ...input.manifest,
    });
    const root = `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/github-branch-candidates`;
    await this.#post(`${root}/manifests`, manifest);
    for (const rawChunk of input.chunks) {
      const chunk = githubBranchPublishCandidateChunkRequestSchema.parse({
        version: "codeops.github-branch-publish-candidate-chunk-request/v1",
        claimToken: claim.claimToken,
        ...rawChunk,
      });
      await this.#post(`${root}/chunks/${chunk.ordinal}`, chunk);
    }
  }

  async runOne(input: {
    readonly leaseMs: number;
    readonly execute: RuntimeExecutor;
    readonly now?: () => Date;
  }): Promise<SessionCommandResult | null> {
    const claimed = await this.claim(input.leaseMs);
    if (claimed === null) return null;
    let claim = claimed;
    const now = input.now ?? (() => new Date());
    if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before execution began",
      );
    }
    // The executor owns ACP/workspace side effects, not broker claim authority.
    // Never expose the claim token or its completion lease to that boundary.
    const renewalAbort = new AbortController();
    let renewalError: unknown;
    const renewalTask = (async () => {
      const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 3));
      while (!renewalAbort.signal.aborted) {
        try {
          await delay(intervalMs, undefined, { signal: renewalAbort.signal });
        } catch (error) {
          if (renewalAbort.signal.aborted) return;
          renewalError = error;
          return;
        }
        try {
          claim = await this.renewClaim(claim, input.leaseMs);
        } catch (error) {
          renewalError = error;
          return;
        }
      }
    })();
    let execution: RuntimeExecutionResult;
    try {
      execution = await input.execute(claim.dispatch, {
      isAdmittedInitialDispatch: claim.isAdmittedInitialDispatch,
      // Claim authority remains captured inside the transport callback. The
      // ACP/workspace executor receives neither bearer nor claim token.
      bindGitHubMutationOperationId: (operation, mutationInput) =>
        `githubmutation-${createHash("sha256").update(canonicalJsonText({
          dispatchId: claim.dispatch.dispatchId,
          claimToken: claim.claimToken,
          operation,
          input: mutationInput,
        })).digest("hex")}`,
      issueModelAuthority: () => this.#issueModelAuthority(claim, now),
      requestPermission: (submission) =>
        this.#requestPermission(claim, submission, now),
      createWorkItem: (workItem) => this.#createWorkItem(claim, workItem, now),
      getWorkItem: async (workItem) => workItemProjectionSchema.parse(
        await this.#operateWorkItem(claim, "get", workItem, now),
      ),
      searchWorkItems: async (workItem) => workItemSearchResultSchema.parse(
        await this.#operateWorkItem(claim, "search", workItem, now),
      ),
      commentWorkItem: async (workItem) => workItemCommentResultSchema.parse(
        await this.#operateWorkItem(claim, "comment", workItem, now),
      ),
      updateWorkItem: async (workItem) => workItemUpdateResultSchema.parse(
        await this.#operateWorkItem(claim, "update", workItem, now),
      ),
      relateWorkItem: async (workItem) => workItemRelateResultSchema.parse(
        await this.#operateWorkItem(claim, "relate", workItem, now),
      ),
      readGitHub: (githubRead) => this.#readGitHub(claim, githubRead, now),
      mutateGitHub: (githubMutation) =>
        this.#mutateGitHub(claim, githubMutation, now),
      storeGitHubBranchCandidate: (candidate) =>
        this.#storeGitHubBranchCandidate(claim, candidate, now),
      });
    } finally {
      renewalAbort.abort();
      await renewalTask;
    }
    if (renewalError !== undefined) {
      throw new SessionRuntimeTransportError(
        `session runtime claim renewal failed: ${renewalError instanceof Error ? renewalError.message : String(renewalError)}`,
      );
    }
    const completedAt = now();
    if (completedAt.getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before completion submission",
      );
    }
    const completion = buildSessionRuntimeCompletion(
      claim,
      execution,
      completedAt,
    );
    return this.complete(claim, completion, now);
  }
}
