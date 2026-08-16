import { createHash } from "node:crypto";
import {
  canonicalJsonText,
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
  readonly request_json: unknown;
  readonly dispatch_json: unknown;
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
): Promise<readonly ProviderEffectReceipt[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("provider effect receipt limit must be between 1 and 200");
  }
  const result = await client.query<ProviderEffectRow>(
    `SELECT effect_id, provider, repository, operation, pull_request_number,
            target_id, expected_head_sha, payload_digest, permission_digest,
            session_id, dispatch_id, state, authorized_at, attempted_at,
            resolved_at, reconciliation_action, resolution_summary
       FROM codeops.provider_effect_receipts
      ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'attempting' THEN 1 ELSE 2 END,
               updated_at DESC, effect_id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(projectProviderEffect);
}

export async function loadUnknownProviderEffectReconciliation(
  client: TransactionClient,
  effectId: string,
): Promise<{
  readonly request: GitHubMutationProviderRequest;
  readonly attemptedAt: Date;
}> {
  if (!/^githubmutation-[0-9a-f]{64}$/.test(effectId)) {
    throw new Error("provider effect identity is invalid");
  }
  const result = await client.query<ReconciliationAuthorityRow>(
    `SELECT effect.effect_id, effect.session_id, effect.dispatch_id,
            effect.payload_digest, effect.permission_digest, effect.operation,
            effect.attempted_at, effect.state, permission.request_json,
            outbox.dispatch_json
       FROM codeops.provider_effect_receipts AS effect
       JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = effect.dispatch_id
        AND permission.request_json->>'toolCallId' = effect.effect_id
       JOIN codeops.session_runtime_outbox AS outbox
         ON outbox.dispatch_id = effect.dispatch_id
      WHERE effect.effect_id = $1`,
    [effectId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("provider effect was not found");
  if (row.state !== "unknown" || row.attempted_at === null) {
    throw new Error("provider effect is not eligible for reconciliation");
  }
  const permission = sessionRuntimePermissionSubmissionSchema.parse(row.request_json);
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (
    permission.toolCallId !== effectId ||
    permission.request.operation.kind !== "github_mutation" ||
    dispatch.dispatchId !== row.dispatch_id ||
    dispatch.command.sessionId !== row.session_id
  ) {
    throw new Error("provider effect reconciliation authority is inconsistent");
  }
  const input = JSON.parse(permission.request.operation.payloadJson) as unknown;
  const request = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operation: row.operation,
    operationId: row.effect_id,
    input,
    payloadDigest: row.payload_digest,
    permissionDigest: row.permission_digest,
    provenance: {
      sessionId: row.session_id,
      dispatchId: row.dispatch_id,
      principalDigest: `sha256:${createHash("sha256").update(dispatch.principalId).digest("hex")}`,
    },
  });
  if (
    request.payloadDigest !== sha256CanonicalJsonDigest(request.input) ||
    request.permissionDigest !== sha256CanonicalJsonDigest(permission.request.operation) ||
    permission.request.operationDigest !== request.permissionDigest
  ) {
    throw new Error("provider effect reconciliation digests are inconsistent");
  }
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
  const updated = await client.query(
    `UPDATE codeops.provider_effect_receipts
        SET state = $1, evidence_json = $2::jsonb,
            resolution_summary = $3, resolved_by = $4,
            reconciliation_action = 'none', resolved_at = $5::timestamptz,
            updated_at = $5::timestamptz
      WHERE effect_id = $6 AND state = 'unknown'
        AND dispatch_id = $7 AND payload_digest = $8
        AND permission_digest = $9 AND attempted_at IS NOT NULL`,
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
    ],
  );
  if (updated.rowCount !== 1) {
    throw new Error("provider effect reconciliation lost its unknown-state fence");
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
        AND attempted_at IS NOT NULL`,
    [evidence, input.summary, input.principalId, resolvedAt, input.effectId],
  );
  if (updated.rowCount !== 1) {
    throw new Error("provider effect operator resolution lost its unknown-state fence");
  }
}
