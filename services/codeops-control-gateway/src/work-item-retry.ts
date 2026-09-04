import { createHash } from "node:crypto";

import {
  canonicalJsonText,
  createEventId,
  createTransitionId,
  isWorkspaceSessionIdentity,
  projectSessionBudgetV2,
  providerEffectReceiptSchema,
  sessionEventSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimeTerminalObservationSchema,
  sessionSnapshotSchema,
  sha256CanonicalJsonDigest,
  workItemLifecycleEventSchema,
  workspaceLaunchRequestSchema,
  workspaceLaunchSchema,
  workItemRetryDispositionRequestSchema,
  workItemRetryDispositionResultSchema,
  type SessionEvent,
  type SessionSnapshot,
  type WorkItemRetryDispositionResult,
  type SessionRuntimeTerminalObservation,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import { buildSessionRuntimeDispatch } from "./session-broker-runtime.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";

export class WorkItemRetryConflictError extends Error {}
export class WorkItemRetryNotFoundError extends Error {}
interface Row extends Record<string, unknown> {}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new WorkItemRetryConflictError("stored retry time is invalid");
  return parsed.toISOString();
}

function exact(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJsonText(actual) !== canonicalJsonText(expected)) throw new WorkItemRetryConflictError(message);
}

function integer(value: unknown, message: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new WorkItemRetryConflictError(message);
  return parsed;
}

async function replay(client: TransactionClient, dispositionId: string, requestAuthority: unknown): Promise<WorkItemRetryDispositionResult | null> {
  const result = await client.query<Row>(
    `SELECT disposition_id, root_admission_id, attempt, successor_session_id,
            successor_dispatch_id, lifecycle_event_id, supervision_event_id,
            authority_digest, authority_json
       FROM codeops.work_item_retry_dispositions
      WHERE disposition_id=$1 FOR UPDATE`, [dispositionId]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const authority = row.authority_json as Record<string, unknown>;
  if (row.authority_digest !== sha256CanonicalJsonDigest(authority)) {
    throw new WorkItemRetryConflictError("retry disposition authority digest drifted");
  }
  exact(authority.requestAuthority, requestAuthority, "retry disposition conflicts with immutable authority");
  return workItemRetryDispositionResultSchema.parse({
    version: "codeops.work-item-retry-disposition-result/v1",
    dispositionId, disposition: "replayed", rootAdmissionId: row.root_admission_id,
    attempt: Number(row.attempt), successorSessionId: row.successor_session_id,
    successorDispatchId: row.successor_dispatch_id,
    lifecycleEventId: row.lifecycle_event_id, supervisionEventId: row.supervision_event_id,
  });
}

function boundedReason(value: string): string {
  const reason = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return /^[A-Za-z0-9]/.test(reason) ? reason : "runtime_failed";
}

function launchIdentity(dispositionId: string) {
  const suffix = createHash("sha256").update(`retry-launch\0${dispositionId}`).digest("hex").slice(0, 24);
  return { launchId: `launch-${suffix}`, sessionId: `ses_${suffix}` };
}

async function deriveDispositionRequest(
  client: TransactionClient,
  observation: SessionRuntimeTerminalObservation,
  runtimeAttestation: { readonly configured: string; readonly observed: string | null },
) {
  const result = await client.query<Row>(
    `SELECT admission.*, root.admitted_at AS root_admitted_at,
            root.child_session_id AS root_child_session_id,
            session.snapshot_json, session.owner_principal_id,
            parent.snapshot_json AS parent_snapshot_json,
            predecessor.dispatch_json AS predecessor_dispatch_json,
            predecessor.status AS predecessor_status,
            predecessor.claim_token AS predecessor_claim_token,
            predecessor.claimed_by AS predecessor_claimed_by,
            predecessor.claim_expires_at AS predecessor_claim_expires_at,
            launch.request_json AS parent_launch_request_json
       FROM codeops.work_item_admissions admission
       JOIN codeops.work_item_admissions root ON root.admission_id=admission.root_admission_id
       JOIN codeops.sessions session ON session.session_id=admission.child_session_id
       JOIN codeops.sessions parent ON parent.session_id=admission.parent_session_id
       JOIN codeops.session_runtime_outbox predecessor
         ON predecessor.dispatch_id=admission.child_dispatch_id
        AND predecessor.session_id=admission.child_session_id
       LEFT JOIN codeops.workspace_launches launch
         ON launch.launch_json->>'sessionId'=admission.parent_session_id
      WHERE admission.child_session_id=$1
      ORDER BY admission.attempt DESC LIMIT 1
      FOR UPDATE OF admission,root,session,parent,predecessor`,
    [observation.sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  const parentSnapshot = sessionSnapshotSchema.parse(row.parent_snapshot_json);
  const parentIdentity = parentSnapshot.identity;
  if (!isWorkspaceSessionIdentity(parentIdentity) || !isWorkspaceSessionIdentity(snapshot.identity)) {
    throw new WorkItemRetryConflictError("retry Session lineage is not a workspace lineage");
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.predecessor_dispatch_json);
  if (dispatch.command.type !== "prompt") {
    throw new WorkItemRetryConflictError("retry predecessor dispatch is not the admitted prompt");
  }
  const rootAdmissionId = String(row.root_admission_id);
  const dispositionId = deterministicUuid(
    `retry-disposition\0${rootAdmissionId}\0${row.admission_id}\0${observation.job.uid}`,
  );
  const revisionResult = await client.query<Row>(
    `SELECT COALESCE(max(lineage_revision),0)::bigint AS revision,
            max(lineage_revision) FILTER (WHERE disposition_id=$2)::bigint AS replay_revision
       FROM codeops.work_item_retry_dispositions WHERE root_admission_id=$1`,
    [rootAdmissionId, dispositionId],
  );
  const lineageRevision = revisionResult.rows[0]?.replay_revision === null
    ? integer(revisionResult.rows[0]?.revision, "stored retry lineage revision is invalid") + 1
    : integer(revisionResult.rows[0]?.replay_revision, "stored retry replay revision is invalid");
  const predecessorClaim = {
    dispatchId: String(row.child_dispatch_id),
    workerId: typeof row.predecessor_claimed_by === "string" ? row.predecessor_claimed_by : null,
    claimToken: typeof row.predecessor_claim_token === "string" ? row.predecessor_claim_token : null,
    claimExpiresAt: row.predecessor_claim_expires_at === null
      ? null : timestamp(row.predecessor_claim_expires_at),
  } as const;
  const exactLiveClaim = row.predecessor_status === "claimed" &&
    predecessorClaim.workerId !== null && predecessorClaim.claimToken !== null &&
    predecessorClaim.claimExpiresAt !== null &&
    Date.parse(predecessorClaim.claimExpiresAt) > Date.parse(observation.observedAt);
  const effects = await client.query<Row>(
    `SELECT effect_id,provider,repository,operation,pull_request_number,target_id,expected_head_sha,
            session_id,dispatch_id,payload_digest,permission_digest,state,authorized_at,attempted_at,
            resolved_at,reconciliation_action,resolution_summary,failure_code
       FROM codeops.provider_effect_receipts
      WHERE admission_id=$1 AND session_id=$2 ORDER BY effect_id FOR UPDATE`,
    [row.admission_id, observation.sessionId],
  );
  let providerEffect: Record<string, unknown>;
  let retryEligibleEffect = false;
  const terminalBody = { sessionId: observation.sessionId, generation: observation.generation,
    cursor: snapshot.state === "failed" ? snapshot.eventCursor : snapshot.eventCursor + 1,
    type: "runtime_terminal" as const,
    runtimeTerminal: observation, occurredAt: observation.observedAt };
  if (effects.rows.length === 0) {
    providerEffect = { state: "none",
      preEffectProofDigest: sha256CanonicalJsonDigest({ terminalObservation: observation,
        predecessorAdmissionId: row.admission_id, providerEffects: [] }),
      proofEventId: eventId(terminalBody) };
    retryEligibleEffect = true;
  } else if (effects.rows.length === 1) {
    const effect = effects.rows[0]!;
    const receipt = providerEffectReceiptSchema.parse({
      version: "codeops.provider-effect-receipt/v1", effectId: effect.effect_id,
      provider: effect.provider, repository: effect.repository, operation: effect.operation,
      pullRequestNumber: effect.pull_request_number, targetId: effect.target_id,
      expectedHeadSha: effect.expected_head_sha, payloadDigest: effect.payload_digest,
      permissionDigest: effect.permission_digest, sessionId: effect.session_id,
      dispatchId: effect.dispatch_id, state: effect.state,
      authorizedAt: timestamp(effect.authorized_at),
      attemptedAt: effect.attempted_at === null ? null : timestamp(effect.attempted_at),
      resolvedAt: effect.resolved_at === null ? null : timestamp(effect.resolved_at),
      reconciliationAction: effect.reconciliation_action,
      resolutionSummary: effect.resolution_summary,
    });
    providerEffect = { state: effect.state, effectId: effect.effect_id,
      receiptDigest: sha256CanonicalJsonDigest(receipt), failureCode: effect.failure_code ?? null };
    retryEligibleEffect = effect.state === "failed" &&
      ["rate_limited", "provider_timeout", "provider_unavailable", "transport_error", "server_error"]
        .includes(String(effect.failure_code));
  } else {
    throw new WorkItemRetryConflictError("retry predecessor has ambiguous provider effects");
  }
  const attemptNumber = integer(row.attempt, "stored retry attempt is invalid");
  const expiresAt = new Date(Date.parse(timestamp(row.root_admitted_at)) + 24 * 60 * 60_000).toISOString();
  const releaseMatches = runtimeAttestation.observed === runtimeAttestation.configured &&
    /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(runtimeAttestation.configured);
  const admits = observation.cause.type === "failed" && exactLiveClaim && retryEligibleEffect &&
    releaseMatches && attemptNumber < 4 && Date.parse(observation.observedAt) < Date.parse(expiresAt);
  const prompt = dispatch.command.prompt;
  const { launchId, sessionId } = launchIdentity(dispositionId);
  const successor = admits && row.parent_launch_request_json !== null ? {
    admissionId: deterministicUuid(`retry-admission\0${dispositionId}`), sessionId, generation: 1,
    leaseId: deterministicUuid(`retry-lease\0${dispositionId}`),
    holderId: `session-job:${sessionId}`,
    dispatchId: deterministicUuid(`retry-dispatch\0${dispositionId}`),
    idempotencyKey: deterministicUuid(`retry-prompt\0${dispositionId}`), prompt,
    inputDigest: sha256CanonicalJsonDigest(prompt),
    candidateDigest: sha256CanonicalJsonDigest(snapshot.checkpoint ?? {
      version: "codeops.retry-candidate/none", predecessorAdmissionId: row.admission_id,
    }),
    runtimeCapabilityDigest: sha256CanonicalJsonDigest(sessionCapabilitiesFor("running", false)),
    runtimeRelease: runtimeAttestation.configured,
  } : null;
  const budgetResult = await client.query<Row>(
    `SELECT COALESCE(sum(b.committed_provider_requests),0)::bigint AS provider_requests,
            COALESCE(sum(b.settled_output_tokens+b.reserved_output_tokens),0)::bigint AS output_tokens,
            max(CASE WHEN a.attempt=1 THEN b.revision END)::bigint AS root_revision
       FROM codeops.work_item_admissions a
       JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
      WHERE a.root_admission_id=$1`, [rootAdmissionId]);
  const aggregate = budgetResult.rows[0]!;
  const request = workItemRetryDispositionRequestSchema.parse({
    version: "codeops.work-item-retry-disposition/v1", dispositionId, lineageRevision,
    rootAdmissionId, predecessorSessionId: observation.sessionId,
    kind: successor !== null ? "retry-same-input" :
      ["attempting", "unknown"].includes(String(providerEffect.state))
        ? "reconcile-unknown-effect" : "stop-terminal",
    reasonCode: boundedReason(observation.cause.reason),
    authority: { repository: row.repository,
      provider: { kind: "plane", workspaceId: row.workspace_id, projectId: row.project_id },
      workItemId: row.work_item_id, workflowId: row.workflow_id, runId: row.run_id,
      sourceSha: row.source_sha, ownerPrincipalId: row.owner_principal_id,
      predecessorGeneration: observation.generation, predecessorLeaseId: observation.leaseId,
      expiresAt },
    terminalObservation: observation, providerEffect,
    budget: { rootBudgetId: row.root_child_session_id,
      rootRevision: Number(aggregate.root_revision),
      providerRequestsConsumed: Number(aggregate.provider_requests),
      outputTokensConsumed: Number(aggregate.output_tokens) },
    successor,
  });
  return { request, predecessorClaim, runtimeAttestation, parentIdentity,
    parentLaunchRequest: row.parent_launch_request_json, successorLaunchId: successor === null ? null : launchId };
}

export async function reconcileFailedWorkItemAttempt(
  client: TransactionClient,
  rawObservation: unknown,
  runtimeAttestation: { readonly configured: string; readonly observed: string | null },
): Promise<WorkItemRetryDispositionResult | null> {
  const observation = sessionRuntimeTerminalObservationSchema.parse(rawObservation);
  if (observation.cause.type !== "failed") return null;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const derived = await deriveDispositionRequest(client, observation, runtimeAttestation);
    if (derived === null) { await client.query("ROLLBACK"); return null; }
    const { request } = derived;
    const replayAuthority = { request, predecessorClaim: derived.predecessorClaim,
      runtimeAttestation: derived.runtimeAttestation };
    const replayed = await replay(client, request.dispositionId, replayAuthority);
    if (replayed !== null) { await client.query("COMMIT"); return replayed; }
    const clock = await client.query<Row>("SELECT clock_timestamp() AS now");
    const createdAt = timestamp(clock.rows[0]?.now);
    const nowMs = Date.parse(createdAt);

    const rootResult = await client.query<Row>(
      `SELECT root.*, parent.owner_principal_id AS parent_owner_principal_id,
              root_session.owner_principal_id AS root_owner_principal_id,
              root_session.snapshot_json AS root_snapshot_json,
              budget.budget_id AS root_budget_id, budget.revision AS root_budget_revision,
              budget.provider_requests_limit AS root_provider_requests_limit,
              budget.output_tokens_limit AS root_output_tokens_limit,
              approval.approved_by_principal_id
         FROM codeops.work_item_admissions root
         JOIN codeops.sessions parent ON parent.session_id=root.parent_session_id
         JOIN codeops.sessions root_session ON root_session.session_id=root.child_session_id
         JOIN codeops.session_model_budgets budget ON budget.session_id=root.child_session_id
         JOIN codeops.project_plan_approvals approval ON approval.approval_id=root.approval_id
        WHERE root.admission_id=$1 AND root.root_admission_id=root.admission_id
          AND root.attempt=1 FOR UPDATE OF root,parent,root_session,budget,approval`,
      [request.rootAdmissionId]);
    const root = rootResult.rows[0];
    if (root === undefined) throw new WorkItemRetryNotFoundError("retry root admission was not found");
    if (root.authority_digest !== sha256CanonicalJsonDigest(root.authority_json)) {
      throw new WorkItemRetryConflictError("retry root admission authority digest drifted");
    }
    const expiresAt = new Date(Date.parse(timestamp(root.admitted_at)) + 24 * 60 * 60 * 1_000).toISOString();
    const authority = request.authority;
    if (authority.expiresAt !== expiresAt || authority.repository !== root.repository ||
        authority.provider.workspaceId !== root.workspace_id || authority.provider.projectId !== root.project_id ||
        authority.workItemId !== root.work_item_id || authority.workflowId !== root.workflow_id ||
        authority.runId !== root.run_id || authority.sourceSha !== root.source_sha ||
        authority.ownerPrincipalId !== root.root_owner_principal_id ||
        root.root_owner_principal_id !== root.parent_owner_principal_id ||
        root.approved_by_principal_id !== root.parent_owner_principal_id) {
      throw new WorkItemRetryConflictError("retry authority drifted from the immutable root admission");
    }

    const lineage = await client.query<Row>(
      `SELECT admission_id,child_session_id,child_dispatch_id,attempt
         FROM codeops.work_item_admissions WHERE root_admission_id=$1
        ORDER BY attempt DESC LIMIT 1 FOR UPDATE`, [request.rootAdmissionId]);
    const predecessor = lineage.rows[0];
    if (predecessor === undefined || predecessor.child_session_id !== request.predecessorSessionId) {
      throw new WorkItemRetryConflictError("retry predecessor is not the newest successor lineage");
    }
    const predecessorAttempt = integer(predecessor.attempt, "stored retry attempt is invalid");
    const latestRevisionResult = await client.query<Row>(
      `SELECT COALESCE(max(lineage_revision),0)::bigint AS revision
         FROM codeops.work_item_retry_dispositions WHERE root_admission_id=$1`, [request.rootAdmissionId]);
    const latestRevision = integer(latestRevisionResult.rows[0]?.revision, "stored retry lineage revision is invalid");
    if (request.lineageRevision !== latestRevision + 1) {
      throw new WorkItemRetryConflictError("retry disposition is duplicated or reordered");
    }

    const successor = request.successor;
    const attempt = predecessorAttempt + (successor === null ? 0 : 1);
    if (attempt > 4) throw new WorkItemRetryConflictError("retry successor budget is exhausted");
    if (successor !== null && nowMs >= Date.parse(expiresAt)) {
      throw new WorkItemRetryConflictError("retry root authority expired before successor admission");
    }

    const predecessorResult = await client.query<Row>(
      `SELECT admission.*, session.snapshot_json, session.owner_principal_id,
              progress.lease_id AS progress_lease_id, progress.run_id AS progress_run_id,
              progress.job_name, progress.job_uid, progress.job_resource_version
         FROM codeops.work_item_admissions admission
         JOIN codeops.sessions session ON session.session_id=admission.child_session_id
         JOIN codeops.session_runtime_job_progress progress
           ON progress.session_id=session.session_id AND progress.generation=session.generation
        WHERE admission.admission_id=$1 AND admission.root_admission_id=$2
          AND admission.attempt=$3 FOR UPDATE OF admission,session,progress`,
      [predecessor.admission_id, request.rootAdmissionId, predecessorAttempt]);
    const prior = predecessorResult.rows[0];
    if (prior === undefined || prior.child_session_id !== request.predecessorSessionId ||
        prior.repository !== authority.repository || prior.workspace_id !== authority.provider.workspaceId ||
        prior.project_id !== authority.provider.projectId || prior.work_item_id !== authority.workItemId ||
        prior.workflow_id !== authority.workflowId || prior.run_id !== authority.runId ||
        prior.source_sha !== authority.sourceSha || prior.owner_principal_id !== authority.ownerPrincipalId) {
      throw new WorkItemRetryConflictError("retry predecessor authority drifted");
    }
    if (prior.authority_digest !== sha256CanonicalJsonDigest(prior.authority_json)) {
      throw new WorkItemRetryConflictError("retry predecessor admission authority digest drifted");
    }
    const priorSnapshot = sessionSnapshotSchema.parse(prior.snapshot_json);
    if (!isWorkspaceSessionIdentity(priorSnapshot.identity) ||
        priorSnapshot.budget?.version !== "codeops.session-budget/v2" ||
        priorSnapshot.generation !== authority.predecessorGeneration ||
        priorSnapshot.lease?.leaseId !== authority.predecessorLeaseId ||
        !["running", "waiting_permission", "checkpointing", "hibernated"].includes(priorSnapshot.state)) {
      throw new WorkItemRetryConflictError("retry predecessor is not eligible for atomic terminal disposition");
    }

    if (prior.progress_lease_id !== observation.leaseId || prior.progress_run_id !== observation.runId ||
        prior.job_name !== observation.job.name || prior.job_uid !== observation.job.uid ||
        prior.job_resource_version === null || prior.job_resource_version === undefined ||
        String(prior.job_resource_version) !== observation.job.resourceVersion) {
      throw new WorkItemRetryConflictError("retry terminal observation drifted from runtime progress");
    }
    const alreadyTerminal = await client.query<Row>(
      `SELECT observation_json FROM codeops.session_runtime_terminal_observations
        WHERE job_uid=$1 OR (session_id=$2 AND generation=$3) FOR UPDATE`,
      [observation.job.uid, observation.sessionId, observation.generation]);
    if (alreadyTerminal.rows[0] !== undefined) {
      throw new WorkItemRetryConflictError("terminal fact exists without its atomic retry disposition");
    }

    const terminalCursor = priorSnapshot.eventCursor + 1;
    const terminalLease = priorSnapshot.lease!.status === "active"
      ? { leaseId: observation.leaseId, generation: observation.generation,
          status: "released" as const, releasedAt: observation.observedAt }
      : priorSnapshot.lease;
    const terminalSnapshot = sessionSnapshotSchema.parse({ ...priorSnapshot, state: "failed",
      lease: terminalLease, pendingPermission: null, eventCursor: terminalCursor,
      capabilities: sessionCapabilitiesFor("failed", priorSnapshot.checkpoint !== null),
      updatedAt: observation.observedAt });
    const terminalBody = { sessionId: observation.sessionId, generation: observation.generation,
      cursor: terminalCursor, type: "runtime_terminal" as const,
      runtimeTerminal: observation, occurredAt: observation.observedAt };
    const terminalEvent = sessionEventSchema.parse({ version: "codeops.session-event/v1",
      eventId: eventId(terminalBody), ...terminalBody });

    const effects = await client.query<Row>(
      `SELECT effect_id,provider,repository,operation,pull_request_number,target_id,expected_head_sha,
              session_id,dispatch_id,payload_digest,permission_digest,state,authorized_at,attempted_at,
              resolved_at,reconciliation_action,resolution_summary,failure_code,admission_id,
              session_generation,session_lease_id,authorization_expires_at,dispatch_claim_token
         FROM codeops.provider_effect_receipts
        WHERE admission_id=$1 AND session_id=$2 ORDER BY effect_id FOR UPDATE`,
      [prior.admission_id, request.predecessorSessionId]);
    if (request.providerEffect.state === "none") {
      if (effects.rows.length !== 0 || request.providerEffect.proofEventId !== terminalEvent.eventId ||
          request.providerEffect.preEffectProofDigest !== sha256CanonicalJsonDigest({
            terminalObservation: observation, predecessorAdmissionId: prior.admission_id, providerEffects: [],
          })) {
        throw new WorkItemRetryConflictError("provider-effect none lacks authoritative pre-effect proof");
      }
    } else {
      const effectFence = request.providerEffect;
      const effect = effects.rows.find((row) => row.effect_id === effectFence.effectId);
      const receipt = effect === undefined ? null : providerEffectReceiptSchema.parse({
        version: "codeops.provider-effect-receipt/v1", effectId: effect.effect_id,
        provider: effect.provider, repository: effect.repository, operation: effect.operation,
        pullRequestNumber: effect.pull_request_number, targetId: effect.target_id,
        expectedHeadSha: effect.expected_head_sha, payloadDigest: effect.payload_digest,
        permissionDigest: effect.permission_digest, sessionId: effect.session_id,
        dispatchId: effect.dispatch_id, state: effect.state,
        authorizedAt: timestamp(effect.authorized_at),
        attemptedAt: effect.attempted_at === null ? null : timestamp(effect.attempted_at),
        resolvedAt: effect.resolved_at === null ? null : timestamp(effect.resolved_at),
        reconciliationAction: effect.reconciliation_action,
        resolutionSummary: effect.resolution_summary,
      });
      if (effect === undefined || effects.rows.length !== 1 || effect.state !== effectFence.state ||
          effect.repository !== authority.repository || effect.expected_head_sha !== authority.sourceSha ||
          effect.admission_id !== prior.admission_id || Number(effect.session_generation) !== observation.generation ||
          effect.session_lease_id !== observation.leaseId ||
          effectFence.receiptDigest !== sha256CanonicalJsonDigest(receipt) ||
          (effect.failure_code ?? null) !== effectFence.failureCode ||
          (effect.state === "authorized" && effect.attempted_at !== null)) {
        throw new WorkItemRetryConflictError("retry provider-effect receipt fence drifted");
      }
    }

    await client.query<Row>(
      `SELECT b.session_id
         FROM codeops.work_item_admissions a
         JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
        WHERE a.root_admission_id=$1 ORDER BY a.attempt FOR UPDATE OF b`,
      [request.rootAdmissionId]);
    const budgetResult = await client.query<Row>(
      `SELECT COALESCE(sum(b.committed_provider_requests),0)::bigint AS provider_requests,
              COALESCE(sum(b.settled_output_tokens+b.reserved_output_tokens),0)::bigint AS output_tokens,
              max(CASE WHEN a.attempt=1 THEN b.revision END)::bigint AS root_revision
         FROM codeops.work_item_admissions a
         JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
        WHERE a.root_admission_id=$1`, [request.rootAdmissionId]);
    const aggregate = budgetResult.rows[0]!;
    const providerRequests = integer(aggregate.provider_requests, "retry aggregate provider budget is invalid");
    const outputTokens = integer(aggregate.output_tokens, "retry aggregate output budget is invalid");
    if (request.budget.rootBudgetId !== root.root_budget_id ||
        request.budget.rootRevision !== Number(aggregate.root_revision) ||
        request.budget.providerRequestsConsumed !== providerRequests ||
        request.budget.outputTokensConsumed !== outputTokens) {
      throw new WorkItemRetryConflictError("retry aggregate budget disposition drifted");
    }
    const providerLimit = integer(root.root_provider_requests_limit, "retry root provider budget is invalid");
    const outputLimit = integer(root.root_output_tokens_limit, "retry root output budget is invalid");
    if (successor !== null && (providerRequests >= providerLimit || outputTokens >= outputLimit)) {
      throw new WorkItemRetryConflictError("retry aggregate model budget is exhausted");
    }

    const lifecycleResult = await client.query<Row>(
      `SELECT phase,attention,sequence FROM codeops.work_item_lifecycle
        WHERE repository=$1 AND provider='plane' AND workspace_id=$2 AND project_id=$3
          AND work_item_id=$4 AND workflow_id=$5 AND run_id=$6 FOR UPDATE`,
      [authority.repository, authority.provider.workspaceId, authority.provider.projectId,
        authority.workItemId, authority.workflowId, authority.runId]);
    const lifecycle = lifecycleResult.rows[0];
    if (lifecycle === undefined || lifecycle.phase === "done" || lifecycle.phase === "cancelled") {
      throw new WorkItemRetryConflictError("retry lifecycle authority is terminal or missing");
    }
    const previousState = { phase: lifecycle.phase, attention: lifecycle.attention } as const;
    const nextAttention = lifecycle.attention === "clear" ? "needed" as const : "clear" as const;
    const lifecycleCommand = lifecycle.attention === "clear" ? "request_attention" as const : "resolve_attention" as const;
    const lifecycleSequence = integer(lifecycle.sequence, "retry lifecycle sequence is invalid") + 1;
    const transitionKey = `retry:${request.dispositionId}`;
    const transitionId = createTransitionId({ workflowId: authority.workflowId, transitionKey,
      version: "codeops.work-item-lifecycle-event/v1" });
    const lifecycleEvent = workItemLifecycleEventSchema.parse({ version: "codeops.work-item-lifecycle-event/v1",
      eventId: createEventId({ workflowId: authority.workflowId, transitionId,
        version: "codeops.work-item-lifecycle-event/v1" }), transitionId, transitionKey,
      command: lifecycleCommand, repository: (() => { const [owner,name] = authority.repository.split("/"); return {owner,name}; })(),
      provider: authority.provider, workItemId: authority.workItemId, workflowId: authority.workflowId,
      runId: authority.runId, sequence: lifecycleSequence, previousState,
      state: { phase: lifecycle.phase, attention: nextAttention }, sourceSha: authority.sourceSha,
      occurredAt: createdAt, summary: `Retry disposition: ${request.kind}`, evidence: [] });

    const parentResult = await client.query<Row>(
      `SELECT snapshot_json FROM codeops.sessions WHERE session_id=$1 FOR UPDATE`, [root.parent_session_id]);
    const parent = sessionSnapshotSchema.parse(parentResult.rows[0]?.snapshot_json);
    let child: SessionSnapshot | null = null;
    let childEvent: SessionEvent | null = null;
    let dispatch: ReturnType<typeof sessionRuntimeDispatchSchema.parse> | null = null;
    if (successor !== null) {
      if (successor.generation !== 1 || successor.sessionId === request.predecessorSessionId ||
          sha256CanonicalJsonDigest(successor.prompt) !== successor.inputDigest) {
        throw new WorkItemRetryConflictError("retry successor input or generation is invalid");
      }
      const remainingProvider = providerLimit - providerRequests;
      const remainingOutput = outputLimit - outputTokens;
      const identity = { ...priorSnapshot.identity, round: attempt,
        runId: derived.successorLaunchId!, parentSessionId: root.parent_session_id,
        forkedAtCursor: priorSnapshot.eventCursor };
      const limits = { ...priorSnapshot.budget!.limits, providerRequests: remainingProvider,
        outputTokens: remainingOutput };
      child = sessionSnapshotSchema.parse({ version: "codeops.session-snapshot/v1",
        sessionId: successor.sessionId, generation: 1, state: "running", identity,
        lease: { leaseId: successor.leaseId, generation: 1, status: "active",
          holderId: successor.holderId, acquiredAt: createdAt, expiresAt }, checkpoint:
          request.kind === "recover-checkpoint" ? priorSnapshot.checkpoint : null,
        pendingPermission: null, budget: projectSessionBudgetV2({ budgetId: successor.sessionId,
          revision: 1, startedAt: createdAt, observedAt: createdAt, limits }), eventCursor: 1,
        capabilities: sessionCapabilitiesFor("running", request.kind === "recover-checkpoint" && priorSnapshot.checkpoint !== null),
        updatedAt: createdAt });
      if (sha256CanonicalJsonDigest(child.capabilities) !== successor.runtimeCapabilityDigest) {
        throw new WorkItemRetryConflictError("retry runtime capability disposition drifted");
      }
      const childBody = { sessionId: child.sessionId, generation: 1, cursor: 1,
        type: "session_created" as const, action: { type: "fork" as const,
          detail: `Retry attempt ${attempt}` }, occurredAt: createdAt };
      childEvent = sessionEventSchema.parse({ version: "codeops.session-event/v1",
        eventId: eventId(childBody), ...childBody });
      const prompt = { version: "codeops.session-command/v1" as const, sessionId: child.sessionId,
        generation: 1, leaseId: successor.leaseId, idempotencyKey: successor.idempotencyKey,
        type: "prompt" as const, prompt: successor.prompt };
      dispatch = sessionRuntimeDispatchSchema.parse({ ...buildSessionRuntimeDispatch({
        dispatchId: successor.dispatchId, principalId: authority.ownerPrincipalId,
        command: prompt, snapshot: child, dispatchedAt: createdAt }),
        retryAuthority: { dispositionId: request.dispositionId, rootAdmissionId: request.rootAdmissionId,
          attempt, expiresAt, inputDigest: successor.inputDigest, candidateDigest: successor.candidateDigest,
          runtimeCapabilityDigest: successor.runtimeCapabilityDigest, runtimeRelease: successor.runtimeRelease } });
    }

    const supervised = child ?? terminalSnapshot;
    const supervisionBody = { sessionId: parent.sessionId, generation: parent.generation,
      cursor: parent.eventCursor + 1, type: "acp_update" as const,
      update: { kind: "supervision" as const,
        projectionId: deterministicUuid(`retry-supervision\0${request.dispositionId}`),
        childSessionId: supervised.sessionId, childState: supervised.state,
        childEventCursor: supervised.eventCursor, repository: authority.repository,
        workItemId: authority.workItemId, workflowId: authority.workflowId,
        agentRole: "coding" as const, round: attempt }, occurredAt: createdAt };
    const supervisionEvent = sessionEventSchema.parse({ version: "codeops.session-event/v1",
      eventId: eventId(supervisionBody), ...supervisionBody });
    const updatedParent = sessionSnapshotSchema.parse({ ...parent,
      eventCursor: supervisionEvent.cursor, updatedAt: createdAt });

    await client.query(`INSERT INTO codeops.session_events
      (event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,$3,$4,'runtime_terminal',$5::jsonb,NULL,$6::timestamptz)`,
      [terminalEvent.eventId, observation.sessionId, observation.generation, terminalEvent.cursor,
        canonicalJsonText(terminalEvent), observation.observedAt]);
    const lifecycleUpdated = await client.query(`UPDATE codeops.work_item_lifecycle SET attention=$1,sequence=$2,
      source_sha=$3,updated_at=$4::timestamptz WHERE repository=$5 AND provider='plane'
      AND workspace_id=$6 AND project_id=$7 AND work_item_id=$8 AND sequence=$9`,
      [nextAttention, lifecycleSequence, authority.sourceSha, createdAt, authority.repository,
        authority.provider.workspaceId, authority.provider.projectId, authority.workItemId, lifecycleSequence-1]);
    if (lifecycleUpdated.rowCount !== 1) {
      throw new WorkItemRetryConflictError("retry lifecycle compare-and-swap failed");
    }
    await client.query(`INSERT INTO codeops.work_item_lifecycle_events
      (event_id,transition_id,transition_key,repository,provider,workspace_id,project_id,work_item_id,
       workflow_id,run_id,source_sha,sequence,event_digest,event_json,created_at)
      VALUES($1,$2,$3,$4,'plane',$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz)`,
      [lifecycleEvent.eventId,lifecycleEvent.transitionId,lifecycleEvent.transitionKey,authority.repository,
        authority.provider.workspaceId,authority.provider.projectId,authority.workItemId,authority.workflowId,
        authority.runId,authority.sourceSha,lifecycleSequence,sha256CanonicalJsonDigest(lifecycleEvent).slice(7),
        canonicalJsonText(lifecycleEvent),createdAt]);
    await client.query(`INSERT INTO codeops.work_item_lifecycle_publications(event_id,status,available_at)
      VALUES($1,'pending',$2::timestamptz)`, [lifecycleEvent.eventId,createdAt]);
    await client.query(`INSERT INTO codeops.session_events
      (event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,$3,$4,'acp_update',$5::jsonb,NULL,$6::timestamptz)`,
      [supervisionEvent.eventId,parent.sessionId,parent.generation,supervisionEvent.cursor,
        canonicalJsonText(supervisionEvent),createdAt]);
    const parentUpdated = await client.query(`UPDATE codeops.sessions SET snapshot_json=$2::jsonb,updated_at=$3::timestamptz
      WHERE session_id=$1`, [parent.sessionId,canonicalJsonText(updatedParent),createdAt]);
    if (parentUpdated.rowCount !== 1) {
      throw new WorkItemRetryConflictError("retry supervision Session compare-and-swap failed");
    }

    const requestAuthority = { request, predecessorClaim: derived.predecessorClaim,
      runtimeAttestation: derived.runtimeAttestation };
    const dispositionAuthority = { ...request, attempt, terminalEvent, lifecycleEvent,
      supervisionEvent, successorLaunchId: derived.successorLaunchId,
      requestAuthority, createdAt } as const;
    await client.query(`INSERT INTO codeops.work_item_retry_dispositions
      (disposition_id,root_admission_id,lineage_revision,predecessor_admission_id,predecessor_session_id,
       predecessor_generation,predecessor_lease_id,kind,reason_code,effect_state,effect_id,effect_receipt_digest,
       transient_failure_code,pre_effect_proof_digest,terminal_event_id,successor_admission_id,
       successor_session_id,successor_dispatch_id,successor_launch_id,attempt,authority_expires_at,input_digest,candidate_digest,
       runtime_capability_digest,runtime_release,provider_requests_consumed,output_tokens_consumed,
       authority_digest,authority_json,lifecycle_event_id,supervision_event_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::timestamptz,
       $22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31,$32::timestamptz)`,
      [request.dispositionId,request.rootAdmissionId,request.lineageRevision,prior.admission_id,
        request.predecessorSessionId,observation.generation,observation.leaseId,request.kind,request.reasonCode,
        request.providerEffect.state,request.providerEffect.state === "none" ? null : request.providerEffect.effectId,
        request.providerEffect.state === "none" ? null : request.providerEffect.receiptDigest,
        request.providerEffect.state === "failed" ? request.providerEffect.failureCode : null,
        request.providerEffect.state === "none" ? request.providerEffect.preEffectProofDigest : null,
        terminalEvent.eventId,successor?.admissionId ?? null,successor?.sessionId ?? null,
        successor?.dispatchId ?? null,derived.successorLaunchId,attempt,expiresAt,successor?.inputDigest ?? null,
        successor?.candidateDigest ?? null,successor?.runtimeCapabilityDigest ?? null,
        successor?.runtimeRelease ?? null,providerRequests,outputTokens,
        sha256CanonicalJsonDigest(dispositionAuthority),canonicalJsonText(dispositionAuthority),
        lifecycleEvent.eventId,supervisionEvent.eventId,createdAt]);

    if (successor !== null && child !== null && childEvent !== null && dispatch !== null) {
      if (child.budget?.version !== "codeops.session-budget/v2") {
        throw new WorkItemRetryConflictError("retry successor budget projection is invalid");
      }
      await client.query(`INSERT INTO codeops.sessions(session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
        VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`,
        [child.sessionId,successor.leaseId,canonicalJsonText(child),createdAt,authority.ownerPrincipalId]);
      await client.query(`INSERT INTO codeops.session_model_budgets(session_id,budget_id,started_at,
        provider_requests_limit,output_tokens_limit,committed_provider_requests,settled_output_tokens,
        reserved_output_tokens,observed_input_tokens,observed_total_tokens,revision,updated_at)
        VALUES($1,$1,$2::timestamptz,$3,$4,0,0,0,0,0,1,$2::timestamptz)`,
        [child.sessionId,createdAt,child.budget.limits.providerRequests,child.budget.limits.outputTokens]);
      await client.query(`INSERT INTO codeops.session_events
        (event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
        VALUES($1,$2,1,1,'session_created',$3::jsonb,NULL,$4::timestamptz)`,
        [childEvent.eventId,child.sessionId,canonicalJsonText(childEvent),createdAt]);
      const admissionRequest = { admissionId: successor.admissionId,
        workItem: { repository: authority.repository, provider: authority.provider,
          workItemId: authority.workItemId, workflowId: authority.workflowId,
          runId: authority.runId, sourceSha: authority.sourceSha },
        child: { sessionId: child.sessionId, dispatchId: dispatch.dispatchId } };
      const admissionAuthority = { version: "codeops.work-item-admission-authority/v1",
        admissionId: successor.admissionId, approvalId: root.approval_id,
        parentSessionId: root.parent_session_id, childSessionId: child.sessionId,
        dispatchId: dispatch.dispatchId, childEventId: childEvent.eventId,
        repository: authority.repository, provider: authority.provider, workItemId: authority.workItemId,
        workflowId: authority.workflowId, runId: authority.runId, sourceSha: authority.sourceSha,
        lifecycleEventId: lifecycleEvent.eventId, supervisionEventId: supervisionEvent.eventId,
        request: admissionRequest, childSnapshot: child, childEvent, dispatch, lifecycleEvent,
        supervisionEvent, admittedAt: createdAt, retryDispositionId: request.dispositionId };
      await client.query(`INSERT INTO codeops.work_item_admissions(admission_id,approval_id,parent_session_id,
        child_session_id,child_dispatch_id,child_event_id,repository,provider,workspace_id,project_id,
        work_item_id,workflow_id,run_id,source_sha,lifecycle_event_id,supervision_event_id,authority_digest,
        authority_json,admitted_at,root_admission_id,attempt,retry_disposition_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'plane',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
         $18::timestamptz,$19,$20,$21)`,
        [successor.admissionId,root.approval_id,root.parent_session_id,child.sessionId,dispatch.dispatchId,
          childEvent.eventId,authority.repository,authority.provider.workspaceId,authority.provider.projectId,
          authority.workItemId,authority.workflowId,authority.runId,authority.sourceSha,lifecycleEvent.eventId,
          supervisionEvent.eventId,sha256CanonicalJsonDigest(admissionAuthority),canonicalJsonText(admissionAuthority),
          createdAt,request.rootAdmissionId,attempt,request.dispositionId]);
      await client.query(`INSERT INTO codeops.session_runtime_outbox(dispatch_id,session_id,idempotency_key,
        principal_id,dispatch_json,status,available_at,created_at,admission_id,retry_disposition_id)
        VALUES($1,$2,$3,$4,$5::jsonb,'pending',$6::timestamptz,$6::timestamptz,$7,$8)`,
        [dispatch.dispatchId,child.sessionId,successor.idempotencyKey,authority.ownerPrincipalId,
          canonicalJsonText(dispatch),createdAt,successor.admissionId,request.dispositionId]);
      const parentLaunchRequest = workspaceLaunchRequestSchema.parse(derived.parentLaunchRequest);
      const retryLaunchRequest = workspaceLaunchRequestSchema.parse({ ...parentLaunchRequest,
        idempotencyKey: successor.idempotencyKey, prompt: successor.prompt });
      const launch = workspaceLaunchSchema.parse({
        version: "codeops.workspace-launch/v1", launchId: derived.successorLaunchId,
        idempotencyKey: successor.idempotencyKey, principalId: authority.ownerPrincipalId,
        requestDigest: sha256CanonicalJsonDigest(retryLaunchRequest),
        policy: derived.parentIdentity.policy,
        contextAttachments: derived.parentIdentity.contextAttachments ?? [],
        ...(priorSnapshot.identity.displayName === undefined ? {} : { title: priorSnapshot.identity.displayName }),
        promptDigest: sha256CanonicalJsonDigest(successor.prompt),
        workspace: derived.parentIdentity.workspace, state: "queued",
        deadlineAt: expiresAt, attemptCount: 0, createdAt, updatedAt: createdAt,
        retryRuntime: { dispositionId: request.dispositionId, sessionId: child.sessionId,
          workflowId: authority.workflowId, runId: derived.successorLaunchId,
          leaseId: successor.leaseId, promptIdempotencyKey: successor.idempotencyKey,
          runtimeWorkerImage: successor.runtimeRelease },
      });
      await client.query(`INSERT INTO codeops.workspace_launches
        (launch_id,principal_id,idempotency_key,request_digest,request_json,launch_json,state,
         created_at,updated_at,retry_disposition_id,retry_runtime_release)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,$7::timestamptz,$8,$9)`,
        [launch.launchId,launch.principalId,launch.idempotencyKey,launch.requestDigest,
          canonicalJsonText(retryLaunchRequest),canonicalJsonText(launch),createdAt,request.dispositionId,
          successor.runtimeRelease]);
    }
    const updated = await client.query(`UPDATE codeops.sessions SET snapshot_json=$1::jsonb,
      updated_at=$2::timestamptz WHERE session_id=$3 AND generation=$4 AND lease_id=$5`,
      [canonicalJsonText(terminalSnapshot), observation.observedAt, observation.sessionId,
        observation.generation, observation.leaseId]);
    if (updated.rowCount !== 1) throw new WorkItemRetryConflictError("retry terminal Session compare-and-swap failed");
    await client.query(`INSERT INTO codeops.session_runtime_terminal_observations
      (job_uid,session_id,generation,lease_id,run_id,job_resource_version,observation_json,event_id,observed_at)
      VALUES($1,$2,$3,$4,$5,$6::numeric,$7::jsonb,$8,$9::timestamptz)`,
      [observation.job.uid, observation.sessionId, observation.generation, observation.leaseId,
        observation.runId, observation.job.resourceVersion, canonicalJsonText(observation),
        terminalEvent.eventId, observation.observedAt]);
    await client.query("COMMIT");
    return workItemRetryDispositionResultSchema.parse({
      version: "codeops.work-item-retry-disposition-result/v1", dispositionId: request.dispositionId,
      disposition: "created", rootAdmissionId: request.rootAdmissionId, attempt,
      successorSessionId: successor?.sessionId ?? null, successorDispatchId: successor?.dispatchId ?? null,
      lifecycleEventId: lifecycleEvent.eventId, supervisionEventId: supervisionEvent.eventId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
