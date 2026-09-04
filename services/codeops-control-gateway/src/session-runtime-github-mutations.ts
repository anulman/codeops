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
  sessionSnapshotSchema,
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
  validateClaimedDispatchAuthority,
  type ClaimedDispatchAuthority,
} from "./claimed-dispatch-authority.js";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "./provider-response.js";
import {
  loadGitHubBranchCandidate,
  lockGitHubBranchCandidateManifest,
  cleanupDefinitiveGitHubBranchCandidateChunks,
  stageLegacyGitHubBranchCandidate,
} from "./github-branch-publish-candidates.js";

export class SessionRuntimeGitHubMutationNotFoundError extends Error {}
export class SessionRuntimeGitHubMutationConflictError extends Error {}

interface MutationAuthorizationRow extends Record<string, unknown> {
  readonly command_id: unknown;
  readonly principal_id: unknown;
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
  readonly admission_id: unknown;
  readonly session_generation: unknown;
  readonly session_lease_id: unknown;
  readonly operation_provider: unknown;
  readonly operation_id: unknown;
}

interface StoredMutationRow extends Record<string, unknown> {
  readonly dispatch_id: unknown;
  readonly payload_digest: unknown;
  readonly permission_digest: unknown;
  readonly state: unknown;
  readonly attempted_at: unknown;
  readonly evidence_json: unknown;
  readonly provider_effect_marker: unknown;
}

interface LockedMutationDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly owner_principal_id: unknown;
  readonly admission_id: unknown;
}

function assertStoredMutationIdentity(
  stored: StoredMutationRow,
  input: {
    readonly operationId: string;
    readonly dispatchId: string;
    readonly payloadDigest: string;
    readonly permissionDigest: string;
  },
): void {
  if (
    stored.dispatch_id !== input.dispatchId ||
    stored.payload_digest !== input.payloadDigest ||
    stored.permission_digest !== input.permissionDigest ||
    (typeof stored.provider_effect_marker === "string" &&
      stored.provider_effect_marker !== `codeops-provider-effect:${input.operationId}`)
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation operation conflicts with its immutable stored identity",
    );
  }
}

function replayStoredMutation(
  stored: StoredMutationRow,
  request: SessionRuntimeGitHubMutationRequest,
): GitHubMutationResult {
  const parsed = githubMutationResultSchema.safeParse(stored.evidence_json);
  if (!parsed.success) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "stored GitHub mutation result is invalid",
    );
  }
  if (
    parsed.data.operationId !== request.operationId ||
    parsed.data.repository !== request.input.repository
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "stored GitHub mutation result conflicts with its operation identity",
    );
  }
  return parsed.data;
}

function recoverStoredMutation(
  stored: StoredMutationRow,
  request: SessionRuntimeGitHubMutationRequest,
): "authorized" | {
  readonly disposition: "replayed";
  readonly result: GitHubMutationResult;
} {
  if (
    stored.state === "authorized" &&
    stored.attempted_at === null &&
    stored.evidence_json === null
  ) {
    return "authorized";
  }
  if (
    ["succeeded", "reconciled_satisfied"].includes(String(stored.state)) &&
    stored.attempted_at !== null &&
    stored.evidence_json !== null
  ) {
    return { disposition: "replayed", result: replayStoredMutation(stored, request) };
  }
  if (["not_attempted", "failed", "reconciled_not_observed", "operator_resolved"].includes(
    String(stored.state),
  )) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation has a definitive non-success outcome and cannot be retried",
    );
  }
  throw new SessionRuntimeGitHubMutationConflictError(
    "GitHub mutation outcome is not known and cannot be retried",
  );
}

export class GitHubMutationProviderNoEffectError extends Error {}

export const GITHUB_MUTATION_PROVIDER_TIMEOUT_MS = 240_000;
export const GITHUB_MUTATION_PROVIDER_CLIENT_TIMEOUT_MS = 1_200_000;
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
    readonly pullRequestNumber: number | null;
    readonly expectedHeadSha: string;
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
    const identity = authority.snapshot.identity;
    if (
      "version" in identity &&
      identity.version === "codeops.temporal-session-identity/v2"
    ) {
      if (
        identity.repository !== input.repository ||
        (input.pullRequestNumber !== null &&
          identity.pullRequestNumber !== input.pullRequestNumber) ||
        identity.pullRequestHeadSha !== input.expectedHeadSha
      ) {
        throw new ClaimedDispatchAuthorityConflictError(
          "provider authority does not bind the exact Temporal repository, pull request, and head",
        );
      }
    } else {
      selectClaimedWorkspaceSource(authority, { repository: input.repository });
    }
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

async function authorizeSessionRuntimeGitHubMutationTransaction(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimeGitHubMutationAuthorization> {
  const request = sessionRuntimeGitHubMutationRequestSchema.parse(input.request);
  const nowDate = (input.now ?? (() => new Date()))();
  const target = permissionTarget(request);
  const authority = await loadMutationAuthority(client, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: request.claimToken,
    repository: request.input.repository,
    pullRequestNumber: target.pullRequestNumber,
    expectedHeadSha: request.input.expectedHeadSha,
    now: nowDate,
  });
  const dispatch = authority.dispatch;
  const sessionRows = await client.query<Record<string, unknown>>(
    `SELECT snapshot_json
       FROM codeops.sessions
      WHERE session_id = $1
      FOR UPDATE`,
    [dispatch.command.sessionId],
  );
  if (sessionRows.rows[0] === undefined) {
    throw new SessionRuntimeGitHubMutationNotFoundError("session was not found");
  }
  const current = sessionSnapshotSchema.parse(sessionRows.rows[0].snapshot_json);
  const currentLease = current.lease;
  if (
    current.generation !== dispatch.command.generation ||
    current.state !== "running" ||
    currentLease?.status !== "active" ||
    currentLease.leaseId !== dispatch.command.leaseId ||
    canonicalJsonText(current.identity) !== canonicalJsonText(dispatch.snapshot.identity)
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation Session authority is cancelled, terminal, or drifted",
    );
  }
  const lockedDispatch = await client.query<LockedMutationDispatchRow>(
    `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            session.owner_principal_id, outbox.admission_id
       FROM codeops.session_runtime_outbox AS outbox
       JOIN codeops.sessions AS session ON session.session_id = outbox.session_id
      WHERE outbox.dispatch_id = $1
      FOR UPDATE OF outbox`,
    [input.dispatchId],
  );
  const lockedRow = lockedDispatch.rows[0];
  if (lockedRow === undefined) {
    throw new SessionRuntimeGitHubMutationNotFoundError("runtime dispatch was not found");
  }
  let lockedAuthority: ClaimedDispatchAuthority;
  try {
    lockedAuthority = validateClaimedDispatchAuthority(lockedRow, {
      dispatchId: input.dispatchId, workerId: input.workerId,
      claimToken: request.claimToken, now: nowDate,
    });
  } catch (error) {
    if (error instanceof ClaimedDispatchAuthorityConflictError) {
      throw new SessionRuntimeGitHubMutationConflictError(error.message);
    }
    throw error;
  }
  if (canonicalJsonText(lockedAuthority.dispatch) !== canonicalJsonText(dispatch)) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation dispatch authority drifted while locking",
    );
  }
  if (typeof lockedRow.admission_id !== "string") {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation requires one admitted work item",
    );
  }
  const admissionId = lockedRow.admission_id;
  const admission = await client.query(
    `SELECT admission_id
       FROM codeops.work_item_admissions
      WHERE admission_id = $1 AND child_dispatch_id = $2
        AND child_session_id = $3 AND repository = $4
      FOR UPDATE`,
    [admissionId, dispatch.dispatchId, dispatch.command.sessionId,
      request.input.repository],
  );
  if (admission.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation drifted from its admitted work item",
    );
  }
  const authorizationExpiresAtMs = Math.min(
    Date.parse(lockedAuthority.claimExpiresAt),
    Date.parse(currentLease.expiresAt),
  );
  if (!Number.isFinite(authorizationExpiresAtMs) || authorizationExpiresAtMs <= nowDate.getTime()) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation authorization expired before consumption",
    );
  }
  const authorizationExpiresAt = new Date(authorizationExpiresAtMs).toISOString();
  const legacyInline = request.operation === "branch_publish" &&
    "changes" in request.input;
  const expectedOperationId = request.operation === "branch_publish" && !legacyInline
    ? request.operationId
    : `githubmutation-${createHash("sha256")
      .update(canonicalJsonText({
        dispatchId: dispatch.dispatchId,
        claimToken: request.claimToken,
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
    `SELECT permission.request_json, permission.admission_id,
            permission.session_generation, permission.session_lease_id,
            permission.operation_provider, permission.operation_id,
            decision.command_id, decision.principal_id,
            decision.command_json, decision.result_json
       FROM codeops.session_runtime_permission_requests AS permission
       LEFT JOIN codeops.session_commands AS decision
         ON decision.session_id = permission.session_id
        AND decision.command_json->>'type' = 'respond_permission'
        AND decision.command_json->>'permissionRequestId' = permission.request_id
      WHERE permission.dispatch_id = $1 AND permission.request_id = $2
      ORDER BY decision.committed_at ASC NULLS LAST,
               decision.command_id ASC NULLS LAST
      FOR UPDATE OF permission`,
    [input.dispatchId, expectedRequestId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || row.request_json === null ||
      row.command_json === null || row.result_json === null) {
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
    row.admission_id !== admissionId ||
    Number(row.session_generation) !== dispatch.command.generation ||
    row.session_lease_id !== dispatch.command.leaseId ||
    row.operation_provider !== "github" ||
    row.operation_id !== request.operationId ||
    command.type !== "respond_permission" ||
    command.sessionId !== dispatch.command.sessionId ||
    command.generation !== dispatch.command.generation ||
    command.leaseId !== dispatch.command.leaseId ||
    command.permissionRequestId !== expectedRequestId ||
    command.decision.outcome !== "selected" ||
    command.decision.optionId !== "allow-once" ||
    commandResult.sessionId !== command.sessionId ||
    commandResult.commandId !== row.command_id ||
    commandResult.generation !== command.generation ||
    commandResult.leaseId !== command.leaseId ||
    commandResult.idempotencyKey !== command.idempotencyKey ||
    commandResult.type !== command.type ||
    commandResult.disposition !== "committed" ||
    row.principal_id !== dispatch.principalId ||
    commandResult.snapshot.sessionId !== current.sessionId ||
    commandResult.snapshot.generation !== current.generation ||
    commandResult.snapshot.state !== "running" ||
    commandResult.snapshot.pendingPermission !== null ||
    commandResult.snapshot.eventCursor !== current.eventCursor ||
    commandResult.snapshot.lease?.leaseId !== currentLease.leaseId ||
    canonicalJsonText(commandResult.snapshot.identity) !==
      canonicalJsonText(current.identity) ||
    Date.parse(commandResult.committedAt) > nowDate.getTime()
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "durable permission does not authorize this exact GitHub mutation",
    );
  }

  const payloadDigest = digest(canonicalJsonText(request.input));
  let existingAuthorization: StoredMutationRow | undefined;
  {
    const existing = await client.query<StoredMutationRow>(
      `SELECT dispatch_id, payload_digest, permission_digest, state,
              attempted_at, evidence_json, provider_effect_marker
         FROM codeops.provider_effect_receipts
        WHERE effect_id = $1
        FOR UPDATE`,
      [request.operationId],
    );
    const existingReceipt = existing.rows[0];
    if (existingReceipt !== undefined) {
      assertStoredMutationIdentity(existingReceipt, {
        operationId: request.operationId,
        dispatchId: dispatch.dispatchId,
        payloadDigest,
        permissionDigest: operationDigest,
      });
      const recovery = recoverStoredMutation(existingReceipt, request);
      if (recovery !== "authorized") return recovery;
      existingAuthorization = existingReceipt;
    }
  }

  let providerInput = request.input;
  if (request.operation === "branch_publish") {
    const inlineInput = "changes" in request.input ? request.input : undefined;
    const referenceInput = "candidate" in request.input ? request.input : undefined;
    const candidateReference = inlineInput !== undefined
      ? await stageLegacyGitHubBranchCandidate(client, {
          dispatchId: dispatch.dispatchId,
          sessionId: dispatch.command.sessionId,
          ownerPrincipalId: dispatch.principalId,
          repository: request.input.repository,
          operationId: request.operationId,
          logicalInput: inlineInput,
        })
      : referenceInput!.candidate;
    if (inlineInput !== undefined) {
      const { changes: _changes, ...metadata } = inlineInput;
      providerInput = { ...metadata, candidate: candidateReference };
    }
    const manifest = inlineInput !== undefined
      ? { effectDigest: digest(canonicalJsonText(inlineInput)) }
      : await lockGitHubBranchCandidateManifest(client, {
          manifestId: candidateReference.manifestId,
          dispatchId: dispatch.dispatchId,
          operationId: request.operationId,
          repository: request.input.repository,
          sessionId: dispatch.command.sessionId,
          ownerPrincipalId: dispatch.principalId,
          digest: candidateReference.digest,
          sizeBytes: candidateReference.sizeBytes,
          chunkCount: candidateReference.chunkCount,
        });
    const candidate = await loadGitHubBranchCandidate(client, {
      manifestId: candidateReference.manifestId,
      dispatchId: dispatch.dispatchId,
      operationId: request.operationId,
      effectDigest: manifest.effectDigest,
    });
    const logicalInput = inlineInput !== undefined
      ? inlineInput
      : (() => {
          const { candidate: _candidate, ...metadata } = referenceInput!;
          return { ...metadata, changes: candidate.changes };
        })();
    if (digest(canonicalJsonText(logicalInput)) !== manifest.effectDigest ||
        request.operationId !== `githubmutation-${createHash("sha256")
          .update(canonicalJsonText({
            dispatchId: dispatch.dispatchId, claimToken: request.claimToken,
            operation: request.operation,
            input: logicalInput,
          })).digest("hex")}`) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub branch candidate effect identity is invalid",
      );
    }
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

  const providerRequest = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operation: request.operation,
    operationId: request.operationId,
    input: providerInput,
    payloadDigest,
    permissionDigest: operationDigest,
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      admissionId,
      sessionGeneration: dispatch.command.generation,
      sessionLeaseId: dispatch.command.leaseId,
      permissionRequestId: expectedRequestId,
      authorizationExpiresAt,
      principalDigest: digest(dispatch.principalId),
    },
  });
  if (existingAuthorization !== undefined) {
    return { disposition: "authorized", request: providerRequest };
  }
  const inserted = await client.query(
    `INSERT INTO codeops.provider_effect_receipts
       (effect_id, provider, repository, operation, pull_request_number,
        target_id, expected_head_sha, session_id, dispatch_id, payload_digest,
        permission_digest, state, reconciliation_action, authorized_at,
        permission_request_id, admission_id, session_generation,
        session_lease_id, authorization_expires_at, dispatch_claim_token)
     VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10,
             'authorized', 'none', $11::timestamptz, $12, $13, $14, $15,
             $16::timestamptz, $17)
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
      nowDate.toISOString(),
      expectedRequestId,
      admissionId,
      dispatch.command.generation,
      dispatch.command.leaseId,
      authorizationExpiresAt,
      request.claimToken,
    ],
  );
  if (inserted.rowCount !== 1) {
    const stored = await client.query<StoredMutationRow>(
      `SELECT dispatch_id, payload_digest, permission_digest, state,
              attempted_at, evidence_json, provider_effect_marker
         FROM codeops.provider_effect_receipts
        WHERE effect_id = $1
        FOR UPDATE`,
      [request.operationId],
    );
    const replay = stored.rows[0];
    if (replay === undefined) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation operation conflicts with its immutable stored identity",
      );
    }
    assertStoredMutationIdentity(replay, {
      operationId: request.operationId,
      dispatchId: dispatch.dispatchId,
      payloadDigest,
      permissionDigest: operationDigest,
    });
    const recovery = recoverStoredMutation(replay, request);
    if (recovery === "authorized") {
      return { disposition: "authorized", request: providerRequest };
    }
    return recovery;
  }
  return { disposition: "authorized", request: providerRequest };
}

export async function authorizeSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeGitHubMutationTransaction>[1],
): Promise<SessionRuntimeGitHubMutationAuthorization> {
  const request = sessionRuntimeGitHubMutationRequestSchema.parse(input.request);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await authorizeSessionRuntimeGitHubMutationTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
  let authorityLost = false;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
  const session = await client.query(
    `SELECT snapshot_json FROM codeops.sessions
      WHERE session_id = $1 FOR UPDATE`,
    [request.provenance.sessionId],
  );
  const snapshot = session.rows[0] === undefined
    ? null
    : sessionSnapshotSchema.parse(session.rows[0].snapshot_json);
  const liveSession = snapshot !== null && snapshot.state === "running" &&
    snapshot.generation === request.provenance.sessionGeneration &&
    snapshot.lease?.status === "active" &&
    snapshot.lease.leaseId === request.provenance.sessionLeaseId;
  const terminalize = () => client.query(
    `UPDATE codeops.provider_effect_receipts AS effect
        SET state = 'not_attempted',
            resolution_summary =
              'Dispatch claim authority ended before any provider attempt.',
            reconciliation_action = 'none', resolved_at = $1::timestamptz,
            updated_at = $1::timestamptz
      WHERE effect.effect_id = $2 AND effect.dispatch_id = $3
        AND effect.payload_digest = $4 AND effect.permission_digest = $5
        AND effect.session_id = $6 AND effect.admission_id = $7
        AND effect.session_generation = $8 AND effect.session_lease_id = $9
        AND effect.permission_request_id = $10
        AND effect.authorization_expires_at = $11::timestamptz
        AND effect.state = 'authorized' AND effect.attempted_at IS NULL
        AND (effect.authorization_expires_at <= $1::timestamptz OR NOT EXISTS (
          SELECT 1
            FROM codeops.sessions AS session
           WHERE session.session_id = effect.session_id
             AND session.snapshot_json->>'state' = 'running'
             AND (session.snapshot_json->>'generation')::bigint =
                 effect.session_generation
             AND session.snapshot_json#>>'{lease,status}' = 'active'
             AND session.snapshot_json#>>'{lease,leaseId}' = effect.session_lease_id::text
        ) OR NOT EXISTS (
          SELECT 1
            FROM codeops.session_runtime_outbox AS outbox
           WHERE outbox.dispatch_id = effect.dispatch_id
             AND outbox.status = 'claimed'
             AND outbox.claim_token = effect.dispatch_claim_token
             AND outbox.claim_expires_at > $1::timestamptz
        ))`,
    [attemptedAt, request.operationId, request.provenance.dispatchId,
      request.payloadDigest, request.permissionDigest,
      request.provenance.sessionId, request.provenance.admissionId,
      request.provenance.sessionGeneration, request.provenance.sessionLeaseId,
      request.provenance.permissionRequestId,
      request.provenance.authorizationExpiresAt],
  );
  if (!liveSession) {
    authorityLost = (await terminalize()).rowCount === 1;
  } else {
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = 'attempting', attempted_at = $1::timestamptz,
            updated_at = $1::timestamptz
      WHERE effect_id = $2 AND dispatch_id = $3
        AND payload_digest = $4 AND permission_digest = $5
        AND session_id = $6 AND admission_id = $7
        AND session_generation = $8 AND session_lease_id = $9
        AND permission_request_id = $10
        AND authorization_expires_at = $11::timestamptz
        AND authorization_expires_at > $1::timestamptz
        AND state = 'authorized' AND attempted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM codeops.session_runtime_outbox AS outbox
           WHERE outbox.dispatch_id = $3 AND outbox.status = 'claimed'
             AND outbox.claim_token =
                 codeops.provider_effect_receipts.dispatch_claim_token
             AND outbox.claim_expires_at > $1::timestamptz
        )
        AND EXISTS (
          SELECT 1 FROM codeops.work_item_admissions AS admission
           WHERE admission.admission_id = $7
             AND admission.child_dispatch_id = $3
             AND admission.child_session_id = $6
             AND admission.repository = $12
        )`,
    [
      attemptedAt,
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
      request.provenance.sessionId,
      request.provenance.admissionId,
      request.provenance.sessionGeneration,
      request.provenance.sessionLeaseId,
      request.provenance.permissionRequestId,
      request.provenance.authorizationExpiresAt,
      request.input.repository,
    ],
  );
  if (updated.rowCount !== 1) {
    authorityLost = (await terminalize()).rowCount === 1;
    if (!authorityLost) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation attempt does not match one authorized effect",
      );
    }
  }
  }
  await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  if (authorityLost) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation attempt lost its active dispatch authority before any provider call",
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
  const transactional = request.operation === "branch_publish";
  if (transactional) await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = $1,
            failure_code = CASE WHEN $1 = 'failed' THEN 'provider_no_effect' ELSE NULL END,
            resolution_summary = $2,
            reconciliation_action = $3,
            resolved_at = $4::timestamptz,
            updated_at = $4::timestamptz
      WHERE effect_id = $5 AND dispatch_id = $6
        AND payload_digest = $7 AND permission_digest = $8
        AND session_id = $9 AND admission_id = $10
        AND session_generation = $11 AND session_lease_id = $12
        AND permission_request_id = $13
        AND authorization_expires_at = $14::timestamptz
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
      request.provenance.sessionId,
      request.provenance.admissionId,
      request.provenance.sessionGeneration,
      request.provenance.sessionLeaseId,
      request.provenance.permissionRequestId,
      request.provenance.authorizationExpiresAt,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation failure does not match one attempting effect",
    );
  }
  if (failed && request.operation === "branch_publish") {
    await cleanupDefinitiveGitHubBranchCandidateChunks(client, request.operationId);
  }
  if (transactional) await client.query("COMMIT");
  } catch (error) {
    if (transactional) await client.query("ROLLBACK");
    throw error;
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
  const transactional = request.operation === "branch_publish";
  if (transactional) await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = 'succeeded', evidence_json = $1::jsonb,
            resolution_summary = 'Provider result and postcondition validated.',
            reconciliation_action = 'none', resolved_at = $2::timestamptz,
            updated_at = $2::timestamptz
      WHERE effect_id = $3 AND dispatch_id = $4
        AND payload_digest = $5 AND permission_digest = $6
        AND session_id = $7 AND admission_id = $8
        AND session_generation = $9 AND session_lease_id = $10
        AND permission_request_id = $11
        AND authorization_expires_at = $12::timestamptz
        AND state = 'attempting' AND evidence_json IS NULL
        AND attempted_at IS NOT NULL`,
    [
      canonicalJsonText(result),
      (input.now ?? (() => new Date()))().toISOString(),
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
      request.provenance.sessionId,
      request.provenance.admissionId,
      request.provenance.sessionGeneration,
      request.provenance.sessionLeaseId,
      request.provenance.permissionRequestId,
      request.provenance.authorizationExpiresAt,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation completion does not match one attempting effect",
    );
  }
  if (request.operation === "branch_publish") {
    await cleanupDefinitiveGitHubBranchCandidateChunks(client, request.operationId);
  }
  if (transactional) await client.query("COMMIT");
  return result;
  } catch (error) {
    if (transactional) await client.query("ROLLBACK");
    throw error;
  }
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
      timeoutMs: input.timeoutMs ?? GITHUB_MUTATION_PROVIDER_CLIENT_TIMEOUT_MS,
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
