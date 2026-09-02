import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubBranchPublishLegacyInlineInputSchema,
  githubMutationProviderRequestSchema,
  githubMutationReconciliationResultSchema,
  providerEffectReceiptSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimePermissionSubmissionSchema,
  sha256CanonicalJsonDigest,
  type GitHubMutationProviderRequest,
  type GitHubMutationReconciliationResult,
  type ProviderEffectReceipt,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import {
  cleanupDefinitiveGitHubBranchCandidateChunks,
  stageLegacyGitHubBranchCandidate,
} from "./github-branch-publish-candidates.js";

interface ProviderEffectRow extends Record<string, unknown> {
  readonly effect_id: unknown;
  readonly provider: unknown;
  readonly repository: unknown;
  readonly operation: unknown;
  readonly pull_request_number: unknown;
  readonly target_id: unknown;
  readonly expected_head_sha: unknown;
  readonly payload_digest: unknown;
  readonly permission_digest: unknown;
  readonly session_id: unknown;
  readonly dispatch_id: unknown;
  readonly state: unknown;
  readonly authorized_at: unknown;
  readonly attempted_at: unknown;
  readonly resolved_at: unknown;
  readonly reconciliation_action: unknown;
  readonly resolution_summary: unknown;
}

interface ReconciliationAuthorityRow extends Record<string, unknown> {
  readonly effect_id: unknown;
  readonly session_id: unknown;
  readonly dispatch_id: unknown;
  readonly payload_digest: unknown;
  readonly permission_digest: unknown;
  readonly operation: unknown;
  readonly attempted_at: unknown;
  readonly state: unknown;
  readonly permission_request_id: unknown;
  readonly admission_id: unknown;
  readonly session_generation: unknown;
  readonly session_lease_id: unknown;
  readonly authorization_expires_at: unknown;
  readonly request_json: unknown;
  readonly dispatch_json: unknown;
  readonly provider_effect_marker: unknown;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("provider effect timestamp is invalid");
}

function projectProviderEffect(row: ProviderEffectRow): ProviderEffectReceipt {
  return providerEffectReceiptSchema.parse({
    version: "codeops.provider-effect-receipt/v1",
    effectId: row.effect_id,
    provider: row.provider,
    repository: row.repository,
    operation: row.operation,
    pullRequestNumber: row.pull_request_number,
    targetId: row.target_id,
    expectedHeadSha: row.expected_head_sha,
    payloadDigest: row.payload_digest,
    permissionDigest: row.permission_digest,
    sessionId: row.session_id,
    dispatchId: row.dispatch_id,
    state: row.state,
    authorizedAt: timestamp(row.authorized_at),
    attemptedAt: timestamp(row.attempted_at),
    resolvedAt: timestamp(row.resolved_at),
    reconciliationAction: row.reconciliation_action,
    resolutionSummary: row.resolution_summary,
  });
}

export async function listProviderEffectReceipts(
  client: TransactionClient,
  limit = 100,
  ownerPrincipalId?: string,
): Promise<readonly ProviderEffectReceipt[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("provider effect receipt limit must be between 1 and 200");
  }
  if (
    ownerPrincipalId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(ownerPrincipalId)
  ) {
    throw new Error("provider effect owner principal is invalid");
  }
  const result = await client.query<ProviderEffectRow>(
    `SELECT effect.effect_id, effect.provider, effect.repository,
            effect.operation, effect.pull_request_number, effect.target_id,
            effect.expected_head_sha, effect.payload_digest,
            effect.permission_digest, effect.session_id, effect.dispatch_id,
            effect.state, effect.authorized_at, effect.attempted_at,
            effect.resolved_at, effect.reconciliation_action,
            effect.resolution_summary
       FROM codeops.provider_effect_receipts AS effect
       JOIN codeops.sessions AS session
         ON session.session_id = effect.session_id
      WHERE ($2::text IS NULL OR session.owner_principal_id = $2)
      ORDER BY CASE effect.state WHEN 'unknown' THEN 0 WHEN 'attempting' THEN 1 ELSE 2 END,
               effect.updated_at DESC, effect.effect_id ASC
      LIMIT $1`,
    [limit, ownerPrincipalId ?? null],
  );
  return result.rows.map(projectProviderEffect);
}

export async function loadUnknownProviderEffectReconciliation(
  client: TransactionClient,
  effectId: string,
  ownerPrincipalId: string,
): Promise<{
  readonly request: GitHubMutationProviderRequest;
  readonly attemptedAt: Date;
}> {
  if (!/^githubmutation-[0-9a-f]{64}$/.test(effectId)) {
    throw new Error("provider effect identity is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(ownerPrincipalId)) {
    throw new Error("provider effect owner principal is invalid");
  }
  await client.query(
    `UPDATE codeops.provider_effect_receipts AS effect
        SET state = 'unknown',
            reconciliation_action = CASE effect.operation
              WHEN 'branch_publish' THEN 'inspect_branch_commit'
              WHEN 'pull_request_create' THEN 'search_pull_request_marker'
              WHEN 'pull_request_update' THEN 'inspect_pull_request'
              WHEN 'review_thread_reply' THEN 'search_review_thread_marker'
              WHEN 'pull_request_update_branch' THEN 'compare_pull_request_head'
              WHEN 'check_rerun' THEN 'inspect_check_attempts'
            END,
            updated_at = now()
       FROM codeops.sessions AS session
      WHERE effect.effect_id = $1
        AND effect.state = 'attempting'
        AND effect.attempted_at <= now() - interval '5 minutes'
        AND session.session_id = effect.session_id
        AND session.owner_principal_id = $2`,
    [effectId, ownerPrincipalId],
  );
  const result = await client.query<ReconciliationAuthorityRow>(
    `SELECT effect.effect_id, effect.session_id, effect.dispatch_id,
            effect.payload_digest, effect.permission_digest, effect.operation,
            effect.attempted_at, effect.state, effect.permission_request_id,
            effect.admission_id, effect.session_generation,
            effect.session_lease_id, effect.authorization_expires_at,
            effect.provider_effect_marker,
            permission.request_json,
            outbox.dispatch_json
       FROM codeops.provider_effect_receipts AS effect
       JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = effect.dispatch_id
        AND permission.request_id = effect.permission_request_id
        AND permission.session_id = effect.session_id
        AND permission.admission_id = effect.admission_id
        AND permission.session_generation = effect.session_generation
        AND permission.session_lease_id = effect.session_lease_id
        AND permission.operation_provider = effect.provider
        AND permission.operation_id = effect.effect_id
       JOIN codeops.session_runtime_outbox AS outbox
         ON outbox.dispatch_id = effect.dispatch_id
       JOIN codeops.sessions AS session
         ON session.session_id = effect.session_id
        AND session.owner_principal_id = $2
      WHERE effect.effect_id = $1`,
    [effectId, ownerPrincipalId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("provider effect was not found");
  if (result.rows.length !== 1) throw new Error("provider effect authority is ambiguous");
  if (row.state !== "unknown" || row.attempted_at === null) {
    throw new Error("provider effect is not eligible for reconciliation");
  }
  const permission = sessionRuntimePermissionSubmissionSchema.parse(row.request_json);
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (
    permission.toolCallId !== effectId ||
    (typeof row.provider_effect_marker === "string" &&
      row.provider_effect_marker !== `codeops-provider-effect:${effectId}`) ||
    permission.request.operation.kind !== "github_mutation" ||
    dispatch.dispatchId !== row.dispatch_id ||
    dispatch.command.sessionId !== row.session_id
  ) {
    throw new Error("provider effect reconciliation authority is inconsistent");
  }
  const durableInput = JSON.parse(permission.request.operation.payloadJson) as unknown;
  if (
    row.payload_digest !== sha256CanonicalJsonDigest(durableInput) ||
    row.permission_digest !== sha256CanonicalJsonDigest(permission.request.operation) ||
    permission.request.operationDigest !== row.permission_digest
  ) {
    throw new Error("provider effect reconciliation digests are inconsistent");
  }
  let providerInput = durableInput;
  if (row.operation === "branch_publish") {
    const legacy = githubBranchPublishLegacyInlineInputSchema.safeParse(durableInput);
    if (legacy.success) {
      const expectedEffectIds = [
        { dispatchId: row.dispatch_id, operation: "branch_publish", input: legacy.data },
        { dispatchId: row.dispatch_id, claimToken: permission.claimToken,
          operation: "branch_publish", input: legacy.data },
      ].map((identity) => `githubmutation-${createHash("sha256")
        .update(canonicalJsonText(identity)).digest("hex")}`);
      if (!expectedEffectIds.includes(effectId)) {
        throw new Error("provider effect reconciliation authority is inconsistent");
      }
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        const candidate = await stageLegacyGitHubBranchCandidate(client, {
          dispatchId: String(row.dispatch_id),
          sessionId: String(row.session_id),
          ownerPrincipalId: dispatch.principalId,
          repository: legacy.data.repository,
          operationId: effectId,
          logicalInput: legacy.data,
        });
        const { changes: _changes, ...metadata } = legacy.data;
        providerInput = { ...metadata, candidate };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
  const request = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operation: row.operation,
    operationId: row.effect_id,
    input: providerInput,
    payloadDigest: row.payload_digest,
    permissionDigest: row.permission_digest,
    provenance: {
      sessionId: row.session_id,
      dispatchId: row.dispatch_id,
      admissionId: row.admission_id,
      sessionGeneration: Number(row.session_generation),
      sessionLeaseId: row.session_lease_id,
      permissionRequestId: row.permission_request_id,
      authorizationExpiresAt: timestamp(row.authorization_expires_at),
      principalDigest: `sha256:${createHash("sha256").update(dispatch.principalId).digest("hex")}`,
    },
  });
  return { request, attemptedAt: new Date(String(row.attempted_at)) };
}

export async function recordProviderEffectReconciliation(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly reconciliation: GitHubMutationReconciliationResult;
    readonly principalId: string;
    readonly now?: () => Date;
  },
): Promise<void> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.principalId)) {
    throw new Error("provider effect reconciliation principal is invalid");
  }
  const reconciliation = githubMutationReconciliationResultSchema.parse(
    input.reconciliation,
  );
  if (reconciliation.state === "unknown") return;
  if (
    reconciliation.state === "reconciled_satisfied" &&
    (reconciliation.result.operationId !== request.operationId ||
      reconciliation.result.repository !== request.input.repository)
  ) {
    throw new Error("provider effect reconciliation result identity is invalid");
  }
  const resolvedAt = (input.now ?? (() => new Date()))().toISOString();
  const transactional = request.operation === "branch_publish";
  if (transactional) await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = $1, evidence_json = $2::jsonb,
            resolution_summary = $3, resolved_by = $4,
            reconciliation_action = 'none', resolved_at = $5::timestamptz,
            updated_at = $5::timestamptz
      WHERE effect_id = $6 AND state = 'unknown'
        AND dispatch_id = $7 AND payload_digest = $8
        AND permission_digest = $9 AND attempted_at IS NOT NULL
        AND session_id = $10 AND admission_id = $11
        AND session_generation = $12 AND session_lease_id = $13
        AND permission_request_id = $14
        AND authorization_expires_at = $15::timestamptz
        AND EXISTS (
          SELECT 1 FROM codeops.sessions AS session
           WHERE session.session_id = codeops.provider_effect_receipts.session_id
             AND session.owner_principal_id = $4
        )`,
    [
      reconciliation.state,
      reconciliation.result === null
        ? null
        : canonicalJsonText(reconciliation.result),
      reconciliation.summary,
      input.principalId,
      resolvedAt,
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
    throw new Error("provider effect reconciliation lost its unknown-state fence");
  }
  if (request.operation === "branch_publish") {
    await cleanupDefinitiveGitHubBranchCandidateChunks(client, request.operationId);
  }
  if (transactional) await client.query("COMMIT");
  } catch (error) {
    if (transactional) await client.query("ROLLBACK");
    throw error;
  }
}

export async function operatorResolveProviderEffect(
  client: TransactionClient,
  input: {
    readonly effectId: string;
    readonly principalId: string;
    readonly resolution: "satisfied" | "not_observed" | "accepted_unknown";
    readonly summary: string;
    readonly evidenceReferences: readonly string[];
    readonly now?: () => Date;
  },
): Promise<void> {
  if (!/^githubmutation-[0-9a-f]{64}$/.test(input.effectId)) {
    throw new Error("provider effect identity is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.principalId)) {
    throw new Error("provider effect resolution principal is invalid");
  }
  if (input.summary.length < 1 || input.summary.length > 1_000) {
    throw new Error("provider effect resolution summary is invalid");
  }
  if (
    input.evidenceReferences.length > 10 ||
    input.evidenceReferences.some((value) => value.length < 1 || value.length > 500)
  ) {
    throw new Error("provider effect resolution evidence is invalid");
  }
  const resolvedAt = (input.now ?? (() => new Date()))().toISOString();
  const evidence = canonicalJsonText({
    resolution: input.resolution,
    evidenceReferences: input.evidenceReferences,
  });
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = 'operator_resolved', evidence_json = $1::jsonb,
            resolution_summary = $2, resolved_by = $3,
            reconciliation_action = 'none', resolved_at = $4::timestamptz,
            updated_at = $4::timestamptz
      WHERE effect_id = $5 AND state = 'unknown'
        AND attempted_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM codeops.sessions AS session
           WHERE session.session_id = codeops.provider_effect_receipts.session_id
             AND session.owner_principal_id = $3
        )`,
    [evidence, input.summary, input.principalId, resolvedAt, input.effectId],
  );
  if (updated.rowCount !== 1) {
    throw new Error("provider effect operator resolution lost its unknown-state fence");
  }
}
