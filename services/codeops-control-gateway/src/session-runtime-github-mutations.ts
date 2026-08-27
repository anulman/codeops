import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubMutationProviderRequestSchema,
  githubMutationReconciliationProviderRequestSchema,
  githubMutationReconciliationResultSchema,
  githubMutationResultSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionPermissionOperationSchema,
  sessionRuntimeGitHubMutationRequestSchema,
  sessionRuntimePermissionSubmissionSchema,
  type GitHubMutationProviderRequest,
  type GitHubMutationResult,
  type GitHubMutationReconciliationResult,
  type SessionRuntimeGitHubMutationRequest,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import {
  ClaimedDispatchAuthorityConflictError,
  ClaimedDispatchAuthorityNotFoundError,
  loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource,
  type ClaimedDispatchAuthority,
} from "./claimed-dispatch-authority.js";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "./provider-response.js";

export class SessionRuntimeGitHubMutationNotFoundError extends Error {}
export class SessionRuntimeGitHubMutationConflictError extends Error {}

interface MutationAuthorizationRow extends Record<string, unknown> {
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
}

interface StoredMutationRow extends Record<string, unknown> {
  readonly dispatch_id: unknown;
  readonly payload_digest: unknown;
  readonly permission_digest: unknown;
  readonly state: unknown;
  readonly evidence_json: unknown;
}

export class GitHubMutationProviderNoEffectError extends Error {}

export const GITHUB_MUTATION_PROVIDER_TIMEOUT_MS = 240_000;
const MAX_GITHUB_MUTATION_PROVIDER_RESPONSE_BYTES = 1_024 * 1_024;

export type SessionRuntimeGitHubMutationAuthorization =
  | {
      readonly disposition: "authorized";
      readonly request: GitHubMutationProviderRequest;
    }
  | {
      readonly disposition: "replayed";
      readonly result: GitHubMutationResult;
    };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadMutationAuthority(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly repository: string;
    readonly now: Date;
  },
): Promise<ClaimedDispatchAuthority> {
  try {
    const authority = await loadClaimedDispatchAuthority(client, {
      dispatchId: input.dispatchId,
      workerId: input.workerId,
      claimToken: input.claimToken,
      now: () => input.now,
    });
    selectClaimedWorkspaceSource(authority, { repository: input.repository });
    return authority;
  } catch (error) {
    if (error instanceof ClaimedDispatchAuthorityNotFoundError) {
      throw new SessionRuntimeGitHubMutationNotFoundError(
        "runtime dispatch was not found",
      );
    }
    if (error instanceof ClaimedDispatchAuthorityConflictError) {
      throw new SessionRuntimeGitHubMutationConflictError(error.message);
    }
    throw error;
  }
}

function permissionTarget(request: SessionRuntimeGitHubMutationRequest): {
  readonly pullRequestNumber: number | null;
  readonly targetId: string | null;
} {
  switch (request.operation) {
    case "branch_publish":
      return { pullRequestNumber: null, targetId: request.input.branchName };
    case "pull_request_create":
      return { pullRequestNumber: null, targetId: request.input.headBranch };
    case "pull_request_update_branch":
    case "pull_request_update":
      return { pullRequestNumber: request.input.pullRequestNumber, targetId: null };
    case "review_thread_reply":
      return {
        pullRequestNumber: request.input.pullRequestNumber,
        targetId: request.input.threadId,
      };
    case "check_rerun":
      return { pullRequestNumber: null, targetId: String(request.input.checkRunId) };
  }
}

function reconciliationAction(
  operation: GitHubMutationProviderRequest["operation"],
): string {
  switch (operation) {
    case "branch_publish":
      return "inspect_branch_commit";
    case "pull_request_create":
      return "search_pull_request_marker";
    case "pull_request_update":
      return "inspect_pull_request";
    case "review_thread_reply":
      return "search_review_thread_marker";
    case "pull_request_update_branch":
      return "compare_pull_request_head";
    case "check_rerun":
      return "inspect_check_attempts";
  }
}

function expectedPermissionOperation(request: SessionRuntimeGitHubMutationRequest) {
  return sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository: request.input.repository,
    operation: request.operation,
    ...permissionTarget(request),
    expectedHeadSha: request.input.expectedHeadSha,
    payloadJson: canonicalJsonText(request.input),
  });
}

export async function authorizeSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimeGitHubMutationAuthorization> {
  const request = sessionRuntimeGitHubMutationRequestSchema.parse(input.request);
  const dispatch = (await loadMutationAuthority(client, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: request.claimToken,
    repository: request.input.repository,
    now: (input.now ?? (() => new Date()))(),
  })).dispatch;
  const expectedOperationId = `githubmutation-${createHash("sha256")
    .update(canonicalJsonText({
      dispatchId: dispatch.dispatchId,
      operation: request.operation,
      input: request.input,
    }))
    .digest("hex")}`;
  if (request.operationId !== expectedOperationId) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation operation identity is invalid",
    );
  }
  const operation = expectedPermissionOperation(request);
  const operationDigest = digest(canonicalJsonText(operation));
  const expectedRequestId = `permission-${createHash("sha256")
    .update(canonicalJsonText(operation))
    .update("\0")
    .update(dispatch.dispatchId)
    .update("\0")
    .update(request.operationId)
    .digest("hex")}`;
  const result = await client.query<MutationAuthorizationRow>(
    `SELECT permission.request_json, decision.command_json,
            decision.result_json
       FROM codeops.session_runtime_outbox AS outbox
       LEFT JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = outbox.dispatch_id
        AND permission.request_id = $2
       LEFT JOIN LATERAL (
         SELECT command_json, result_json
           FROM codeops.session_commands
          WHERE session_id = permission.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = permission.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId, expectedRequestId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SessionRuntimeGitHubMutationNotFoundError(
      "runtime dispatch was not found",
    );
  }

  if (row.request_json === null || row.command_json === null || row.result_json === null) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation requires one durable permission decision",
    );
  }
  const permission = sessionRuntimePermissionSubmissionSchema.parse(row.request_json);
  const command = sessionCommandSchema.parse(row.command_json);
  const commandResult = sessionCommandResultSchema.parse(row.result_json);
  if (
    permission.claimToken !== request.claimToken ||
    permission.acpSessionId !== "codeops-github" ||
    permission.toolCallId !== request.operationId ||
    permission.request.requestId !== expectedRequestId ||
    permission.request.operationDigest !== operationDigest ||
    canonicalJsonText(permission.request.operation) !== canonicalJsonText(operation) ||
    canonicalJsonText(permission.options) !== canonicalJsonText([
      { optionId: "allow-once", acpOptionId: "allow-once" },
      { optionId: "deny", acpOptionId: "deny" },
    ]) ||
    command.type !== "respond_permission" ||
    command.sessionId !== dispatch.command.sessionId ||
    command.permissionRequestId !== expectedRequestId ||
    command.decision.outcome !== "selected" ||
    command.decision.optionId !== "allow-once" ||
    commandResult.sessionId !== command.sessionId ||
    commandResult.generation !== command.generation ||
    commandResult.leaseId !== command.leaseId ||
    commandResult.idempotencyKey !== command.idempotencyKey ||
    commandResult.type !== command.type ||
    commandResult.disposition !== "committed"
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "durable permission does not authorize this exact GitHub mutation",
    );
  }

  if (request.operation === "branch_publish" && request.input.mode === "fast_forward") {
    const prior = await client.query<Record<string, unknown>>(
      `SELECT effect.effect_id, effect.repository, effect.target_id,
              effect.expected_head_sha, effect.state, effect.attempted_at,
              effect.resolved_at, effect.evidence_json
         FROM codeops.provider_effect_receipts AS effect
         JOIN codeops.sessions AS session
           ON session.session_id = effect.session_id
        WHERE effect.effect_id = $1
          AND effect.provider = 'github'
          AND effect.operation = 'branch_publish'
          AND effect.repository = $2
          AND effect.target_id = $3
          AND effect.state = 'succeeded'
          AND effect.attempted_at IS NOT NULL
          AND effect.resolved_at IS NOT NULL
          AND effect.evidence_json IS NOT NULL
          AND session.owner_principal_id = $4`,
      [
        request.input.expectedBranchHeadEffectId,
        request.input.repository,
        request.input.branchName,
        dispatch.principalId,
      ],
    );
    const effect = prior.rows.length === 1 ? prior.rows[0] : undefined;
    const evidence = githubMutationResultSchema.safeParse(effect?.evidence_json);
    if (
      effect === undefined ||
      !evidence.success ||
      effect.effect_id !== request.input.expectedBranchHeadEffectId ||
      effect.repository !== request.input.repository ||
      effect.target_id !== request.input.branchName ||
      effect.state !== "succeeded" ||
      effect.attempted_at === null ||
      effect.resolved_at === null ||
      evidence.data.version !== "codeops.github-branch-publish-result/v1" ||
      evidence.data.operationId !== effect.effect_id ||
      evidence.data.repository !== request.input.repository ||
      evidence.data.baseBranch !== request.input.baseBranch ||
      evidence.data.branchName !== request.input.branchName ||
      evidence.data.baseSha !== effect.expected_head_sha ||
      evidence.data.headSha !== request.input.expectedBranchHeadSha
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "fast-forward publication lacks matching durable branch evidence",
      );
    }
  }

  const payloadDigest = digest(canonicalJsonText(request.input));
  const providerRequest = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operation: request.operation,
    operationId: request.operationId,
    input: request.input,
    payloadDigest,
    permissionDigest: operationDigest,
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      principalDigest: digest(dispatch.principalId),
    },
  });
  const target = permissionTarget(request);
  const inserted = await client.query(
    `INSERT INTO codeops.provider_effect_receipts
       (effect_id, provider, repository, operation, pull_request_number,
        target_id, expected_head_sha, session_id, dispatch_id, payload_digest,
        permission_digest, state, reconciliation_action, authorized_at)
     VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10,
             'authorized', 'none', $11::timestamptz)
     ON CONFLICT DO NOTHING`,
    [
      request.operationId,
      request.input.repository,
      request.operation,
      target.pullRequestNumber,
      target.targetId,
      request.input.expectedHeadSha,
      dispatch.command.sessionId,
      dispatch.dispatchId,
      payloadDigest,
      operationDigest,
      (input.now ?? (() => new Date()))().toISOString(),
    ],
  );
  if (inserted.rowCount !== 1) {
    const stored = await client.query<StoredMutationRow>(
      `SELECT dispatch_id, payload_digest, permission_digest, state, evidence_json
         FROM codeops.provider_effect_receipts
        WHERE effect_id = $1`,
      [request.operationId],
    );
    const replay = stored.rows[0];
    if (
      replay === undefined ||
      replay.dispatch_id !== dispatch.dispatchId ||
      replay.payload_digest !== payloadDigest ||
      replay.permission_digest !== operationDigest
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation operation conflicts with its immutable stored identity",
      );
    }
    if (replay.state === "authorized" && replay.evidence_json === null) {
      return { disposition: "authorized", request: providerRequest };
    }
    if (replay.state === "attempting") {
      await client.query(
        `UPDATE codeops.provider_effect_receipts
            SET state = 'unknown',
                reconciliation_action = $2,
                updated_at = $3::timestamptz
          WHERE effect_id = $1 AND state = 'attempting'`,
        [
          request.operationId,
          reconciliationAction(providerRequest.operation),
          (input.now ?? (() => new Date()))().toISOString(),
        ],
      );
    }
    if (
      !["succeeded", "reconciled_satisfied"].includes(String(replay.state)) ||
      replay.evidence_json === null
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation outcome is not known and cannot be retried",
      );
    }
    const parsedReplay = githubMutationResultSchema.safeParse(replay.evidence_json);
    if (!parsedReplay.success) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "stored GitHub mutation result is invalid",
      );
    }
    const replayed = parsedReplay.data;
    if (
      replayed.operationId !== request.operationId ||
      replayed.repository !== request.input.repository
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "stored GitHub mutation result conflicts with its operation identity",
      );
    }
    return { disposition: "replayed", result: replayed };
  }
  return { disposition: "authorized", request: providerRequest };
}

export async function beginSessionRuntimeGitHubMutationAttempt(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly now?: () => Date;
  },
): Promise<void> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  const attemptedAt = (input.now ?? (() => new Date()))().toISOString();
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = 'attempting', attempted_at = $1::timestamptz,
            updated_at = $1::timestamptz
      WHERE effect_id = $2 AND dispatch_id = $3
        AND payload_digest = $4 AND permission_digest = $5
        AND state = 'authorized' AND attempted_at IS NULL`,
    [
      attemptedAt,
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation attempt does not match one authorized effect",
    );
  }
}

export async function recordSessionRuntimeGitHubMutationFailure(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly outcome: "failed" | "unknown";
    readonly now?: () => Date;
  },
): Promise<void> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const failed = input.outcome === "failed";
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = $1,
            resolution_summary = $2,
            reconciliation_action = $3,
            resolved_at = $4::timestamptz,
            updated_at = $4::timestamptz
      WHERE effect_id = $5 AND dispatch_id = $6
        AND payload_digest = $7 AND permission_digest = $8
        AND state = 'attempting' AND attempted_at IS NOT NULL`,
    [
      input.outcome,
      failed ? "Provider preflight proved that no remote effect occurred." : null,
      failed ? "none" : reconciliationAction(request.operation),
      failed ? observedAt : null,
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation failure does not match one attempting effect",
    );
  }
}

export async function executeAuthorizedSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly provider: (
      request: GitHubMutationProviderRequest,
    ) => Promise<GitHubMutationResult>;
    readonly now?: () => Date;
  },
): Promise<GitHubMutationResult> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  await beginSessionRuntimeGitHubMutationAttempt(client, {
    request,
    now: input.now,
  });
  try {
    const result = await input.provider(request);
    return await completeSessionRuntimeGitHubMutation(client, {
      request,
      result,
      now: input.now,
    });
  } catch (error) {
    await recordSessionRuntimeGitHubMutationFailure(client, {
      request,
      outcome:
        error instanceof GitHubMutationProviderNoEffectError
          ? "failed"
          : "unknown",
      now: input.now,
    });
    throw error;
  }
}

export async function completeSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly result: unknown;
    readonly now?: () => Date;
  },
): Promise<GitHubMutationResult> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  const result = githubMutationResultSchema.parse(input.result);
  if (
    result.operationId !== request.operationId ||
    result.repository !== request.input.repository
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation result identity does not match its consumed permission",
    );
  }
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = 'succeeded', evidence_json = $1::jsonb,
            resolution_summary = 'Provider result and postcondition validated.',
            reconciliation_action = 'none', resolved_at = $2::timestamptz,
            updated_at = $2::timestamptz
      WHERE effect_id = $3 AND dispatch_id = $4
        AND payload_digest = $5 AND permission_digest = $6
        AND state = 'attempting' AND evidence_json IS NULL
        AND attempted_at IS NOT NULL`,
    [
      canonicalJsonText(result),
      (input.now ?? (() => new Date()))().toISOString(),
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation completion does not match one attempting effect",
    );
  }
  return result;
}

export function createGitHubMutationProviderClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): (request: GitHubMutationProviderRequest) => Promise<GitHubMutationResult> {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    !origin.hostname.endsWith("-control-gateway") ||
    origin.port !== "8080" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "GitHub mutation provider origin must be the internal control gateway",
    );
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub mutation provider token is invalid");
  }
  return async (rawRequest) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    const [owner, name] = request.input.repository.split("/");
    const response = await readProviderResponse({
      fetch: input.fetch ?? fetch,
      url: new URL(
        `/v1/repositories/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/github-mutations`,
        origin,
      ),
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(request),
      },
      maxBytes: MAX_GITHUB_MUTATION_PROVIDER_RESPONSE_BYTES,
      statuses: [200, 409],
      mediaTypes: ["json"],
      timeoutMs: input.timeoutMs ?? GITHUB_MUTATION_PROVIDER_TIMEOUT_MS,
    });
    if (response.status === 409) {
      throw new GitHubMutationProviderNoEffectError(
        "GitHub mutation provider proved that no remote effect occurred",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(decodeProviderResponseText(response.bytes));
    } catch (error) {
      throw new Error("GitHub mutation provider response is not valid JSON", {
        cause: error,
      });
    }
    return githubMutationResultSchema.parse(body);
  };
}

export function createGitHubMutationReconciliationProviderClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): (input: {
  readonly request: GitHubMutationProviderRequest;
  readonly attemptedAt: Date;
}) => Promise<GitHubMutationReconciliationResult> {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    !origin.hostname.endsWith("-control-gateway") ||
    origin.port !== "8080" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "GitHub mutation reconciliation origin must be the internal control gateway",
    );
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub mutation reconciliation token is invalid");
  }
  return async ({ request: rawRequest, attemptedAt }) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    const body = githubMutationReconciliationProviderRequestSchema.parse({
      version: "codeops.github-mutation-reconciliation-provider-request/v1",
      request,
      attemptedAt: attemptedAt.toISOString(),
    });
    const [owner, name] = request.input.repository.split("/");
    const response = await (input.fetch ?? fetch)(
      new URL(
        `/v1/repositories/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/github-mutations/reconcile`,
        origin,
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub mutation reconciliation provider returned HTTP ${response.status}`,
      );
    }
    return githubMutationReconciliationResultSchema.parse(await response.json());
  };
}
