import { randomUUID } from "node:crypto";
import {
  canonicalJsonText,
  sha256CanonicalJsonDigest,
  sessionCommandResultSchema,
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeClaimRenewalRequestSchema,
  runtimeBindingSchema,
  runtimeLaunchBindingSchema,
  runtimeRequirementsSchema,
  type RuntimeLaunchBinding,
  type RuntimeProfile,
  type RuntimeRequirements,
  type SessionCommandResult,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import {
  executeSessionCommandTransaction,
  type TransactionClient,
} from "./session-broker-repository.js";
import {
  applySessionRuntimeCompletion,
  buildSessionRuntimeDispatch,
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchSchema,
  type SessionRuntimeDispatch,
} from "./session-broker-runtime.js";
import { resolveSessionRuntimeCompletionSnapshot } from "./session-runtime-permissions.js";
import { cleanupNoReceiptGitHubBranchCandidatesForDispatch } from "./github-branch-publish-candidates.js";
import { RuntimeCompatibilityError } from "./runtime-profile-registry.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class ImmutableSessionRuntimeDispatchConflictError extends Error {}
export class SessionRuntimeDispatchNotFoundError extends Error {}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
  readonly owner_principal_id: unknown;
}

interface StoredDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
}

interface ClaimedDispatchRow extends StoredDispatchRow {
  readonly claim_token: unknown;
  readonly claim_expires_at: unknown;
  readonly claim_count: unknown;
  readonly is_admitted_initial_dispatch: unknown;
  readonly runtime_binding_json: unknown;
  readonly runtime_claim_protocol: unknown;
}

interface RuntimeOwnerRow extends Record<string, unknown> {
  readonly root_session_id: unknown;
  readonly claimant_legacy_runtime_worker_compatible: unknown;
  readonly session_runtime_requirements_json: unknown;
  readonly session_runtime_requirement_digest: unknown;
  readonly session_runtime_launch_binding_json: unknown;
  readonly workspace_state: unknown;
  readonly workspace_runtime_requirements_json: unknown;
  readonly workspace_runtime_requirement_digest: unknown;
  readonly workspace_runtime_launch_binding_json: unknown;
}

interface RuntimeRootIdentityRow extends Record<string, unknown> {
  readonly root_session_id: unknown;
  readonly workspace_launch_id: unknown;
}

interface CompletedDispatchRow extends StoredDispatchRow {
  readonly status: unknown;
  readonly completion_json: unknown;
  readonly result_json: unknown;
  readonly completed_by: unknown;
}

function postgresTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("runtime claim persistence returned an invalid timestamp");
  }
  return parsed.toISOString();
}

function requireWorkerId(workerId: string): void {
  if (!workerPattern.test(workerId)) {
    throw new Error("runtime worker must be a bounded audit identity");
  }
}

export async function enqueueSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly command: unknown;
    readonly principalId: string;
    readonly ownerPrincipalId?: string;
    readonly now?: () => Date;
    readonly dispatchId?: () => string;
  },
): Promise<SessionRuntimeDispatch> {
  if (
    input.ownerPrincipalId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.ownerPrincipalId)
  ) {
    throw new Error("runtime dispatch owner principal is invalid");
  }
  const dispatchedAt = (input.now ?? (() => new Date()))().toISOString();
  const dispatchId = (input.dispatchId ?? randomUUID)();

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await client.query<StoredSessionRow>(
      `SELECT snapshot_json, owner_principal_id
         FROM codeops.sessions
        WHERE session_id = $1
          AND ($2::text IS NULL OR owner_principal_id = $2)
        FOR UPDATE`,
      [
        typeof input.command === "object" && input.command !== null
          ? (input.command as { readonly sessionId?: unknown }).sessionId
          : null,
        input.ownerPrincipalId ?? null,
      ],
    );
    if (!locked.rows[0]) {
      throw new Error("runtime dispatch session was not found");
    }
    const snapshot = locked.rows[0].snapshot_json as SessionSnapshot;
    const dispatch = buildSessionRuntimeDispatch({
      dispatchId,
      principalId: input.principalId,
      command: input.command,
      snapshot,
      dispatchedAt,
    });

    const committedCommand = await client.query(
      `SELECT command_json
         FROM codeops.session_commands
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [dispatch.command.sessionId, dispatch.command.idempotencyKey],
    );
    if (committedCommand.rows[0]) {
      throw new ImmutableSessionRuntimeDispatchConflictError(
        `runtime dispatch ${dispatch.command.idempotencyKey} conflicts with an already committed command for ${dispatch.command.sessionId}`,
      );
    }

    const existing = await client.query<StoredDispatchRow>(
      `SELECT dispatch_json
         FROM codeops.session_runtime_outbox
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [dispatch.command.sessionId, dispatch.command.idempotencyKey],
    );
    if (existing.rows[0]) {
      const stored = sessionRuntimeDispatchSchema.parse(
        existing.rows[0].dispatch_json,
      );
      if (
        stored.principalId !== dispatch.principalId ||
        canonicalJsonText(stored.command) !== canonicalJsonText(dispatch.command)
      ) {
        throw new ImmutableSessionRuntimeDispatchConflictError(
          `runtime dispatch ${dispatch.command.idempotencyKey} conflicts with the immutable dispatch for ${dispatch.command.sessionId}`,
        );
      }
      await client.query("COMMIT");
      return stored;
    }

    await client.query(
      `INSERT INTO codeops.session_runtime_outbox
         (dispatch_id, session_id, idempotency_key, principal_id,
          dispatch_json, dispatch_digest, status, available_at, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7::timestamptz, $7::timestamptz)`,
      [
        dispatch.dispatchId,
        dispatch.command.sessionId,
        dispatch.command.idempotencyKey,
        dispatch.principalId,
        canonicalJsonText(dispatch),
        sha256CanonicalJsonDigest(dispatch),
        dispatch.dispatchedAt,
      ],
    );
    await client.query("COMMIT");
    return dispatch;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export interface SessionRuntimeDispatchClaim {
  readonly dispatch: SessionRuntimeDispatch;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly claimCount: number;
  readonly isAdmittedInitialDispatch: boolean;
  readonly runtimeBinding?: ReturnType<typeof runtimeBindingSchema.parse>;
}

export async function claimSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly workerId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly identity: unknown;
    readonly runtimeProfileId?: string;
    readonly runtimeReleaseDigest?: string;
    readonly runtimeCapabilityDigest?: string;
    readonly runtimeProfile?: RuntimeProfile;
    readonly fallbackRuntimeOwner?: {
      readonly requirements: RuntimeRequirements;
      readonly launchBinding: RuntimeLaunchBinding;
    };
    readonly leaseMs: number;
    readonly now?: () => Date;
    readonly claimToken?: () => string;
  },
): Promise<SessionRuntimeDispatchClaim | null> {
  requireWorkerId(input.workerId);
  if (
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 15 * 60_000
  ) {
    throw new Error("runtime claim lease must be between 1 second and 15 minutes");
  }
  const authority = sessionRuntimeClaimRequestSchema.parse({
    version: input.runtimeProfileId === undefined
      ? "codeops.session-runtime-claim-request/v1"
      : "codeops.session-runtime-claim-request/v2",
    sessionId: input.sessionId,
    generation: input.generation,
    leaseId: input.leaseId,
    identity: input.identity,
    ...(input.runtimeProfileId === undefined ? {} : {
      runtimeProfileId: input.runtimeProfileId,
      runtimeReleaseDigest: input.runtimeReleaseDigest,
      runtimeCapabilityDigest: input.runtimeCapabilityDigest,
      runtimeProfile: input.runtimeProfile,
    }),
    leaseMs: input.leaseMs,
  });
  const now = (input.now ?? (() => new Date()))();
  const claimedAt = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const claimToken = (input.claimToken ?? randomUUID)();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
  const rootIdentityResult = await client.query<RuntimeRootIdentityRow>(
    `WITH RECURSIVE lineage(session_id, parent_session_id, path, depth) AS (
       SELECT session_id, snapshot_json->'identity'->>'parentSessionId',
              ARRAY[session_id], 0
         FROM codeops.sessions
        WHERE session_id = $1
       UNION ALL
       SELECT parent.session_id,
              parent.snapshot_json->'identity'->>'parentSessionId',
              child.path || parent.session_id, child.depth + 1
         FROM codeops.sessions parent
         JOIN lineage child ON parent.session_id = child.parent_session_id
        WHERE child.depth < 64
          AND NOT parent.session_id = ANY(child.path)
     )
     SELECT root.session_id AS root_session_id,
            root.snapshot_json#>>'{identity,runId}' AS workspace_launch_id
       FROM lineage resolved
       JOIN codeops.sessions root ON root.session_id = resolved.session_id
      WHERE resolved.parent_session_id IS NULL`,
    [authority.sessionId],
  );
  const rootIdentity = rootIdentityResult.rows[0];
  if (
    rootIdentityResult.rows.length !== 1 ||
    typeof rootIdentity?.root_session_id !== "string" ||
    typeof rootIdentity.workspace_launch_id !== "string"
  ) {
    throw new RuntimeCompatibilityError("legacy-runtime-unbound");
  }
  await client.query(
    `SELECT launch_id
       FROM codeops.workspace_launches
      WHERE launch_id = $1
      FOR UPDATE`,
    [rootIdentity.workspace_launch_id],
  );
  const ownerResult = await client.query<RuntimeOwnerRow>(
    `WITH RECURSIVE lineage(session_id, parent_session_id, path, depth) AS (
       SELECT session_id, snapshot_json->'identity'->>'parentSessionId',
              ARRAY[session_id], 0
         FROM codeops.sessions
        WHERE session_id = $1
       UNION ALL
       SELECT parent.session_id,
              parent.snapshot_json->'identity'->>'parentSessionId',
              child.path || parent.session_id, child.depth + 1
         FROM codeops.sessions parent
         JOIN lineage child ON parent.session_id = child.parent_session_id
        WHERE child.depth < 64
          AND NOT parent.session_id = ANY(child.path)
     )
     SELECT root.session_id AS root_session_id,
            target.legacy_runtime_worker_compatible AS claimant_legacy_runtime_worker_compatible,
            root.runtime_requirements_json AS session_runtime_requirements_json,
            root.runtime_requirement_digest AS session_runtime_requirement_digest,
            root.runtime_launch_binding_json AS session_runtime_launch_binding_json,
            launch.state AS workspace_state,
            launch.runtime_requirements_json AS workspace_runtime_requirements_json,
            launch.runtime_requirement_digest AS workspace_runtime_requirement_digest,
            launch.runtime_launch_binding_json AS workspace_runtime_launch_binding_json
       FROM lineage resolved
       JOIN codeops.sessions root ON root.session_id = resolved.session_id
       JOIN codeops.sessions target ON target.session_id = $1
       LEFT JOIN codeops.workspace_launches launch
         ON launch.launch_id = root.snapshot_json#>>'{identity,runId}'
      WHERE resolved.parent_session_id IS NULL
        AND root.session_id = $2
        AND root.snapshot_json#>>'{identity,runId}' = $3
      FOR UPDATE OF root`,
    [authority.sessionId, rootIdentity.root_session_id,
      rootIdentity.workspace_launch_id],
  );
  if (ownerResult.rows.length !== 1) {
    throw new RuntimeCompatibilityError("legacy-runtime-unbound");
  }
  const owner = ownerResult.rows[0]!;
  const workspaceBound = owner.workspace_runtime_launch_binding_json != null;
  const sessionBound = owner.session_runtime_launch_binding_json != null;
  if (workspaceBound && sessionBound) {
    throw new Error("session runtime lineage resolved ambiguous durable owners");
  }

  let requirements: RuntimeRequirements;
  let launchBinding: RuntimeLaunchBinding;
  let persistLegacyRootBinding = false;
  if (workspaceBound || sessionBound) {
    requirements = runtimeRequirementsSchema.parse(
      workspaceBound
        ? owner.workspace_runtime_requirements_json
        : owner.session_runtime_requirements_json,
    );
    launchBinding = runtimeLaunchBindingSchema.parse(
      workspaceBound
        ? owner.workspace_runtime_launch_binding_json
        : owner.session_runtime_launch_binding_json,
    );
    const storedDigest = workspaceBound
      ? owner.workspace_runtime_requirement_digest
      : owner.session_runtime_requirement_digest;
    if (
      storedDigest !== launchBinding.requirementDigest ||
      launchBinding.requirementDigest !== sha256CanonicalJsonDigest(requirements)
    ) {
      throw new Error("durable runtime owner evidence is invalid");
    }
  } else {
    if (
      owner.claimant_legacy_runtime_worker_compatible !== true ||
      input.fallbackRuntimeOwner === undefined ||
      (owner.workspace_state !== null && owner.workspace_state !== "ready")
    ) {
      throw new RuntimeCompatibilityError("legacy-runtime-unbound");
    }
    requirements = runtimeRequirementsSchema.parse(
      input.fallbackRuntimeOwner.requirements,
    );
    launchBinding = runtimeLaunchBindingSchema.parse(
      input.fallbackRuntimeOwner.launchBinding,
    );
    if (launchBinding.requirementDigest !== sha256CanonicalJsonDigest(requirements)) {
      throw new Error("legacy runtime upgrade owner evidence is invalid");
    }
    persistLegacyRootBinding = true;
  }

  const profile = launchBinding.profile;
  const legacyWorker = authority.version === "codeops.session-runtime-claim-request/v1";
  if (
    (legacyWorker && owner.claimant_legacy_runtime_worker_compatible !== true) ||
    (!legacyWorker && (
      authority.runtimeProfileId !== profile.profileId ||
      authority.runtimeReleaseDigest !== profile.releaseDigest ||
      authority.runtimeCapabilityDigest !== profile.capabilityDigest ||
      canonicalJsonText(authority.runtimeProfile) !== canonicalJsonText(profile)
    ))
  ) {
    throw new RuntimeCompatibilityError("runtime-release-mismatch");
  }
  const runtimeBinding = runtimeBindingSchema.parse({
    version: "codeops.runtime-binding/v1",
    requirementDigest: launchBinding.requirementDigest,
    compatibilityPolicyRevision: requirements.compatibilityPolicyRevision,
    selectedProfileId: profile.profileId,
    selectedReleaseDigest: profile.releaseDigest,
    selectedCapabilityDigest: profile.capabilityDigest,
    selectedProfile: profile,
    selectedAt: launchBinding.selectedAt,
  });
  const result = await client.query<ClaimedDispatchRow>(
    `WITH candidate AS MATERIALIZED (
       SELECT outbox.dispatch_id
         FROM codeops.session_runtime_outbox AS outbox
         JOIN codeops.sessions AS session
           ON session.session_id = outbox.session_id
         LEFT JOIN codeops.admitted_child_materializations AS materialization
           ON materialization.child_session_id = outbox.session_id
         LEFT JOIN codeops.session_runtime_outbox AS initial_dispatch
           ON initial_dispatch.dispatch_id = materialization.child_dispatch_id
         LEFT JOIN codeops.work_item_retry_dispositions AS retry
           ON retry.disposition_id = outbox.retry_disposition_id
         LEFT JOIN codeops.work_item_admissions AS retry_admission
           ON retry_admission.admission_id = outbox.admission_id
         LEFT JOIN codeops.work_item_admissions AS retry_root
           ON retry_root.admission_id = retry.root_admission_id
         LEFT JOIN codeops.workspace_launches AS retry_launch
           ON retry_launch.retry_disposition_id = retry.disposition_id
        WHERE outbox.available_at <= $1::timestamptz
          AND outbox.session_id = $5
          AND (outbox.dispatch_json->'command'->>'generation')::bigint = $6
          AND outbox.dispatch_json->'command'->>'leaseId' = $7
          AND (session.snapshot_json->>'generation')::bigint = $6
          AND session.snapshot_json->'lease'->>'status' = 'active'
          AND session.snapshot_json->'lease'->>'leaseId' = $7
          AND session.snapshot_json->'identity' = $8::jsonb
          AND (($14::boolean AND outbox.runtime_binding_json IS NULL
                AND (outbox.runtime_claim_protocol IS NULL OR
                     outbox.runtime_claim_protocol = 'legacy-unproven-v1'))
            OR (NOT $14::boolean AND
                (outbox.runtime_binding_json IS NULL OR outbox.runtime_binding_json = $9::jsonb)))
          AND (
            outbox.retry_disposition_id IS NULL
            OR (
              retry.successor_admission_id = outbox.admission_id
              AND retry.successor_session_id = outbox.session_id
              AND retry.successor_dispatch_id = outbox.dispatch_id
              AND retry.successor_launch_id = retry_launch.launch_id
              AND retry_launch.state = 'ready'
              AND retry_launch.launch_json#>>'{retryRuntime,sessionId}' = outbox.session_id
              AND retry_launch.launch_json#>>'{retryRuntime,dispositionId}' = retry.disposition_id::text
              AND retry.attempt = retry_admission.attempt
              AND retry.root_admission_id = retry_admission.root_admission_id
              AND retry_admission.root_admission_id = retry_root.admission_id
              AND retry_admission.repository = retry_root.repository
              AND retry_admission.provider = retry_root.provider
              AND retry_admission.workspace_id = retry_root.workspace_id
              AND retry_admission.project_id = retry_root.project_id
              AND retry_admission.work_item_id = retry_root.work_item_id
              AND retry_admission.workflow_id = retry_root.workflow_id
              AND retry_admission.run_id = retry_root.run_id
              AND retry_admission.source_sha = retry_root.source_sha
              AND retry.authority_expires_at > clock_timestamp()
              AND retry.authority_expires_at = retry_root.admitted_at + interval '24 hours'
              AND retry.runtime_capability_digest =
                    outbox.dispatch_json#>>'{retryAuthority,runtimeCapabilityDigest}'
              AND retry.runtime_release = outbox.dispatch_json#>>'{retryAuthority,runtimeRelease}'
              AND retry.input_digest = outbox.dispatch_json#>>'{retryAuthority,inputDigest}'
              AND retry.candidate_digest = outbox.dispatch_json#>>'{retryAuthority,candidateDigest}'
              AND retry.disposition_id::text =
                    outbox.dispatch_json#>>'{retryAuthority,dispositionId}'
              AND retry.root_admission_id::text =
                    outbox.dispatch_json#>>'{retryAuthority,rootAdmissionId}'
              AND retry.attempt::text = outbox.dispatch_json#>>'{retryAuthority,attempt}'
              AND retry.authority_expires_at =
                    (outbox.dispatch_json#>>'{retryAuthority,expiresAt}')::timestamptz
              AND outbox.dispatch_json#>'{snapshot,capabilities}' =
                    session.snapshot_json->'capabilities'
              AND outbox.principal_id = session.owner_principal_id
              AND NOT EXISTS (
                SELECT 1 FROM codeops.work_item_retry_dispositions newer
                 WHERE newer.root_admission_id = retry.root_admission_id
                   AND newer.lineage_revision > retry.lineage_revision
              )
              AND NOT EXISTS (
                SELECT 1 FROM codeops.work_item_admissions newer_attempt
                 WHERE newer_attempt.root_admission_id = retry.root_admission_id
                   AND newer_attempt.attempt > retry.attempt
              )
              AND (
                (retry.effect_state = 'none' AND NOT EXISTS (
                  SELECT 1 FROM codeops.provider_effect_receipts effect
                   WHERE effect.admission_id = retry.predecessor_admission_id
                ))
                OR
                (retry.effect_state = 'failed' AND EXISTS (
                  SELECT 1 FROM codeops.provider_effect_receipts effect
                   WHERE effect.effect_id = retry.effect_id
                     AND effect.admission_id = retry.predecessor_admission_id
                     AND effect.state = 'failed'
                     AND effect.failure_code = retry.transient_failure_code
                ))
              )
              AND retry.provider_requests_consumed = (
                SELECT COALESCE(sum(b.committed_provider_requests),0)
                 FROM codeops.work_item_admissions a
                  JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
                 WHERE a.root_admission_id=retry.root_admission_id
                   AND a.attempt < retry.attempt
              )
              AND retry.output_tokens_consumed = (
                SELECT COALESCE(sum(b.settled_output_tokens+b.reserved_output_tokens),0)
                 FROM codeops.work_item_admissions a
                  JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
                 WHERE a.root_admission_id=retry.root_admission_id
                   AND a.attempt < retry.attempt
              )
            )
          )
          AND (
            outbox.status = 'pending'
            OR (outbox.status = 'claimed' AND outbox.claim_expires_at <= $1::timestamptz)
          )
          AND (
            materialization.admission_id IS NULL
            OR (
              outbox.dispatch_id = materialization.child_dispatch_id
              AND outbox.is_admitted_initial_dispatch = true
              AND outbox.admission_id = materialization.admission_id
              AND outbox.principal_id = materialization.principal_id
              AND outbox.dispatch_digest = materialization.initial_dispatch_digest
              AND outbox.dispatch_json = materialization.input_json->'initialDispatch'
            )
            OR (
              initial_dispatch.status = 'completed'
              AND initial_dispatch.is_admitted_initial_dispatch = true
              AND initial_dispatch.admission_id = materialization.admission_id
              AND initial_dispatch.session_id = materialization.child_session_id
              AND initial_dispatch.principal_id = materialization.principal_id
              AND initial_dispatch.dispatch_digest = materialization.initial_dispatch_digest
              AND initial_dispatch.dispatch_json = materialization.input_json->'initialDispatch'
            )
          )
        ORDER BY
          CASE WHEN materialization.admission_id IS NOT NULL
                 AND outbox.dispatch_id = materialization.child_dispatch_id
               THEN 0 ELSE 1 END ASC,
          outbox.available_at ASC, outbox.created_at ASC, outbox.dispatch_id ASC
        FOR UPDATE OF outbox SKIP LOCKED
         LIMIT 1
     ), persisted_owner AS (
       UPDATE codeops.sessions AS root
          SET runtime_requirements_json = $17::jsonb,
              runtime_requirement_digest = $18,
              runtime_launch_binding_json = $19::jsonb
        WHERE root.session_id = $15
          AND $16::boolean
          AND root.runtime_launch_binding_json IS NULL
          AND EXISTS (SELECT 1 FROM candidate)
       RETURNING root.session_id
     )
     UPDATE codeops.session_runtime_outbox AS outbox
        SET status = 'claimed',
            claim_token = $2,
            claimed_by = $3,
            claimed_at = $1::timestamptz,
            claim_expires_at = $4::timestamptz,
            claim_count = outbox.claim_count + 1,
            runtime_binding_revision = CASE WHEN $14::boolean
              THEN outbox.runtime_binding_revision
              ELSE outbox.runtime_binding_revision + 1 END,
            runtime_binding_json = CASE WHEN $14::boolean THEN NULL
              ELSE COALESCE(outbox.runtime_binding_json, $9::jsonb) END,
            runtime_requirement_digest = CASE WHEN $14::boolean THEN NULL
              ELSE COALESCE(outbox.runtime_requirement_digest, $10) END,
            runtime_profile_id = CASE WHEN $14::boolean THEN NULL
              ELSE COALESCE(outbox.runtime_profile_id, $11) END,
            runtime_release_digest = CASE WHEN $14::boolean THEN NULL
              ELSE COALESCE(outbox.runtime_release_digest, $12) END,
            runtime_capability_digest = CASE WHEN $14::boolean THEN NULL
              ELSE COALESCE(outbox.runtime_capability_digest, $13) END,
            runtime_claim_protocol = CASE WHEN $14::boolean
              THEN 'legacy-unproven-v1' ELSE 'bound-v2' END
       FROM candidate
      WHERE outbox.dispatch_id = candidate.dispatch_id
        AND (NOT $16::boolean OR EXISTS (SELECT 1 FROM persisted_owner))
      RETURNING outbox.dispatch_json, outbox.claim_token,
                outbox.claim_expires_at, outbox.claim_count,
                outbox.is_admitted_initial_dispatch,
                outbox.runtime_binding_json, outbox.runtime_claim_protocol`,
    [
      claimedAt,
      claimToken,
      input.workerId,
      claimExpiresAt,
      authority.sessionId,
      authority.generation,
      authority.leaseId,
      canonicalJsonText(authority.identity),
      canonicalJsonText(runtimeBinding),
      launchBinding.requirementDigest,
      profile.profileId,
      profile.releaseDigest,
      profile.capabilityDigest,
      legacyWorker,
      owner.root_session_id,
      persistLegacyRootBinding,
      canonicalJsonText(requirements),
      launchBinding.requirementDigest,
      canonicalJsonText(launchBinding),
    ],
  );
  if (!result.rows[0]) {
    await client.query("COMMIT");
    return null;
  }
  const row = result.rows[0];
  if (
    row.claim_token !== claimToken ||
    postgresTimestamp(row.claim_expires_at) !== claimExpiresAt ||
    !Number.isSafeInteger(row.claim_count) ||
    Number(row.claim_count) < 1 ||
    typeof row.is_admitted_initial_dispatch !== "boolean"
  ) {
    throw new Error("runtime claim persistence did not match the requested lease");
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  const persistedRuntimeBinding = legacyWorker
    ? undefined
    : runtimeBindingSchema.parse(row.runtime_binding_json);
  if (
    (legacyWorker && row.runtime_claim_protocol !== "legacy-unproven-v1") ||
    (!legacyWorker && row.runtime_claim_protocol !== "bound-v2")
  ) {
    throw new Error("runtime claim protocol persistence drifted");
  }
  if (
    dispatch.command.sessionId !== authority.sessionId ||
    dispatch.command.generation !== authority.generation ||
    dispatch.command.leaseId !== authority.leaseId ||
    canonicalJsonText(dispatch.snapshot.identity) !== canonicalJsonText(authority.identity)
  ) {
    throw new Error("runtime claim returned a different session authority");
  }
  if (Number(row.claim_count) > 1) {
    await client.query(
      `UPDATE codeops.provider_effect_receipts
          SET state = 'not_attempted',
              resolution_summary =
                'Dispatch claim authority ended before any provider attempt.',
              reconciliation_action = 'none', resolved_at = $1::timestamptz,
              updated_at = $1::timestamptz
        WHERE dispatch_id = $2 AND state = 'authorized'
          AND attempted_at IS NULL
          AND dispatch_claim_token IS DISTINCT FROM $3::uuid`,
      [claimedAt, dispatch.dispatchId, claimToken],
    );
    await cleanupNoReceiptGitHubBranchCandidatesForDispatch(
      client,
      dispatch.dispatchId,
    );
  }
  await client.query("COMMIT");
  return {
    dispatch,
    claimToken,
    claimExpiresAt,
    claimCount: Number(row.claim_count),
    isAdmittedInitialDispatch: row.is_admitted_initial_dispatch,
    ...(persistedRuntimeBinding === undefined ? {} : { runtimeBinding: persistedRuntimeBinding }),
  };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function renewSessionRuntimeDispatchClaim(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimeDispatchClaim> {
  requireWorkerId(input.workerId);
  const request = sessionRuntimeClaimRenewalRequestSchema.parse({
    version: "codeops.session-runtime-claim-renewal-request/v1",
    claimToken: input.claimToken,
    leaseMs: input.leaseMs,
  });
  const now = (input.now ?? (() => new Date()))();
  const renewedUntil = new Date(now.getTime() + request.leaseMs).toISOString();
  const result = await client.query<ClaimedDispatchRow>(
    `UPDATE codeops.session_runtime_outbox AS outbox
        SET claim_expires_at = $4::timestamptz
       FROM codeops.sessions AS session
      WHERE outbox.dispatch_id = $1::uuid
        AND outbox.session_id = session.session_id
        AND outbox.status = 'claimed'
        AND outbox.claim_token = $2::uuid
        AND outbox.claimed_by = $3
        AND outbox.claim_expires_at > $5::timestamptz
        AND session.owner_principal_id = outbox.principal_id
        AND session.snapshot_json->'lease'->>'status' = 'active'
        AND session.snapshot_json->'lease'->>'leaseId' =
            outbox.dispatch_json->'command'->>'leaseId'
        AND session.snapshot_json->>'generation' =
            outbox.dispatch_json->'command'->>'generation'
        AND session.snapshot_json->'identity' =
            outbox.dispatch_json->'snapshot'->'identity'
      RETURNING outbox.dispatch_json, outbox.claim_token,
                outbox.claim_expires_at, outbox.claim_count,
                outbox.is_admitted_initial_dispatch,
                outbox.runtime_binding_json, outbox.runtime_claim_protocol`,
    [input.dispatchId, request.claimToken, input.workerId, renewedUntil, now.toISOString()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ImmutableSessionRuntimeDispatchConflictError(
      "runtime claim renewal requires the exact live dispatch authority",
    );
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  const persistedRuntimeBinding = row.runtime_claim_protocol === "bound-v2"
    ? runtimeBindingSchema.parse(row.runtime_binding_json)
    : undefined;
  if (
    row.claim_token !== request.claimToken ||
    postgresTimestamp(row.claim_expires_at) !== renewedUntil ||
    !Number.isSafeInteger(row.claim_count) ||
    Number(row.claim_count) < 1 ||
    typeof row.is_admitted_initial_dispatch !== "boolean"
  ) {
    throw new Error("runtime claim renewal persistence drifted");
  }
  return {
    dispatch,
    claimToken: request.claimToken,
    claimExpiresAt: renewedUntil,
    claimCount: Number(row.claim_count),
    isAdmittedInitialDispatch: row.is_admitted_initial_dispatch,
    ...(persistedRuntimeBinding === undefined ? {} : { runtimeBinding: persistedRuntimeBinding }),
  };
}

function duplicateRuntimeResult(
  result: SessionCommandResult,
): SessionCommandResult {
  if (result.disposition !== "committed") return result;
  return sessionCommandResultSchema.parse({
    ...result,
    disposition: "duplicate",
    originalCommandId: result.commandId,
  });
}

export async function completeSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly completion: unknown;
    readonly now?: () => Date;
    readonly commandId?: () => string;
  },
): Promise<SessionCommandResult> {
  const completion = sessionRuntimeCompletionSchema.parse(input.completion);
  requireWorkerId(input.workerId);
  if (completion.dispatchId !== input.dispatchId) {
    throw new Error("runtime completion does not match the requested dispatch");
  }
  const stored = await client.query<CompletedDispatchRow>(
    `SELECT dispatch_json, status, completion_json, result_json, completed_by
       FROM codeops.session_runtime_outbox
      WHERE dispatch_id = $1`,
    [input.dispatchId],
  );
  if (!stored.rows[0]) {
    throw new SessionRuntimeDispatchNotFoundError(
      `runtime dispatch ${input.dispatchId} was not found`,
    );
  }
  const row = stored.rows[0];
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (row.status === "completed") {
    const persistedCompletion = sessionRuntimeCompletionSchema.parse(
      row.completion_json,
    );
    if (
      row.completed_by !== input.workerId ||
      canonicalJsonText(persistedCompletion) !== canonicalJsonText(completion)
    ) {
      throw new ImmutableSessionRuntimeDispatchConflictError(
        `runtime dispatch ${input.dispatchId} already has a different immutable completion`,
      );
    }
    return duplicateRuntimeResult(
      sessionCommandResultSchema.parse(row.result_json),
    );
  }

  const completionSnapshot = await resolveSessionRuntimeCompletionSnapshot(
    client,
    { dispatch, claimToken: input.claimToken },
  );

  return executeSessionCommandTransaction(client, {
    command: dispatch.command,
    principalId: dispatch.principalId,
    now: input.now,
    commandId: input.commandId,
    mutate: (_snapshot, _command, context) =>
      applySessionRuntimeCompletion(
        dispatch,
        completion,
        context,
        completionSnapshot,
      ),
    runtimeReservation: {
      dispatchId: dispatch.dispatchId,
      claimToken: input.claimToken,
      workerId: input.workerId,
      expectedSnapshot: completionSnapshot,
      dispatchJson: dispatch,
      completionJson: completion,
    },
  });
}
