import { createHash } from "node:crypto";
import {
  admittedChildMaterializationInputSchema,
  admittedChildMaterializationStateSchema,
  canonicalJsonText,
  createEventId,
  createTransitionId,
  sessionCommandResultSchema,
  sessionEventSchema,
  sessionRuntimeCompletionSchema,
  sessionSnapshotSchema,
  workItemLifecycleEventSchema,
  type AdmittedChildMaterializationInput,
  type AdmittedChildMaterializationState,
} from "@codeops/codeops-contracts";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";
import {
  verifyWorkspaceContextAttachments,
  workspaceContextAttachmentDescriptors,
} from "@codeops/codeops-contracts/workspace-context-node";
import {
  assertWorkspaceResources,
  buildWorkspaceResources,
  type WorkspaceResourceConfig,
} from "./workspace-resources.js";
import {
  KubernetesApiError,
  kubernetesIdentityLabel,
  kubernetesResourceConfigurationDigest,
  KubernetesResourceIdentityDriftError,
  isTransientKubernetesError,
} from "./kubernetes.js";

export interface CleanupResidualEvidence {
  readonly reason: "kubernetes-permanent-failure";
  readonly operation: "ensure" | "get-job" | "list-pods" | "get-pod-logs" | "delete" | "recover";
  readonly status: number;
}

export class PermanentAdmittedChildMaterializationError extends Error {
  readonly cleanupResidual?: CleanupResidualEvidence;

  constructor(message: string, options?: ErrorOptions & {
    readonly cleanupResidual?: CleanupResidualEvidence;
  }) {
    super(message, options);
    this.cleanupResidual = options?.cleanupResidual;
  }
}
export class AdmittedChildAuthorityDriftError extends PermanentAdmittedChildMaterializationError {}

export function classifyAdmittedChildKubernetesError(error: unknown): unknown {
  if (error instanceof KubernetesResourceIdentityDriftError) {
    return new PermanentAdmittedChildMaterializationError(error.message, { cause: error });
  }
  if (error instanceof KubernetesApiError && !isTransientKubernetesError(error)) {
    return new PermanentAdmittedChildMaterializationError(error.message, { cause: error,
      cleanupResidual: { reason: "kubernetes-permanent-failure",
        operation: error.operation, status: error.status! } });
  }
  return error;
}

interface StoredMaterialization {
  readonly input: unknown;
  readonly state: unknown;
  readonly inputDigest: string;
  readonly initialDispatchDigest: string;
  readonly authorityCurrent: boolean;
  readonly duplicateOwner: boolean;
}

export interface MaterializationQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface AdmittedChildReconciliationClaim {
  readonly admissionId: string;
  readonly token: string;
}

export async function claimAdmittedChildMaterialization(
  client: MaterializationQueryClient, owner = "test-controller",
  token = "00000000-0000-4000-8000-000000000000", leaseMs = 30_000,
): Promise<AdmittedChildReconciliationClaim | null> {
  const result = await client.query<{ admission_id: string; reconciliation_token: string }>(
    `WITH selected AS (
       SELECT admission_id FROM codeops.admitted_child_materializations
       WHERE state IN
         ('queued','provisioning','runtime-authorized','success-finalizing','cleanup-pending')
         AND (reconciliation_expires_at IS NULL OR reconciliation_expires_at<=CURRENT_TIMESTAMP)
       ORDER BY updated_at,admission_id LIMIT 1 FOR UPDATE SKIP LOCKED
     ), scan_time AS (
       SELECT date_trunc('milliseconds',CURRENT_TIMESTAMP) AS value
     )
     UPDATE codeops.admitted_child_materializations materialization
     SET updated_at=scan_time.value,
         reconciliation_owner=$1,reconciliation_token=$2::uuid,
         reconciliation_expires_at=CURRENT_TIMESTAMP+($3::bigint*interval '1 millisecond'),
         state_json=jsonb_set(materialization.state_json,'{updatedAt}',
           to_jsonb(to_char(scan_time.value AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
     FROM selected,scan_time WHERE materialization.admission_id=selected.admission_id
     RETURNING materialization.admission_id,materialization.reconciliation_token`,
    [owner, token, leaseMs],
  );
  const row = result.rows[0];
  return row === undefined ? null : { admissionId: row.admission_id,
    token: row.reconciliation_token };
}

export async function renewAdmittedChildMaterializationClaim(
  client: MaterializationQueryClient, admissionId: string, owner: string,
  claimToken: string, leaseMs: number,
): Promise<void> {
  const result = await client.query(
    `UPDATE codeops.admitted_child_materializations
     SET reconciliation_expires_at=CURRENT_TIMESTAMP+($4::bigint*interval '1 millisecond')
     WHERE admission_id=$1 AND reconciliation_owner=$2
       AND reconciliation_token=$3::uuid
       AND reconciliation_expires_at>CURRENT_TIMESTAMP
       AND state IN
         ('queued','provisioning','runtime-authorized','success-finalizing','cleanup-pending')`,
    [admissionId, owner, claimToken, leaseMs],
  );
  if (result.rowCount !== 1) {
    throw new AdmittedChildAuthorityDriftError("admitted child reconciliation claim drifted");
  }
}

export async function releaseAdmittedChildMaterializationClaim(
  client: MaterializationQueryClient, admissionId: string, claimToken: string,
): Promise<void> {
  await client.query(
    `UPDATE codeops.admitted_child_materializations
     SET reconciliation_owner=NULL,reconciliation_token=NULL,reconciliation_expires_at=NULL
     WHERE admission_id=$1 AND reconciliation_token=$2::uuid
       AND state IN
         ('queued','provisioning','runtime-authorized','success-finalizing','cleanup-pending')`,
    [admissionId, claimToken],
  );
}

export async function lockAdmittedChildMaterializationAuthority(
  client: MaterializationQueryClient, admissionId: string, inputDigest: string,
  allowedStates: readonly string[],
  claimToken: string,
): Promise<void> {
  const result = await client.query<{ authority_current: boolean }>(
    `SELECT (admission.authority_digest=materialization.admission_digest AND
       approval.authority_digest=materialization.approval_digest AND
       parent.session_id IS NOT NULL AND dispatch.session_id=materialization.child_session_id AND
       dispatch.principal_id=materialization.principal_id AND
       dispatch.admission_id=materialization.admission_id AND
       dispatch.is_admitted_initial_dispatch=true AND
       dispatch.dispatch_digest=materialization.initial_dispatch_digest AND
       dispatch.dispatch_json=materialization.input_json->'initialDispatch' AND
       child.owner_principal_id=materialization.principal_id AND
       child.generation=materialization.generation AND child.lease_id=materialization.lease_id AND
       child.snapshot_json->>'state' IN ('running','waiting_permission','checkpointing') AND
       child.snapshot_json->'lease'->>'status'='active' AND
       child.snapshot_json->'lease'->>'leaseId'=materialization.lease_id::text AND
       (child.snapshot_json->'lease'->>'generation')::bigint=materialization.generation AND
       child.snapshot_json->'lease'->>'holderId'=materialization.input_json#>>'{lease,holderId}' AND
       (child.snapshot_json->'lease'->>'expiresAt')::timestamptz=
         (materialization.input_json#>>'{lease,expiresAt}')::timestamptz AND
       CURRENT_TIMESTAMP < (child.snapshot_json->'lease'->>'expiresAt')::timestamptz
     ) AS authority_current
     FROM codeops.admitted_child_materializations materialization
     JOIN codeops.work_item_admissions admission ON admission.admission_id=materialization.admission_id
     JOIN codeops.project_plan_approvals approval ON approval.approval_id=materialization.approval_id
     JOIN codeops.sessions parent ON parent.session_id=materialization.parent_session_id
     JOIN codeops.sessions child ON child.session_id=materialization.child_session_id
     JOIN codeops.session_runtime_outbox dispatch ON dispatch.dispatch_id=materialization.child_dispatch_id
     WHERE materialization.admission_id=$1 AND materialization.input_digest=$2
       AND materialization.state=ANY($3::text[])
       AND materialization.reconciliation_token=$4::uuid
       AND materialization.reconciliation_expires_at>CURRENT_TIMESTAMP
     FOR UPDATE OF materialization,admission,approval,parent,child,dispatch`,
    [admissionId, inputDigest, allowedStates, claimToken],
  );
  if (result.rowCount !== 1 || result.rows[0]?.authority_current !== true) {
    throw new AdmittedChildAuthorityDriftError("admitted child lease authority drifted");
  }
}

export async function lockAdmittedChildMaterializationLease(
  client: MaterializationQueryClient, admissionId: string, inputDigest: string,
  allowedStates: readonly string[],
  claimToken: string,
): Promise<void> {
  const result = await client.query(
    `SELECT admission_id FROM codeops.admitted_child_materializations
     WHERE admission_id=$1 AND input_digest=$2 AND state=ANY($3::text[])
       AND generation=(input_json->>'generation')::bigint
       AND lease_id=(input_json#>>'{lease,leaseId}')::uuid
       AND reconciliation_token=$4::uuid
       AND reconciliation_expires_at>CURRENT_TIMESTAMP
     FOR UPDATE`,
    [admissionId, inputDigest, allowedStates, claimToken],
  );
  if (result.rowCount !== 1) {
    throw new AdmittedChildAuthorityDriftError("admitted child lease fence drifted");
  }
}

export async function loadAdmittedChildMaterialization(
  client: MaterializationQueryClient, admissionId: string, claimToken?: string,
): Promise<StoredMaterialization | null> {
  const result = await client.query<{
    input_json: unknown; state_json: unknown; input_digest: string;
    initial_dispatch_digest: string;
    authority_current: boolean; duplicate_owner: boolean;
  }>(`SELECT materialization.input_json,materialization.state_json,materialization.input_digest,
      materialization.initial_dispatch_digest,
      (admission.admission_id IS NOT NULL AND approval.approval_id IS NOT NULL AND
       parent.session_id IS NOT NULL AND
       child.session_id IS NOT NULL AND dispatch.dispatch_id IS NOT NULL AND
       admission.authority_digest=materialization.admission_digest AND
       approval.authority_digest=materialization.approval_digest AND
       dispatch.session_id=materialization.child_session_id AND
       dispatch.principal_id=materialization.principal_id AND
       dispatch.admission_id=materialization.admission_id AND
       dispatch.is_admitted_initial_dispatch=true AND
       dispatch.dispatch_digest=materialization.initial_dispatch_digest AND
       dispatch.dispatch_json=materialization.input_json->'initialDispatch' AND
       child.owner_principal_id=materialization.principal_id AND
       child.snapshot_json->>'state' IN ('running','waiting_permission','checkpointing') AND
       child.snapshot_json->'lease'->>'status'='active' AND
       child.snapshot_json->'lease'->>'leaseId'=materialization.lease_id::text AND
       (child.snapshot_json->'lease'->>'generation')::bigint=materialization.generation AND
       child.snapshot_json->'lease'->>'holderId'=materialization.input_json#>>'{lease,holderId}' AND
       (child.snapshot_json->'lease'->>'expiresAt')::timestamptz=
         (materialization.input_json#>>'{lease,expiresAt}')::timestamptz AND
       CURRENT_TIMESTAMP < (child.snapshot_json->'lease'->>'expiresAt')::timestamptz) AS authority_current,
      ((SELECT count(*) FROM codeops.admitted_child_materializations duplicate
        WHERE duplicate.child_session_id=materialization.child_session_id OR
              duplicate.child_dispatch_id=materialization.child_dispatch_id) <> 1) AS duplicate_owner
    FROM codeops.admitted_child_materializations materialization
    LEFT JOIN codeops.work_item_admissions admission ON admission.admission_id=materialization.admission_id
    LEFT JOIN codeops.project_plan_approvals approval ON approval.approval_id=materialization.approval_id
    LEFT JOIN codeops.sessions parent ON parent.session_id=materialization.parent_session_id
    LEFT JOIN codeops.sessions child ON child.session_id=materialization.child_session_id
      AND child.generation=materialization.generation AND child.lease_id=materialization.lease_id
    LEFT JOIN codeops.session_runtime_outbox dispatch ON dispatch.dispatch_id=materialization.child_dispatch_id
    WHERE materialization.admission_id=$1 AND ($2::uuid IS NULL OR
      (materialization.reconciliation_token=$2::uuid AND
       materialization.reconciliation_expires_at>CURRENT_TIMESTAMP))`,
  [admissionId, claimToken ?? null]);
  const row = result.rows[0];
  return row === undefined ? null : { input: row.input_json, state: row.state_json,
    inputDigest: row.input_digest, initialDispatchDigest: row.initial_dispatch_digest,
    authorityCurrent: row.authority_current,
    duplicateOwner: row.duplicate_owner };
}

export async function updateAdmittedChildMaterialization(
  client: MaterializationQueryClient, state: AdmittedChildMaterializationState,
  claimToken: string,
): Promise<AdmittedChildMaterializationState> {
  const result = await client.query<{ state_json: unknown }>(
    `UPDATE codeops.admitted_child_materializations SET state=$2,state_json=$3::jsonb,
       attempt_count=$4,updated_at=$5::timestamptz
      WHERE admission_id=$1 AND input_digest=$6 AND state IN
        ('queued','provisioning','runtime-authorized','success-finalizing','cleanup-pending')
        AND reconciliation_token=$7::uuid
        AND reconciliation_expires_at>CURRENT_TIMESTAMP
      RETURNING state_json`,
    [state.admissionId, state.state, canonicalJsonText(state), state.attemptCount,
      state.updatedAt, state.inputDigest, claimToken]);
  if (result.rowCount !== 1) throw new Error("materialization state compare-and-swap failed");
  return admittedChildMaterializationStateSchema.parse(result.rows[0]!.state_json);
}

export async function failAdmittedChildMaterialization(
  client: MaterializationQueryClient, state: AdmittedChildMaterializationState,
  claimToken: string,
): Promise<AdmittedChildMaterializationState> {
  if (state.state !== "failed") throw new Error("terminal materialization state is required");
  const locked = await client.query<{
    input_json: unknown; snapshot_json: unknown; idempotency_key: string;
    owner_principal_id: string; dispatch_status: string;
    completion_json: unknown; result_json: unknown;
    phase: string; attention: string; sequence: string | number;
  }>(`SELECT materialization.input_json,session.snapshot_json,dispatch.idempotency_key,
       session.owner_principal_id,dispatch.status AS dispatch_status,
       dispatch.completion_json,dispatch.result_json,
       lifecycle.phase,lifecycle.attention,lifecycle.sequence
     FROM codeops.admitted_child_materializations materialization
     JOIN codeops.sessions session ON session.session_id=materialization.child_session_id
     JOIN codeops.session_runtime_outbox dispatch
       ON dispatch.dispatch_id=materialization.child_dispatch_id
      AND dispatch.session_id=materialization.child_session_id
      AND dispatch.principal_id=materialization.principal_id
      AND dispatch.dispatch_digest=materialization.initial_dispatch_digest
      AND dispatch.is_admitted_initial_dispatch=true
      AND dispatch.dispatch_json=materialization.input_json->'initialDispatch'
     JOIN codeops.work_item_lifecycle lifecycle
       ON lifecycle.repository=materialization.repository
      AND lifecycle.provider=materialization.provider
      AND lifecycle.workspace_id=materialization.workspace_id
      AND lifecycle.project_id=materialization.project_id
      AND lifecycle.work_item_id=materialization.work_item_id
      AND lifecycle.workflow_id=materialization.workflow_id
      AND lifecycle.run_id=materialization.run_id
      AND lifecycle.source_sha=materialization.source_sha
     WHERE materialization.admission_id=$1 AND materialization.input_digest=$2
       AND materialization.state='cleanup-pending'
       AND materialization.reconciliation_token=$3::uuid
       AND materialization.reconciliation_expires_at>CURRENT_TIMESTAMP
     FOR UPDATE OF materialization,session,dispatch,lifecycle`,
  [state.admissionId, state.inputDigest, claimToken]);
  if (locked.rowCount !== 1) {
    throw new AdmittedChildAuthorityDriftError("admitted child terminal authority drifted");
  }
  const row = locked.rows[0]!;
  const input = admittedChildMaterializationInputSchema.parse(row.input_json);
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  const activeSession = snapshot.lease?.status === "active" &&
    snapshot.lease.leaseId === input.lease.leaseId &&
    ["running", "waiting_permission", "checkpointing"].includes(snapshot.state);
  const terminalSession = snapshot.lease?.status === "released" &&
    snapshot.lease.leaseId === input.lease.leaseId &&
    ["completed", "failed", "cancelled", "archived"].includes(snapshot.state);
  const lifecycleSequence = Number(row.sequence);
  if (snapshot.generation !== input.generation || row.owner_principal_id !== input.principalId ||
      canonicalJsonText(snapshot.identity) !== canonicalJsonText(input.identity) ||
      (!activeSession && !terminalSession) || !Number.isSafeInteger(lifecycleSequence) ||
      lifecycleSequence < 1 || (lifecycleSequence === 1 &&
        (row.phase !== "in_progress" || row.attention !== "clear")) ||
      !["pending", "claimed", "completed"].includes(row.dispatch_status)) {
    throw new AdmittedChildAuthorityDriftError("admitted child terminal projections drifted");
  }
  const failedAt = state.failedAt;
  const nextSnapshot = activeSession ? sessionSnapshotSchema.parse({ ...snapshot, state: "failed",
    lease: { leaseId: input.lease.leaseId, generation: input.generation,
      status: "released", releasedAt: failedAt }, pendingPermission: null,
    eventCursor: snapshot.eventCursor + 1,
    capabilities: sessionCapabilitiesFor("failed", snapshot.checkpoint !== null), updatedAt: failedAt }) :
    snapshot;
  const eventBody = { sessionId: input.childSessionId, generation: input.generation,
    cursor: nextSnapshot.eventCursor, type: "state_changed" as const, occurredAt: failedAt };
  const event = sessionEventSchema.parse({ version: "codeops.session-event/v1",
    eventId: digest(eventBody), ...eventBody });
  const completion = sessionRuntimeCompletionSchema.parse({
    version: "codeops.session-runtime-completion/v1", dispatchId: input.childDispatchId,
    sessionId: input.childSessionId, generation: input.generation, leaseId: input.lease.leaseId,
    idempotencyKey: row.idempotency_key, observedEventCursor: snapshot.eventCursor,
    completedAt: failedAt, type: "prompt", material: { response: "", stopReason: "cancelled" },
  });
  const result = sessionCommandResultSchema.parse({ version: "codeops.session-command-result/v1",
    commandId: input.childDispatchId, sessionId: input.childSessionId,
    generation: input.generation, leaseId: input.lease.leaseId,
    idempotencyKey: row.idempotency_key, type: "prompt", eventCursor: nextSnapshot.eventCursor,
    snapshot: nextSnapshot, committedAt: failedAt, disposition: "rejected",
    rejectionCode: "invalid_state", reason: `Materialization failed: ${state.failureCode}.` });
  const transitionKey = `materialization-failed:${state.admissionId}`;
  const transitionId = createTransitionId({ workflowId: input.workflowId, transitionKey,
    version: "codeops.work-item-lifecycle-event/v1" });
  const lifecycle = workItemLifecycleEventSchema.parse({
    version: "codeops.work-item-lifecycle-event/v1",
    eventId: createEventId({ workflowId: input.workflowId, transitionId,
      version: "codeops.work-item-lifecycle-event/v1" }), transitionId, transitionKey,
    command: "cancel", repository: (() => { const [owner, name] = input.workItem.repository.split("/");
      return { owner, name }; })(), provider: input.workItem.provider,
    workItemId: input.workItem.workItemId, workflowId: input.workflowId, runId: input.runId,
    sequence: 2, previousState: { phase: "in_progress", attention: "clear" },
    state: { phase: "cancelled", attention: "clear" }, sourceSha: input.workItem.sourceSha,
    occurredAt: failedAt, summary: `Materialization failed: ${state.failureCode}.`, evidence: [],
  });
  if (activeSession) {
    await client.query(`INSERT INTO codeops.session_events
      (event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,$3,$4,'state_changed',$5::jsonb,NULL,$6::timestamptz)`,
    [event.eventId, event.sessionId, event.generation, event.cursor, canonicalJsonText(event), failedAt]);
    const sessionUpdate = await client.query(`UPDATE codeops.sessions SET snapshot_json=$1::jsonb,
      updated_at=$2::timestamptz WHERE session_id=$3 AND generation=$4 AND lease_id=$5
        AND snapshot_json=$6::jsonb`,
    [canonicalJsonText(nextSnapshot), failedAt, input.childSessionId, input.generation,
      input.lease.leaseId, canonicalJsonText(snapshot)]);
    if (sessionUpdate.rowCount !== 1) throw new Error("admitted child terminal Session compare-and-swap failed");
  }
  if (row.dispatch_status !== "completed") {
    const dispatchUpdate = await client.query(`UPDATE codeops.session_runtime_outbox SET status='completed',
      claim_token=NULL,claimed_by=NULL,claimed_at=NULL,claim_expires_at=NULL,
      completion_json=$1::jsonb,result_json=$2::jsonb,completed_by=$3,completed_at=$4::timestamptz
      WHERE dispatch_id=$5 AND status IN ('pending','claimed')`,
    [canonicalJsonText(completion), canonicalJsonText(result), `materializer:${state.admissionId}`,
      failedAt, input.childDispatchId]);
    if (dispatchUpdate.rowCount !== 1) throw new Error("admitted child terminal dispatch compare-and-swap failed");
  } else {
    const priorCompletion = sessionRuntimeCompletionSchema.safeParse(row.completion_json);
    const priorResult = sessionCommandResultSchema.safeParse(row.result_json);
    if (!priorCompletion.success || !priorResult.success ||
        priorCompletion.data.dispatchId !== input.childDispatchId ||
        priorCompletion.data.sessionId !== input.childSessionId ||
        priorCompletion.data.generation !== input.generation ||
        priorCompletion.data.leaseId !== input.lease.leaseId ||
        priorCompletion.data.idempotencyKey !== row.idempotency_key ||
        priorResult.data.commandId !== input.childDispatchId ||
        priorResult.data.sessionId !== input.childSessionId ||
        priorResult.data.generation !== input.generation ||
        priorResult.data.leaseId !== input.lease.leaseId ||
        priorResult.data.idempotencyKey !== row.idempotency_key ||
        canonicalJsonText(priorResult.data.snapshot.identity) !== canonicalJsonText(input.identity)) {
      throw new AdmittedChildAuthorityDriftError("completed admitted child dispatch identity drifted");
    }
  }
  if (lifecycleSequence === 1) {
    const lifecycleUpdate = await client.query(`UPDATE codeops.work_item_lifecycle
      SET phase='cancelled',attention='clear',sequence=2,updated_at=$1::timestamptz
      WHERE repository=$2 AND provider='plane' AND workspace_id=$3 AND project_id=$4
        AND work_item_id=$5 AND workflow_id=$6 AND run_id=$7 AND source_sha=$8
        AND phase='in_progress' AND attention='clear' AND sequence=1`,
    [failedAt, input.workItem.repository, input.workItem.provider.workspaceId,
      input.workItem.provider.projectId, input.workItem.workItemId, input.workflowId,
      input.runId, input.workItem.sourceSha]);
    if (lifecycleUpdate.rowCount !== 1) throw new Error("admitted child work-item compare-and-swap failed");
    await client.query(`INSERT INTO codeops.work_item_lifecycle_events
    (event_id,transition_id,transition_key,repository,provider,workspace_id,project_id,work_item_id,
     workflow_id,run_id,source_sha,sequence,event_digest,event_json,created_at)
    VALUES($1,$2,$3,$4,'plane',$5,$6,$7,$8,$9,$10,2,$11,$12::jsonb,$13::timestamptz)`,
  [lifecycle.eventId, lifecycle.transitionId, lifecycle.transitionKey, input.workItem.repository,
    input.workItem.provider.workspaceId, input.workItem.provider.projectId, input.workItem.workItemId,
    input.workflowId, input.runId, input.workItem.sourceSha,
    createHash("sha256").update(canonicalJsonText(lifecycle)).digest("hex"),
    canonicalJsonText(lifecycle), failedAt]);
    await client.query(`INSERT INTO codeops.work_item_lifecycle_publications(event_id,status,available_at)
      VALUES($1,'pending',$2::timestamptz)`, [lifecycle.eventId, failedAt]);
  }
  return updateAdmittedChildMaterialization(client, state, claimToken);
}

export interface AdmittedChildMaterializationDependencies {
  readonly load: (admissionId: string) => Promise<StoredMaterialization | null>;
  readonly update: (state: AdmittedChildMaterializationState) => Promise<AdmittedChildMaterializationState>;
  readonly ensureResource: (resource: Record<string, unknown>, digest: string,
    expectedUid: string | undefined, allowedStates: readonly string[],
    expectedConfigDigest?: string) =>
      Promise<{ readonly uid: string; readonly configDigest: string }>;
  readonly loadJob: (resource: Record<string, unknown>, digest: string,
    binding: { readonly uid: string; readonly configDigest: string },
    allowedStates: readonly string[]) =>
    Promise<Record<string, unknown>>;
  readonly listRuntimePods: (runId: string, digest: string, allowedStates: readonly string[]) =>
    Promise<readonly Record<string, unknown>[]>;
  readonly removeResource: (resource: Record<string, unknown>, digest: string,
    expectedUid: string, expectedConfigDigest: string,
    allowedStates: readonly string[]) => Promise<void>;
  readonly recoverResource: (resource: Record<string, unknown>, digest: string,
    allowedStates: readonly string[]) =>
      Promise<{ readonly uid: string; readonly configDigest: string;
        readonly resourceName?: string; readonly matchesExpectedConfiguration: boolean;
        readonly desiredConfigDigest?: string } | null>;
  readonly readResourceUid: (resource: Record<string, unknown>, digest: string,
    allowedStates: readonly string[]) => Promise<string | null>;
  readonly markReady: (state: AdmittedChildMaterializationState) =>
    Promise<AdmittedChildMaterializationState>;
  readonly markSuccessFinalizing: (state: AdmittedChildMaterializationState) =>
    Promise<AdmittedChildMaterializationState>;
  readonly markFailed: (state: AdmittedChildMaterializationState) =>
    Promise<AdmittedChildMaterializationState>;
  readonly resourceConfig: (input: AdmittedChildMaterializationInput) => WorkspaceResourceConfig;
  readonly cleanupResources: (input: AdmittedChildMaterializationInput,
    digest: string) => readonly Record<string, unknown>[];
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonText(value)).digest("hex")}`;
}

function role(resource: Record<string, unknown>): string | undefined {
  return ((resource.metadata as { labels?: Record<string, string> })?.labels ?? {})[
    "codeops.example/resource-role"
  ];
}

function name(resource: Record<string, unknown>): string {
  return (resource.metadata as { name: string }).name;
}

function failed(job: Record<string, unknown>): boolean {
  const status = job.status as { failed?: number; conditions?: { type?: string; status?: string }[] } | undefined;
  return (status?.failed ?? 0) > 0 || status?.conditions?.some((item) =>
    item.type === "Failed" && item.status === "True") === true;
}

function complete(job: Record<string, unknown>): boolean {
  const status = job.status as { succeeded?: number; conditions?: { type?: string; status?: string }[] } | undefined;
  return (status?.succeeded ?? 0) > 0 || status?.conditions?.some((item) =>
    item.type === "Complete" && item.status === "True") === true;
}

class TerminalAdmittedChildRuntimeError extends PermanentAdmittedChildMaterializationError {}

function runtimePodPermanentlyUnready(input: AdmittedChildMaterializationInput,
  runtime: Record<string, unknown>, runtimeUid: string,
  pod: Record<string, unknown>): boolean {
  const metadata = pod.metadata as { labels?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string; uid?: string; controller?: boolean }[] } | undefined;
  const status = pod.status as { phase?: string;
    containerStatuses?: { name?: string; state?: { terminated?: unknown } }[] } | undefined;
  const owned = metadata?.labels?.["job-name"] === name(runtime) &&
    metadata.labels["codeops.example/session-id"] === kubernetesIdentityLabel(input.childSessionId) &&
    metadata.labels["codeops.example/run-id"] === kubernetesIdentityLabel(input.runId) &&
    metadata.ownerReferences?.some((owner) => owner.kind === "Job" &&
      owner.name === name(runtime) && owner.uid === runtimeUid && owner.controller === true) === true;
  return owned && (["Failed", "Succeeded"].includes(status?.phase ?? "") ||
    status?.containerStatuses?.some((container) => container.name === "runtime-worker" &&
      container.state?.terminated !== undefined) === true);
}

type ResourceKey = "sourceAuthority" | "workspaceStorage" |
  "sourceMaterializer" | "workspaceRuntime";

function resourceKey(resource: Record<string, unknown>): ResourceKey {
  const keys: Record<string, ResourceKey> = {
    "source-authority": "sourceAuthority",
    "workspace-storage": "workspaceStorage",
    "source-materializer": "sourceMaterializer",
    "workspace-runtime": "workspaceRuntime",
  };
  const key = keys[role(resource) ?? ""];
  if (key === undefined) throw new Error("admitted child resource role is invalid");
  return key;
}

function runtimePodReady(input: AdmittedChildMaterializationInput,
  runtime: Record<string, unknown>, runtimeUid: string,
  pod: Record<string, unknown>): boolean {
  const metadata = pod.metadata as { labels?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string; uid?: string; controller?: boolean }[] } | undefined;
  const status = pod.status as { conditions?: { type?: string; status?: string }[];
    containerStatuses?: { name?: string; ready?: boolean; state?: unknown }[] } | undefined;
  return metadata?.labels?.["job-name"] === name(runtime) &&
    metadata.labels["codeops.example/session-id"] ===
      kubernetesIdentityLabel(input.childSessionId) &&
    metadata.labels["codeops.example/run-id"] === kubernetesIdentityLabel(input.runId) &&
    metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.name === name(runtime) &&
      owner.uid === runtimeUid && owner.controller === true) === true &&
    status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") === true &&
    status.containerStatuses?.some((container) =>
      container.name === "runtime-worker" && container.ready === true) === true;
}

export async function reconcileAdmittedChildMaterialization(
  admissionId: string,
  dependencies: AdmittedChildMaterializationDependencies,
): Promise<AdmittedChildMaterializationState | null> {
  const stored = await dependencies.load(admissionId);
  if (stored === null) return null;
  const input = admittedChildMaterializationInputSchema.parse(stored.input);
  if (stored.inputDigest !== `sha256:${createHash("sha256")
      .update(canonicalJsonText(input)).digest("hex")}` ||
      stored.initialDispatchDigest !== `sha256:${createHash("sha256")
        .update(canonicalJsonText(input.initialDispatch)).digest("hex")}`) {
    throw new AdmittedChildAuthorityDriftError(
      "admitted child materialization digest drifted",
    );
  }
  let state = admittedChildMaterializationStateSchema.parse(stored.state);
  if (state.state === "ready" || state.state === "failed") return state;
  const now = (dependencies.now ?? (() => new Date()))();
  const nextState = (value: Record<string, unknown>) =>
    admittedChildMaterializationStateSchema.parse({
      version: "codeops.admitted-child-materialization-state/v1", admissionId,
      inputDigest: stored.inputDigest, attemptCount: Math.min(100_000, state.attemptCount + 1),
      createdAt: state.createdAt, updatedAt: now.toISOString(), resources: state.resources,
      ...(state.resourceReplacements === undefined ? {} : {
        resourceReplacements: state.resourceReplacements,
      }), ...value,
    });
  const persist = async (value: Record<string, unknown>) => {
    state = await dependencies.update(nextState(value));
    return state;
  };

  const cleanupResources = dependencies.cleanupResources(input, stored.inputDigest);
  const cleanupSecret = cleanupResources.find((item) => role(item) === "source-authority");
  let secret = cleanupSecret;
  let materializer = cleanupResources.find((item) => role(item) === "source-materializer");
  const runtimeIdentity = cleanupResources.find((item) => role(item) === "workspace-runtime");
  if (cleanupSecret === undefined || materializer === undefined || runtimeIdentity === undefined) {
    throw new Error("admitted child cleanup resource identity is incomplete");
  }
  type FailureCode = "authority-drift" | "identity-conflict" | "resource-configuration" |
    "source-unavailable" | "provisioning-failed" | "provisioning-timeout";
  const terminate = async (failureCode: FailureCode, failedAt = now.toISOString()) => {
    const cleanupResiduals: ({ resourceRole: "source-authority" | "source-materializer" |
      "workspace-runtime"; reason: "immutable-identity-drift" } | ({
        resourceRole: "source-authority" | "source-materializer" | "workspace-runtime";
      } & CleanupResidualEvidence))[] =
      "cleanupResiduals" in state ? [...(state.cleanupResiduals ?? [])] : [];
    const recordResidual = (resource: Record<string, unknown>,
      error: PermanentAdmittedChildMaterializationError) => {
      const resourceRole = role(resource);
      if (resourceRole !== "source-authority" && resourceRole !== "source-materializer" &&
          resourceRole !== "workspace-runtime") {
        throw new Error("cleanup residual resource role is invalid");
      }
      if (!cleanupResiduals.some((item) => item.resourceRole === resourceRole)) {
        cleanupResiduals.push(error.cleanupResidual === undefined
          ? { resourceRole, reason: "immutable-identity-drift" }
          : { resourceRole, ...error.cleanupResidual });
      }
    };
    const pending = () => ({ state: "cleanup-pending", failureCode, failedAt,
      ...(cleanupResiduals.length === 0 ? {} : { cleanupResiduals }) });
    if (state.state !== "cleanup-pending") {
      await persist(pending());
    }
    let transientFailure: unknown;
    for (const resource of [runtimeIdentity, cleanupSecret, materializer]) {
      const key = resourceKey(resource!);
      if (state.resources[key] === undefined) {
        try {
          const recovered = await dependencies.recoverResource(
            resource!, stored.inputDigest, ["cleanup-pending"]);
          if (recovered !== null) {
            const { matchesExpectedConfiguration: _matches, ...binding } = recovered;
            await persist({ ...pending(),
              resources: { ...state.resources, [key]: binding } });
          }
        } catch (error) {
          if (error instanceof PermanentAdmittedChildMaterializationError) {
            recordResidual(resource!, error);
          } else {
            transientFailure ??= error;
          }
        }
      }
      const binding = state.resources[key];
      if (binding === undefined) continue;
      const target = binding.resourceName === undefined ? resource! : { ...resource!,
        metadata: { ...(resource!.metadata as Record<string, unknown>),
          name: binding.resourceName } };
      try {
        await dependencies.removeResource(target, stored.inputDigest,
          binding.uid, binding.configDigest, ["cleanup-pending"]);
      } catch (error) {
        if (error instanceof PermanentAdmittedChildMaterializationError) {
          recordResidual(resource!, error);
        } else {
          transientFailure ??= error;
        }
      }
    }
    if (transientFailure !== undefined) {
      await persist(pending());
      throw transientFailure;
    }
    const terminal = nextState({ state: "failed", failureCode, failedAt,
      ...(cleanupResiduals.length === 0 ? {} : { cleanupResiduals }) });
    state = await dependencies.markFailed(terminal);
    return state;
  };
  if (state.state === "cleanup-pending") {
    return terminate(state.failureCode, state.failedAt);
  }

  const handleSuccessFinalizationError = async (error: unknown, finalizingAt: string) => {
    if (error instanceof TerminalAdmittedChildRuntimeError) {
      return terminate("provisioning-failed");
    }
    if (error instanceof AdmittedChildAuthorityDriftError) {
      return terminate("authority-drift");
    }
    if (error instanceof PermanentAdmittedChildMaterializationError) {
      return terminate("identity-conflict");
    }
    if (now.getTime() >= Date.parse(input.admittedAt) +
        (dependencies.timeoutMs ?? 1_800_000)) {
      return terminate("provisioning-timeout");
    }
    return persist({ state: "success-finalizing", finalizingAt });
  };

  const finalizeSuccess = async () => {
    const sourceAuthority = state.resources.sourceAuthority;
    const sourceMaterializer = state.resources.sourceMaterializer;
    if (sourceAuthority === undefined || sourceMaterializer === undefined) {
      throw new PermanentAdmittedChildMaterializationError(
        "success cleanup requires persisted Kubernetes resource bindings",
      );
    }
    const runtimeBinding = state.resources.workspaceRuntime;
    if (runtimeBinding === undefined) {
      throw new PermanentAdmittedChildMaterializationError(
        "success cleanup requires a persisted runtime binding",
      );
    }
    const fenceRuntimeReady = async () => {
      const runtimeJob = await dependencies.loadJob(
        runtimeIdentity, stored.inputDigest, runtimeBinding, ["success-finalizing"]);
      if (failed(runtimeJob) || complete(runtimeJob)) {
        throw new TerminalAdmittedChildRuntimeError("runtime Job is terminal");
      }
      const pods = await dependencies.listRuntimePods(
        input.runId, stored.inputDigest, ["success-finalizing"]);
      if (!pods.some((pod) => runtimePodReady(input, runtimeIdentity, runtimeBinding.uid, pod))) {
        if (pods.some((pod) => runtimePodPermanentlyUnready(
          input, runtimeIdentity, runtimeBinding.uid, pod))) {
          throw new TerminalAdmittedChildRuntimeError("runtime Pod is permanently unready");
        }
        throw new Error("runtime Pod is temporarily not ready");
      }
    };
    await dependencies.removeResource(cleanupSecret, stored.inputDigest,
      sourceAuthority.uid, sourceAuthority.configDigest, ["success-finalizing"]);
    await fenceRuntimeReady();
    await dependencies.removeResource(materializer!, stored.inputDigest,
      sourceMaterializer.uid, sourceMaterializer.configDigest, ["success-finalizing"]);
    await fenceRuntimeReady();
    await fenceRuntimeReady();
    return dependencies.markReady(nextState({ state: "ready", readyAt: now.toISOString() }));
  };
  if (state.state === "success-finalizing") {
    const finalizingAt = state.finalizingAt;
    try {
      state = await finalizeSuccess();
      return state;
    } catch (error) {
      return handleSuccessFinalizationError(error, finalizingAt);
    }
  }

  let resources: readonly Record<string, unknown>[];
  try {
    const config = dependencies.resourceConfig(input);
    resources = buildWorkspaceResources(config);
    assertWorkspaceResources(resources, config.modelProxyServiceName);
    secret = resources.find((item) => role(item) === "source-authority");
    materializer = resources.find((item) => role(item) === "source-materializer");
    if (secret === undefined || materializer === undefined) {
      throw new Error("admitted child bootstrap resource identity is incomplete");
    }
  } catch (error) {
    return terminate("resource-configuration");
  }
  const pvc = resources.find((item) => role(item) === "workspace-storage")!;
  const runtime = resources.find((item) => role(item) === "workspace-runtime")!;
  const continueSecretReplacement = async (allowedStates: readonly string[]) => {
    const replacement = state.resourceReplacements?.sourceAuthority;
    if (replacement === undefined) return undefined;
    const oldBinding = state.resources.sourceAuthority;
    if (secret?.kind !== "Secret" || oldBinding === undefined ||
        oldBinding.uid !== replacement.uid ||
        oldBinding.configDigest !== replacement.configDigest ||
        (oldBinding.resourceName ?? name(secret)) !== replacement.resourceName) {
      throw new PermanentAdmittedChildMaterializationError(
        "durable admitted child Secret replacement binding drifted",
      );
    }
    const oldResource = { ...cleanupSecret, metadata: {
      ...(cleanupSecret!.metadata as Record<string, unknown>),
      name: replacement.resourceName,
    } };
    let observedUid = await dependencies.readResourceUid(
      oldResource, stored.inputDigest, allowedStates,
    );
    if (observedUid === replacement.uid) {
      await dependencies.removeResource(oldResource, stored.inputDigest,
        replacement.uid, replacement.configDigest, allowedStates);
      observedUid = await dependencies.readResourceUid(
        oldResource, stored.inputDigest, allowedStates,
      );
      if (observedUid === replacement.uid) {
        throw new Error("admitted child Secret replacement deletion is still pending");
      }
    }
    if (observedUid !== null && replacement.resourceName !== name(secret)) {
      throw new PermanentAdmittedChildMaterializationError(
        "admitted child Secret replacement encountered a stale identity",
      );
    }
    const recovered = await dependencies.recoverResource(
      secret, stored.inputDigest, allowedStates,
    );
    let binding: { readonly uid: string; readonly configDigest: string };
    if (recovered === null) {
      if (observedUid !== null) {
        throw new PermanentAdmittedChildMaterializationError(
          "admitted child Secret replacement identity is not recoverable",
        );
      }
      binding = await dependencies.ensureResource(secret, stored.inputDigest,
        undefined, allowedStates, replacement.desiredConfigDigest);
    } else {
      const { matchesExpectedConfiguration, resourceName, desiredConfigDigest,
        ...recoveredBinding } = recovered;
      if (!matchesExpectedConfiguration || resourceName !== undefined ||
          desiredConfigDigest !== replacement.desiredConfigDigest ||
          recoveredBinding.configDigest !== replacement.desiredConfigDigest ||
          (observedUid !== null && observedUid !== recoveredBinding.uid)) {
        throw new PermanentAdmittedChildMaterializationError(
          "recreated admitted child Secret configuration drifted",
        );
      }
      binding = recoveredBinding;
    }
    if (binding.configDigest !== replacement.desiredConfigDigest) {
      throw new PermanentAdmittedChildMaterializationError(
        "recreated admitted child Secret digest drifted",
      );
    }
    const replacements = { ...(state.resourceReplacements ?? {}) };
    delete replacements.sourceAuthority;
    const resourceBindings = { ...state.resources, sourceAuthority: binding };
    state = admittedChildMaterializationStateSchema.parse({ ...state,
      resources: resourceBindings, resourceReplacements: replacements });
    await persist({ state: state.state, resources: resourceBindings,
      resourceReplacements: replacements });
    return binding;
  };
  const validatePersisted = async (resource: Record<string, unknown>, key: ResourceKey,
    allowedStates: readonly string[]) => {
    const binding = state.resources[key];
    if (binding === undefined || (key !== "sourceAuthority" && binding.configDigest !==
        kubernetesResourceConfigurationDigest(resource as never))) {
      throw new PermanentAdmittedChildMaterializationError(
        "persisted Kubernetes resource binding is incomplete or drifted",
      );
    }
    // The Kubernetes client verifies the observed Secret against the durable,
    // keyed proof. Reconstructing rotated credentials is neither necessary nor
    // sufficient to prove the original immutable payload.
    const validationResource = key === "sourceAuthority" ? cleanupSecret : resource;
    const validated = await dependencies.ensureResource(
      validationResource, stored.inputDigest, binding.uid, allowedStates, binding.configDigest,
    );
    if (validated.uid !== binding.uid || validated.configDigest !== binding.configDigest) {
      throw new PermanentAdmittedChildMaterializationError(
        "persisted Kubernetes resource binding drifted",
      );
    }
    return binding;
  };
  try {
    let attachments;
    try { attachments = verifyWorkspaceContextAttachments(input.contextAttachments); }
    catch { return terminate("authority-drift"); }
    const snapshotIdentity = input.initialDispatch.snapshot.identity;
    if (digest(input) !== stored.inputDigest || input.admissionId !== admissionId ||
        !stored.authorityCurrent || stored.duplicateOwner ||
        now.getTime() >= Date.parse(input.lease.expiresAt) ||
        !("contextAttachments" in snapshotIdentity) ||
        canonicalJsonText(workspaceContextAttachmentDescriptors(attachments)) !==
          canonicalJsonText(snapshotIdentity.contextAttachments ?? [])) {
      return terminate("authority-drift");
    }
    if (now.getTime() >= Date.parse(input.admittedAt) + (dependencies.timeoutMs ?? 1_800_000)) {
      return terminate("provisioning-timeout");
    }
    if (state.state === "queued") {
      await continueSecretReplacement(["queued"]);
      for (const resource of [secret, pvc, materializer]) {
        const key = resourceKey(resource);
        const expectedConfigDigest = key === "sourceAuthority" ? undefined :
          kubernetesResourceConfigurationDigest(resource as never);
        let expected = state.resources[key];
        if (expected !== undefined && key !== "sourceAuthority" &&
            expected.configDigest !== expectedConfigDigest) {
          return terminate("resource-configuration");
        }
        if (expected === undefined) {
          const recovered = await dependencies.recoverResource(
            resource, stored.inputDigest, ["queued"],
          );
          if (recovered !== null) {
            const { matchesExpectedConfiguration, desiredConfigDigest, ...binding } = recovered;
            const resourceBindings = { ...state.resources, [key]: binding };
            expected = binding;
            if (!matchesExpectedConfiguration) {
              if (key !== "sourceAuthority") {
                throw new PermanentAdmittedChildMaterializationError(
                  "recovered Kubernetes resource configuration drifted");
              }
              if (desiredConfigDigest === undefined) {
                throw new PermanentAdmittedChildMaterializationError(
                  "admitted child Secret replacement proof is missing",
                );
              }
              const replacement = { ...binding,
                resourceName: binding.resourceName ?? name(secret), desiredConfigDigest };
              state = admittedChildMaterializationStateSchema.parse({
                ...state, resources: resourceBindings,
                resourceReplacements: { ...(state.resourceReplacements ?? {}),
                  sourceAuthority: replacement },
              });
              await persist({ state: "queued", resources: resourceBindings,
                resourceReplacements: state.resourceReplacements });
              await continueSecretReplacement(["queued"]);
              continue;
            }
            state = admittedChildMaterializationStateSchema.parse({
              ...state, resources: resourceBindings,
            });
            await persist({ state: "queued", resources: resourceBindings });
          }
        }
        const ensureTarget = key === "sourceAuthority" && expected !== undefined
          ? cleanupSecret : resource;
        const binding = await dependencies.ensureResource(ensureTarget, stored.inputDigest,
          expected?.uid, ["queued"], expected?.configDigest);
        if (expected !== undefined && (binding.uid !== expected.uid ||
            binding.configDigest !== expected.configDigest)) {
          throw new PermanentAdmittedChildMaterializationError(
            "persisted Kubernetes resource binding drifted");
        }
        if (expected === undefined && key !== "sourceAuthority" &&
            binding.configDigest !== expectedConfigDigest) {
          throw new PermanentAdmittedChildMaterializationError(
            "Kubernetes resource configuration digest drifted");
        }
        const resourceBindings = { ...state.resources, [key]: binding };
        state = admittedChildMaterializationStateSchema.parse({
          ...state, resources: resourceBindings,
        });
        await persist({ state: "queued", resources: resourceBindings });
      }
      await persist({ state: "provisioning" });
    }
    if (state.state === "provisioning") {
      await validatePersisted(secret, "sourceAuthority", ["provisioning"]);
      await validatePersisted(pvc, "workspaceStorage", ["provisioning"]);
      const materializerBinding = await validatePersisted(
        materializer, "sourceMaterializer", ["provisioning"],
      );
      const materializerJob = await dependencies.loadJob(
        materializer, stored.inputDigest, materializerBinding, ["provisioning"]);
      if (failed(materializerJob)) return terminate("provisioning-failed");
      if (!complete(materializerJob)) return persist({ state: "provisioning" });
      await persist({ state: "runtime-authorized" });
    }
    if (state.state === "runtime-authorized") {
      await validatePersisted(secret, "sourceAuthority", ["runtime-authorized"]);
      await validatePersisted(pvc, "workspaceStorage", ["runtime-authorized"]);
      await validatePersisted(materializer, "sourceMaterializer", ["runtime-authorized"]);
      const expectedConfigDigest = kubernetesResourceConfigurationDigest(runtime as never);
      const expected = state.resources.workspaceRuntime;
      if (expected !== undefined && expected.configDigest !== expectedConfigDigest) {
        return terminate("resource-configuration");
      }
      const binding = await dependencies.ensureResource(runtime, stored.inputDigest,
        expected?.uid, ["runtime-authorized"], expected?.configDigest);
      if ((expected !== undefined && (binding.uid !== expected.uid ||
          binding.configDigest !== expected.configDigest)) ||
          binding.configDigest !== expectedConfigDigest) {
        throw new PermanentAdmittedChildMaterializationError(
          "Kubernetes runtime configuration digest drifted");
      }
      if (expected === undefined) {
        const resourceBindings = { ...state.resources, workspaceRuntime: binding };
        state = admittedChildMaterializationStateSchema.parse({
          ...state, resources: resourceBindings,
        });
        await persist({ state: "runtime-authorized",
          resources: resourceBindings });
      }
      const runtimeBinding = await validatePersisted(
        runtime, "workspaceRuntime", ["runtime-authorized"],
      );
      const runtimeJob = await dependencies.loadJob(
        runtime, stored.inputDigest, runtimeBinding, ["runtime-authorized"]);
      if (failed(runtimeJob) || complete(runtimeJob)) return terminate("provisioning-failed");
      const pods = await dependencies.listRuntimePods(
        input.runId, stored.inputDigest, ["runtime-authorized"]);
      if (!pods.some((pod) => runtimePodReady(input, runtime, runtimeBinding.uid, pod))) {
        if (pods.some((pod) => runtimePodPermanentlyUnready(
          input, runtime, runtimeBinding.uid, pod))) {
          return terminate("provisioning-failed");
        }
        return persist({ state: "runtime-authorized" });
      }
      state = await dependencies.markSuccessFinalizing(nextState({
        state: "success-finalizing", finalizingAt: now.toISOString(),
      }));
    }
    state = await finalizeSuccess();
    return state;
  } catch (error) {
    if (state.state === "success-finalizing") {
      return handleSuccessFinalizationError(error, state.finalizingAt);
    }
    if (error instanceof AdmittedChildAuthorityDriftError) {
      return terminate("authority-drift");
    }
    if (error instanceof PermanentAdmittedChildMaterializationError) {
      return terminate("identity-conflict");
    }
    return persist({ state: state.state });
  }
}
