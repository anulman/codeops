import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  createEventId,
  createTransitionId,
  isWorkspaceSessionIdentity,
  projectSessionBudgetV2,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionEventSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionSnapshotSchema,
  sha256CanonicalJsonDigest,
  workItemAdmissionRequestSchema,
  workItemAdmissionResultSchema,
  workItemLifecycleEventSchema,
  type SessionEvent,
  type SessionSnapshot,
  type WorkItemAdmissionResult,
} from "@codeops/codeops-contracts";
import {
  ClaimedDispatchAuthorityConflictError,
  selectClaimedWorkspaceSource,
  validateClaimedDispatchAuthority,
} from "./claimed-dispatch-authority.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { buildSessionRuntimeDispatch } from "./session-broker-runtime.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";

export class WorkItemAdmissionNotFoundError extends Error {}
export class WorkItemAdmissionConflictError extends Error {}
export class WorkItemAdmissionDuplicateError extends WorkItemAdmissionConflictError {}
interface Row extends Record<string, unknown> {}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function postgresTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new WorkItemAdmissionConflictError("stored admission time is invalid");
  return parsed.toISOString();
}

function withoutClaimToken<T extends { readonly claimToken: string }>(value: T) {
  const { claimToken: _claimToken, ...authority } = value;
  return authority;
}

function exact(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJsonText(actual) !== canonicalJsonText(expected)) throw new WorkItemAdmissionConflictError(message);
}

function identityOf(workItem: {
  readonly repository: string;
  readonly provider: { readonly kind: "plane"; readonly workspaceId: string; readonly projectId: string };
  readonly workItemId: string;
}) {
  return { repository: workItem.repository, provider: workItem.provider, workItemId: workItem.workItemId } as const;
}

function assertDecisionResultLinkage(
  decision: ReturnType<typeof sessionCommandSchema.parse>,
  result: ReturnType<typeof sessionCommandResultSchema.parse>,
  input: { readonly commandId: string; readonly parentSessionId: string },
): void {
  if (result.commandId !== input.commandId || result.sessionId !== input.parentSessionId ||
      decision.sessionId !== input.parentSessionId || result.generation !== decision.generation ||
      result.leaseId !== decision.leaseId || result.idempotencyKey !== decision.idempotencyKey ||
      result.type !== decision.type || result.snapshot.sessionId !== input.parentSessionId ||
      result.snapshot.generation !== result.generation || result.snapshot.lease?.leaseId !== result.leaseId ||
      result.snapshot.eventCursor !== result.eventCursor) {
    throw new WorkItemAdmissionConflictError("project-plan decision result does not bind its durable command and snapshot");
  }
}

function assertDispatchDecisionSnapshotIdentity(
  dispatch: ReturnType<typeof sessionRuntimeDispatchSchema.parse>,
  result: ReturnType<typeof sessionCommandResultSchema.parse>,
): void {
  exact(dispatch.snapshot.identity, result.snapshot.identity,
    "claimed parent dispatch snapshot identity does not match the durable decision-result snapshot identity");
}

function assertParentLineage(current: SessionSnapshot, approved: SessionSnapshot): void {
  if (current.sessionId !== approved.sessionId || current.generation !== approved.generation ||
      current.state !== "running" || current.pendingPermission !== null || current.lease?.status !== "active" ||
      current.lease.leaseId !== approved.lease?.leaseId || current.eventCursor < approved.eventCursor ||
      canonicalJsonText(current.identity) !== canonicalJsonText(approved.identity)) {
    throw new WorkItemAdmissionConflictError("project-plan approval no longer binds the current parent session");
  }
}

async function assertInterveningAdmissionProjections(client: TransactionClient, input: {
  readonly parentSessionId: string;
  readonly afterCursor: number;
  readonly approvalId: string;
}): Promise<void> {
  const events = await client.query<Row>(
    `SELECT event.event_json, admission.approval_id FROM codeops.session_events event
       LEFT JOIN codeops.work_item_admissions admission ON admission.supervision_event_id=event.event_id
      WHERE event.session_id=$1 AND event.cursor>$2 ORDER BY event.cursor ASC`,
    [input.parentSessionId, input.afterCursor],
  );
  for (const row of events.rows) {
    const event = sessionEventSchema.parse(row.event_json);
    if (event.update?.kind !== "supervision" || row.approval_id !== input.approvalId) {
      throw new WorkItemAdmissionConflictError("parent session drifted after project-plan approval");
    }
  }
}

async function replayResult(client: TransactionClient, input: {
  readonly requestAuthority: unknown;
  readonly claimToken: string;
  readonly admissionId: string;
  readonly parentDispatchId: string;
}): Promise<WorkItemAdmissionResult | null> {
  const stored = await client.query<Row>(
    `SELECT admission.*, approval.authority_digest AS approval_authority_digest,
            approval.authority_json AS approval_authority_json,
            approval.parent_session_id AS approval_parent_session_id,
            approval.dispatch_id AS approval_dispatch_id,
            approval.permission_request_id AS approval_permission_request_id,
            approval.plan_event_id AS approval_plan_event_id,
            approval.plan_id AS approval_plan_id,
            approval.plan_digest AS approval_plan_digest,
            approval.decision_command_id AS approval_decision_command_id,
            approval.approved_by_principal_id AS approval_principal_id,
            approval.approved_at AS approval_approved_at,
            parent.owner_principal_id AS parent_owner_principal_id,
            parent_dispatch.dispatch_json AS parent_dispatch_json,
            parent_dispatch.session_id AS parent_dispatch_session_id,
            parent_dispatch.principal_id AS parent_dispatch_principal_id,
            permission.request_json AS permission_request_json,
            permission.session_id AS permission_session_id,
            plan_event.event_json AS plan_event_json,
            plan_event.session_id AS plan_event_session_id,
            plan_event.generation AS plan_event_generation,
            plan_event.cursor AS plan_event_cursor,
            plan_event.event_type AS plan_event_type,
            plan_event.occurred_at AS plan_event_occurred_at,
            decision.command_json AS decision_command_json,
            decision.result_json AS decision_result_json,
            decision.session_id AS decision_session_id,
            decision.principal_id AS decision_principal_id,
            decision.committed_at AS decision_committed_at,
            child.snapshot_json AS child_snapshot_json,
            child.owner_principal_id AS child_owner_principal_id,
            child_event.event_json AS child_event_json,
            child_event.session_id AS child_event_session_id,
            child_event.generation AS child_event_generation,
            child_event.cursor AS child_event_cursor,
            child_event.event_type AS child_event_type,
            child_event.occurred_at AS child_event_occurred_at,
            outbox.dispatch_json, outbox.session_id AS outbox_session_id,
            outbox.idempotency_key AS outbox_idempotency_key,
            outbox.principal_id AS outbox_principal_id,
            outbox.admission_id AS outbox_admission_id,
            budget.budget_id, budget.started_at AS budget_started_at,
            budget.provider_requests_limit, budget.output_tokens_limit,
            lifecycle.event_json AS lifecycle_event_json,
            lifecycle.event_digest AS lifecycle_event_digest,
            lifecycle.transition_id AS lifecycle_transition_id,
            lifecycle.transition_key AS lifecycle_transition_key,
            lifecycle.repository AS lifecycle_repository,
            lifecycle.provider AS lifecycle_provider,
            lifecycle.workspace_id AS lifecycle_workspace_id,
            lifecycle.project_id AS lifecycle_project_id,
            lifecycle.work_item_id AS lifecycle_work_item_id,
            lifecycle.workflow_id AS lifecycle_workflow_id,
            lifecycle.run_id AS lifecycle_run_id,
            lifecycle.source_sha AS lifecycle_source_sha,
            lifecycle.sequence AS lifecycle_sequence,
            lifecycle.created_at AS lifecycle_created_at,
            lifecycle_owner.repository AS owner_repository,
            lifecycle_owner.provider AS owner_provider,
            lifecycle_owner.workspace_id AS owner_workspace_id,
            lifecycle_owner.project_id AS owner_project_id,
            lifecycle_owner.work_item_id AS owner_work_item_id,
            lifecycle_owner.workflow_id AS owner_workflow_id,
            lifecycle_owner.run_id AS owner_run_id,
            publication.event_id AS publication_event_id,
            supervision.event_json AS supervision_event_json,
            supervision.session_id AS supervision_session_id,
            supervision.generation AS supervision_generation,
            supervision.cursor AS supervision_cursor,
            supervision.event_type AS supervision_event_type,
            supervision.occurred_at AS supervision_occurred_at
       FROM codeops.work_item_admissions admission
       JOIN codeops.project_plan_approvals approval ON approval.approval_id=admission.approval_id
       JOIN codeops.sessions parent ON parent.session_id=admission.parent_session_id
       JOIN codeops.session_runtime_outbox parent_dispatch ON parent_dispatch.dispatch_id=approval.dispatch_id
       JOIN codeops.session_runtime_permission_requests permission
         ON permission.dispatch_id=approval.dispatch_id AND permission.request_id=approval.permission_request_id
       JOIN codeops.session_events plan_event ON plan_event.event_id=approval.plan_event_id
       JOIN codeops.session_commands decision ON decision.command_id=approval.decision_command_id
       JOIN codeops.sessions child ON child.session_id=admission.child_session_id
       JOIN codeops.session_events child_event ON child_event.event_id=admission.child_event_id
       JOIN codeops.session_runtime_outbox outbox
         ON outbox.admission_id=admission.admission_id AND outbox.dispatch_id=admission.child_dispatch_id
       JOIN codeops.session_model_budgets budget ON budget.session_id=admission.child_session_id
       JOIN codeops.work_item_lifecycle_events lifecycle ON lifecycle.event_id=admission.lifecycle_event_id
       JOIN codeops.work_item_lifecycle lifecycle_owner
         ON lifecycle_owner.repository=admission.repository AND lifecycle_owner.provider=admission.provider
        AND lifecycle_owner.workspace_id=admission.workspace_id AND lifecycle_owner.project_id=admission.project_id
        AND lifecycle_owner.work_item_id=admission.work_item_id
       JOIN codeops.work_item_lifecycle_publications publication ON publication.event_id=admission.lifecycle_event_id
       JOIN codeops.session_events supervision ON supervision.event_id=admission.supervision_event_id
      WHERE admission.admission_id=$1 FOR UPDATE OF admission`,
    [input.admissionId],
  );
  if (stored.rows[0] === undefined) {
    const exists = await client.query<Row>("SELECT 1 FROM codeops.work_item_admissions WHERE admission_id=$1", [input.admissionId]);
    if (exists.rows[0] !== undefined) throw new WorkItemAdmissionConflictError("work-item admission durable owner is missing");
    return null;
  }
  const row = stored.rows[0];
  const authority = row.authority_json as Record<string, unknown>;
  const approval = row.approval_authority_json as Record<string, unknown>;
  if (row.authority_digest !== sha256CanonicalJsonDigest(authority)) throw new WorkItemAdmissionConflictError("work-item admission authority digest drifted");
  if (row.approval_authority_digest !== sha256CanonicalJsonDigest(approval)) throw new WorkItemAdmissionConflictError("project-plan approval authority digest drifted");
  exact(authority.request, input.requestAuthority, "work-item admission request conflicts with immutable authority");
  if (approval.dispatchId !== input.parentDispatchId || approval.approvalId !== row.approval_id ||
      approval.parentSessionId !== row.parent_session_id || approval.parentSessionId !== row.approval_parent_session_id ||
      approval.dispatchId !== row.approval_dispatch_id || approval.permissionRequestId !== row.approval_permission_request_id ||
      approval.planEventId !== row.approval_plan_event_id || approval.planId !== row.approval_plan_id ||
      approval.planDigest !== row.approval_plan_digest || approval.decisionCommandId !== row.approval_decision_command_id ||
      approval.approvedByPrincipalId !== row.approval_principal_id ||
      approval.approvedAt !== postgresTimestamp(row.approval_approved_at)) {
    throw new WorkItemAdmissionConflictError("project-plan approval relationship drifted");
  }
  exact(row.parent_dispatch_json, approval.parentDispatch, "parent dispatch payload drifted");
  exact(row.permission_request_json, approval.permissionRequest, "project-plan permission payload drifted");
  exact(row.plan_event_json, approval.planEvent, "project plan event payload drifted");
  exact(row.decision_command_json, approval.decisionCommand, "project-plan decision command payload drifted");
  exact(row.decision_result_json, approval.decisionResult, "project-plan decision result payload drifted");
  const parentDispatch = sessionRuntimeDispatchSchema.parse(approval.parentDispatch);
  const permission = sessionRuntimePermissionSubmissionSchema.parse(approval.permissionRequest);
  const planEvent = sessionEventSchema.parse(approval.planEvent);
  const decision = sessionCommandSchema.parse(approval.decisionCommand);
  const decisionResult = sessionCommandResultSchema.parse(approval.decisionResult);
  assertDecisionResultLinkage(decision, decisionResult, {
    commandId: String(row.approval_decision_command_id), parentSessionId: String(row.approval_parent_session_id),
  });
  assertDispatchDecisionSnapshotIdentity(parentDispatch, decisionResult);
  const replayRequest = input.requestAuthority as { readonly workItem?: unknown };
  const requestedIdentity = identityOf(replayRequest.workItem as Parameters<typeof identityOf>[0]);
  const approvedItems = approval.workItems;
  if (!Array.isArray(approvedItems) || !approvedItems.some((item) => canonicalJsonText(item) === canonicalJsonText(requestedIdentity))) {
    throw new WorkItemAdmissionConflictError("project-plan approval does not contain the exact work-item identity");
  }
  if (row.parent_dispatch_session_id !== approval.parentSessionId || row.parent_dispatch_principal_id !== row.parent_owner_principal_id ||
      parentDispatch.dispatchId !== approval.dispatchId || parentDispatch.principalId !== row.parent_owner_principal_id ||
      parentDispatch.command.sessionId !== approval.parentSessionId || row.permission_session_id !== approval.parentSessionId ||
      permission.claimToken !== input.claimToken || permission.request.requestId !== approval.permissionRequestId ||
      permission.request.operation.kind !== "project_plan" || permission.request.operation.planId !== approval.planId ||
      permission.request.operation.planDigest !== approval.planDigest ||
      permission.request.operationDigest !== sha256CanonicalJsonDigest(permission.request.operation) ||
      canonicalJsonText(permission.request.operation.workItems) !== canonicalJsonText(approval.workItems) ||
      row.plan_event_session_id !== approval.parentSessionId || planEvent.eventId !== approval.planEventId ||
      Number(row.plan_event_generation) !== planEvent.generation || Number(row.plan_event_cursor) !== planEvent.cursor ||
      row.plan_event_type !== planEvent.type || postgresTimestamp(row.plan_event_occurred_at) !== planEvent.occurredAt ||
      planEvent.update?.kind !== "plan_update" || planEvent.update.planId !== approval.planId ||
      sha256CanonicalJsonDigest(planEvent.update.content) !== approval.planDigest ||
      row.decision_session_id !== approval.parentSessionId || row.decision_principal_id !== row.parent_owner_principal_id ||
      postgresTimestamp(row.decision_committed_at) !== approval.approvedAt || decisionResult.commandId !== approval.decisionCommandId ||
      decisionResult.sessionId !== approval.parentSessionId || decisionResult.committedAt !== approval.approvedAt ||
      decisionResult.generation !== decision.generation || decisionResult.leaseId !== decision.leaseId ||
      decisionResult.idempotencyKey !== decision.idempotencyKey || decisionResult.type !== decision.type ||
      decisionResult.snapshot.sessionId !== approval.parentSessionId ||
      decisionResult.snapshot.generation !== decision.generation ||
      decisionResult.snapshot.lease?.leaseId !== decision.leaseId ||
      decision.sessionId !== approval.parentSessionId || decision.type !== "respond_permission" ||
      decision.permissionRequestId !== approval.permissionRequestId || decision.decision.outcome !== "selected" ||
      decision.decision.optionId !== "allow-once" || decisionResult.disposition !== "committed") {
    throw new WorkItemAdmissionConflictError("project-plan approval durable linkage drifted");
  }
  if (authority.approvalId !== row.approval_id || authority.parentSessionId !== row.parent_session_id ||
      authority.childSessionId !== row.child_session_id || authority.dispatchId !== row.child_dispatch_id ||
      authority.childEventId !== row.child_event_id || authority.lifecycleEventId !== row.lifecycle_event_id ||
      authority.supervisionEventId !== row.supervision_event_id || authority.repository !== row.repository ||
      (authority.provider as Row).kind !== row.provider || (authority.provider as Row).workspaceId !== row.workspace_id ||
      (authority.provider as Row).projectId !== row.project_id || authority.workItemId !== row.work_item_id ||
      canonicalJsonText(requestedIdentity) !== canonicalJsonText({ repository: row.repository,
        provider: { kind: row.provider, workspaceId: row.workspace_id, projectId: row.project_id }, workItemId: row.work_item_id }) ||
      authority.workflowId !== row.workflow_id || authority.runId !== row.run_id || authority.sourceSha !== row.source_sha ||
      authority.admittedAt !== postgresTimestamp(row.admitted_at)) {
    throw new WorkItemAdmissionConflictError("work-item admission relationship drifted");
  }
  exact(row.child_event_json, authority.childEvent, "child session event drifted");
  exact(row.dispatch_json, authority.dispatch, "child dispatch payload drifted");
  exact(row.lifecycle_event_json, authority.lifecycleEvent, "lifecycle event payload drifted");
  exact(row.supervision_event_json, authority.supervisionEvent, "supervision event payload drifted");
  const child = sessionSnapshotSchema.parse(authority.childSnapshot);
  const currentChild = sessionSnapshotSchema.parse(row.child_snapshot_json);
  const childEvent = sessionEventSchema.parse(authority.childEvent);
  const dispatch = sessionRuntimeDispatchSchema.parse(authority.dispatch);
  const lifecycle = workItemLifecycleEventSchema.parse(authority.lifecycleEvent);
  const supervision = sessionEventSchema.parse(authority.supervisionEvent);
  exact(dispatch.snapshot, child, "child dispatch snapshot drifted from immutable child authority");
  if (row.child_owner_principal_id !== row.parent_owner_principal_id || row.outbox_principal_id !== row.parent_owner_principal_id ||
      currentChild.sessionId !== child.sessionId || canonicalJsonText(currentChild.identity) !== canonicalJsonText(child.identity) ||
      row.outbox_session_id !== child.sessionId || row.outbox_admission_id !== input.admissionId ||
      row.outbox_idempotency_key !== dispatch.command.idempotencyKey || dispatch.command.sessionId !== child.sessionId ||
      row.child_event_session_id !== child.sessionId || Number(row.child_event_generation) !== childEvent.generation ||
      Number(row.child_event_cursor) !== childEvent.cursor || row.child_event_type !== childEvent.type ||
      postgresTimestamp(row.child_event_occurred_at) !== childEvent.occurredAt || row.budget_id !== child.sessionId ||
      child.budget?.version !== "codeops.session-budget/v2" || postgresTimestamp(row.budget_started_at) !== child.budget.startedAt ||
      Number(row.provider_requests_limit) !== child.budget.limits.providerRequests ||
      Number(row.output_tokens_limit) !== child.budget.limits.outputTokens ||
      row.lifecycle_event_digest !== sha256CanonicalJsonDigest(lifecycle).slice(7) ||
      row.lifecycle_transition_id !== lifecycle.transitionId || row.lifecycle_transition_key !== lifecycle.transitionKey ||
      row.lifecycle_repository !== authority.repository || row.lifecycle_provider !== "plane" ||
      row.lifecycle_workspace_id !== (authority.provider as Row).workspaceId || row.lifecycle_project_id !== (authority.provider as Row).projectId ||
      row.lifecycle_work_item_id !== authority.workItemId || row.lifecycle_workflow_id !== authority.workflowId ||
      row.lifecycle_run_id !== authority.runId || row.lifecycle_source_sha !== authority.sourceSha || Number(row.lifecycle_sequence) !== 1 ||
      postgresTimestamp(row.lifecycle_created_at) !== lifecycle.occurredAt || row.owner_repository !== authority.repository ||
      row.owner_provider !== "plane" || row.owner_workspace_id !== (authority.provider as Row).workspaceId ||
      row.owner_project_id !== (authority.provider as Row).projectId || row.owner_work_item_id !== authority.workItemId ||
      row.owner_workflow_id !== authority.workflowId || row.owner_run_id !== authority.runId ||
      row.publication_event_id !== authority.lifecycleEventId ||
      row.supervision_session_id !== authority.parentSessionId || Number(row.supervision_generation) !== supervision.generation ||
      Number(row.supervision_cursor) !== supervision.cursor || row.supervision_event_type !== supervision.type ||
      postgresTimestamp(row.supervision_occurred_at) !== supervision.occurredAt) {
    throw new WorkItemAdmissionConflictError("work-item admission durable linkage drifted");
  }
  return workItemAdmissionResultSchema.parse({ version: "codeops.work-item-admission-result/v1",
    admissionId: input.admissionId, disposition: "replayed", parentSessionId: authority.parentSessionId,
    childSessionId: authority.childSessionId, dispatchId: authority.dispatchId,
    lifecycleEventId: authority.lifecycleEventId, supervisionEventId: authority.supervisionEventId });
}

async function persistApproval(client: TransactionClient, approval: Readonly<Record<string, unknown>>, approvedAt: string): Promise<void> {
  const digest = sha256CanonicalJsonDigest(approval);
  await client.query(
    `INSERT INTO codeops.project_plan_approvals
       (approval_id,parent_session_id,dispatch_id,permission_request_id,plan_event_id,plan_id,plan_digest,
        decision_command_id,approved_by_principal_id,authority_digest,authority_json,approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)
     ON CONFLICT (approval_id) DO NOTHING`,
    [approval.approvalId, approval.parentSessionId, approval.dispatchId, approval.permissionRequestId,
      approval.planEventId, approval.planId, approval.planDigest, approval.decisionCommandId,
      approval.approvedByPrincipalId, digest, canonicalJsonText(approval), approvedAt],
  );
  const stored = await client.query<Row>(
    "SELECT authority_digest,authority_json FROM codeops.project_plan_approvals WHERE approval_id=$1 FOR UPDATE",
    [approval.approvalId],
  );
  if (stored.rows[0]?.authority_digest !== digest) throw new WorkItemAdmissionConflictError("project-plan approval conflicts with immutable authority");
  exact(stored.rows[0]?.authority_json, approval, "project-plan approval conflicts with immutable authority");
}

export async function admitSessionRuntimeWorkItem(client: TransactionClient, input: {
  readonly dispatchId: string;
  readonly workerId: string;
  readonly request: unknown;
  readonly now?: () => Date;
}): Promise<WorkItemAdmissionResult> {
  const request = workItemAdmissionRequestSchema.parse(input.request);
  const nowDate = (input.now ?? (() => new Date()))();
  const admittedAt = nowDate.toISOString();
  const requestAuthority = withoutClaimToken(request);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const replayed = await replayResult(client, { requestAuthority, claimToken: request.claimToken,
      admissionId: request.admissionId, parentDispatchId: input.dispatchId });
    if (replayed !== null) { await client.query("COMMIT"); return replayed; }
    const duplicate = await client.query<Row>(
      `SELECT admission_id FROM codeops.work_item_admissions
        WHERE child_session_id=$1 OR child_dispatch_id=$2 OR
          (repository=$3 AND provider='plane' AND workspace_id=$4 AND project_id=$5 AND work_item_id=$6) OR
          (workflow_id=$7 AND run_id=$8)
        LIMIT 1`,
      [request.child.sessionId, request.child.dispatchId, request.workItem.repository,
        request.workItem.provider.workspaceId, request.workItem.provider.projectId, request.workItem.workItemId,
        request.workItem.workflowId, request.workItem.runId],
    );
    if (duplicate.rows[0] !== undefined) {
      throw new WorkItemAdmissionDuplicateError("work item or child identity already belongs to another admission");
    }
    const discovered = await client.query<Row>("SELECT session_id FROM codeops.session_runtime_outbox WHERE dispatch_id=$1", [input.dispatchId]);
    if (discovered.rows[0] === undefined) throw new WorkItemAdmissionNotFoundError("runtime dispatch was not found");
    const parentSessionId = String(discovered.rows[0].session_id);
    const parentRows = await client.query<Row>(
      `SELECT parent.snapshot_json,parent.owner_principal_id,
              (SELECT count(*)::integer FROM codeops.sessions child
                WHERE child.snapshot_json->'identity'->>'parentSessionId'=parent.session_id
                  AND child.owner_principal_id=parent.owner_principal_id
                  AND child.snapshot_json->>'state' IN ('queued','running','waiting_permission','checkpointing','hibernated')) active_children
         FROM codeops.sessions parent WHERE parent.session_id=$1 FOR UPDATE OF parent`, [parentSessionId]);
    if (parentRows.rows[0] === undefined) throw new WorkItemAdmissionNotFoundError("parent session was not found");
    const dispatchRows = await client.query<Row>(
      `SELECT outbox.dispatch_json,outbox.status,outbox.claim_token,outbox.claimed_by,outbox.claim_expires_at,
              session.owner_principal_id FROM codeops.session_runtime_outbox outbox
         JOIN codeops.sessions session ON session.session_id=outbox.session_id
        WHERE outbox.dispatch_id=$1 FOR UPDATE OF outbox`, [input.dispatchId]);
    let claimed;
    try {
      claimed = validateClaimedDispatchAuthority(dispatchRows.rows[0] as never, {
        dispatchId: input.dispatchId, workerId: input.workerId, claimToken: request.claimToken, now: nowDate });
      selectClaimedWorkspaceSource(claimed, { repository: request.workItem.repository, resolvedSha: request.workItem.sourceSha });
    } catch (error) {
      if (error instanceof ClaimedDispatchAuthorityConflictError) throw new WorkItemAdmissionConflictError(error.message);
      throw error;
    }
    if (claimed.dispatch.command.sessionId !== parentSessionId) throw new WorkItemAdmissionConflictError("claimed dispatch does not bind the locked parent session");
    const parent = sessionSnapshotSchema.parse(parentRows.rows[0].snapshot_json);
    if (!isWorkspaceSessionIdentity(parent.identity)) throw new WorkItemAdmissionConflictError("work-item admission requires a workspace parent session");
    const planRows = await client.query<Row>(
      `SELECT event_id,event_json FROM codeops.session_events WHERE session_id=$1
        AND event_json#>>'{update,kind}'='plan_update' AND event_json#>>'{update,planId}'=$2
        ORDER BY cursor DESC LIMIT 1 FOR UPDATE`, [parentSessionId, request.plan.planId]);
    if (planRows.rows[0] === undefined) throw new WorkItemAdmissionConflictError("approved project plan was not found");
    const planEvent = sessionEventSchema.parse(planRows.rows[0].event_json);
    if (planEvent.update?.kind !== "plan_update" || sha256CanonicalJsonDigest(planEvent.update.content) !== request.plan.planDigest) {
      throw new WorkItemAdmissionConflictError("project plan does not match the approved immutable content");
    }
    const permissionRows = await client.query<Row>(
      `SELECT permission.request_json,decision.command_id,decision.command_json,decision.result_json,
              decision.principal_id,decision.committed_at FROM codeops.session_runtime_permission_requests permission
         JOIN LATERAL (SELECT command_id,command_json,result_json,principal_id,committed_at FROM codeops.session_commands
            WHERE session_id=permission.session_id AND command_json->>'type'='respond_permission'
              AND command_json->>'permissionRequestId'=permission.request_id
            ORDER BY committed_at ASC,command_id ASC LIMIT 1) decision ON TRUE
        WHERE permission.dispatch_id=$1 AND permission.request_id=$2 FOR UPDATE OF permission`,
      [input.dispatchId, request.plan.permissionRequestId]);
    const permissionRow = permissionRows.rows[0];
    if (permissionRow === undefined) throw new WorkItemAdmissionConflictError("work-item admission requires one decided project-plan permission");
    const permission = sessionRuntimePermissionSubmissionSchema.parse(permissionRow.request_json);
    const decision = sessionCommandSchema.parse(permissionRow.command_json);
    const decisionResult = sessionCommandResultSchema.parse(permissionRow.result_json);
    assertDecisionResultLinkage(decision, decisionResult, {
      commandId: String(permissionRow.command_id), parentSessionId,
    });
    assertDispatchDecisionSnapshotIdentity(claimed.dispatch, decisionResult);
    const operation = permission.request.operation;
    const requestedIdentity = identityOf(request.workItem);
    if (permission.claimToken !== request.claimToken || permission.request.requestId !== request.plan.permissionRequestId ||
      operation.kind !== "project_plan" || operation.planId !== request.plan.planId || operation.planDigest !== request.plan.planDigest ||
      !operation.workItems.some((item) => canonicalJsonText(item) === canonicalJsonText(requestedIdentity)) ||
      permission.request.operationDigest !== sha256CanonicalJsonDigest(permission.request.operation) ||
      decision.type !== "respond_permission" || decision.permissionRequestId !== request.plan.permissionRequestId ||
      decision.decision.outcome !== "selected" || decision.decision.optionId !== "allow-once" ||
      decisionResult.disposition !== "committed" || decisionResult.commandId !== permissionRow.command_id ||
      permissionRow.principal_id !== parentRows.rows[0].owner_principal_id ||
      Date.parse(postgresTimestamp(permissionRow.committed_at)) < Date.parse(planEvent.occurredAt)) {
      throw new WorkItemAdmissionConflictError("project-plan permission does not authorize this exact work item identity");
    }
    assertParentLineage(parent, decisionResult.snapshot);
    const parentLease = parent.lease;
    if (parentLease?.status !== "active") throw new WorkItemAdmissionConflictError("work-item admission requires the active parent lease");
    const parentBudget = claimed.snapshot.budget;
    if (parentBudget?.version !== "codeops.session-budget/v2") throw new WorkItemAdmissionConflictError("work-item admission requires the durable model-budget contract");
    const activeChildren = Number(parentRows.rows[0].active_children);
    if (!Number.isSafeInteger(activeChildren) || activeChildren < 0 || activeChildren >= parentBudget.limits.activeChildren) {
      throw new WorkItemAdmissionConflictError("work-item admission exceeds the parent active-child budget");
    }
    const approvalId = deterministicUuid(`project-plan-approval\0${input.dispatchId}\0${request.plan.permissionRequestId}\0${request.plan.planDigest}`);
    await assertInterveningAdmissionProjections(client, { parentSessionId, afterCursor: decisionResult.eventCursor, approvalId });
    const approvedAt = postgresTimestamp(permissionRow.committed_at);
    const approval = {
      version: "codeops.project-plan-approval-authority/v1", approvalId, parentSessionId,
      dispatchId: input.dispatchId, permissionRequestId: request.plan.permissionRequestId,
      planEventId: planEvent.eventId, planId: request.plan.planId, planDigest: request.plan.planDigest,
      workItems: operation.workItems, decisionCommandId: decisionResult.commandId,
      approvedByPrincipalId: String(permissionRow.principal_id), approvedAt,
      parentDispatch: claimed.dispatch, permissionRequest: permission, planEvent,
      decisionCommand: decision, decisionResult,
    } as const;
    await persistApproval(client, approval, approvedAt);
    const childIdentity = { ...parent.identity, workflowId: request.workItem.workflowId, runId: request.workItem.runId,
      displayName: request.workItem.title, workItemId: request.workItem.workItemId, agentRole: "coding" as const,
      round: 1, parentSessionId, forkedAtCursor: parent.eventCursor };
    const child = sessionSnapshotSchema.parse({
      version: "codeops.session-snapshot/v1", sessionId: request.child.sessionId, generation: 1, state: "running",
      identity: childIdentity, lease: { leaseId: request.child.leaseId, generation: 1, status: "active",
        holderId: request.child.holderId, acquiredAt: admittedAt, expiresAt: parentLease.expiresAt },
      checkpoint: null, pendingPermission: null,
      budget: projectSessionBudgetV2({ budgetId: request.child.sessionId, revision: 1, startedAt: admittedAt,
        observedAt: admittedAt, limits: parentBudget.limits }), eventCursor: 1,
      capabilities: sessionCapabilitiesFor("running", false), updatedAt: admittedAt });
    if (child.budget?.version !== "codeops.session-budget/v2") throw new WorkItemAdmissionConflictError("child session did not retain its durable model budget");
    const childEventBody = { sessionId: child.sessionId, generation: 1, cursor: 1, type: "session_created" as const,
      action: { type: "fork" as const, detail: request.workItem.title }, occurredAt: admittedAt };
    const childEvent = sessionEventSchema.parse({ version: "codeops.session-event/v1", eventId: eventId(childEventBody), ...childEventBody });
    const prompt = sessionCommandSchema.parse({ version: "codeops.session-command/v1", sessionId: child.sessionId,
      generation: 1, leaseId: request.child.leaseId, idempotencyKey: request.child.idempotencyKey,
      type: "prompt", prompt: request.workItem.prompt });
    const dispatch = buildSessionRuntimeDispatch({ dispatchId: request.child.dispatchId,
      principalId: String(parentRows.rows[0].owner_principal_id), command: prompt, snapshot: child, dispatchedAt: admittedAt });
    const transitionKey = `admit:${request.admissionId}`;
    const transitionId = createTransitionId({ workflowId: request.workItem.workflowId, transitionKey,
      version: "codeops.work-item-lifecycle-event/v1" });
    const lifecycleEvent = workItemLifecycleEventSchema.parse({ version: "codeops.work-item-lifecycle-event/v1",
      eventId: createEventId({ workflowId: request.workItem.workflowId, transitionId,
        version: "codeops.work-item-lifecycle-event/v1" }), transitionId, transitionKey, command: "register",
      repository: (() => { const [owner, name] = request.workItem.repository.split("/"); return { owner, name }; })(),
      provider: request.workItem.provider, workItemId: request.workItem.workItemId,
      workflowId: request.workItem.workflowId, runId: request.workItem.runId, sequence: 1, previousState: null,
      state: { phase: "in_progress", attention: "clear" }, sourceSha: request.workItem.sourceSha,
      occurredAt: admittedAt, summary: request.workItem.title, evidence: [] });
    const supervisionBody = { sessionId: parentSessionId, generation: parent.generation, cursor: parent.eventCursor + 1,
      type: "acp_update" as const, update: { kind: "supervision" as const,
        projectionId: deterministicUuid(`admission-supervision\0${request.admissionId}`), childSessionId: child.sessionId,
        childState: child.state, childEventCursor: child.eventCursor, repository: request.workItem.repository,
        workItemId: request.workItem.workItemId, workflowId: request.workItem.workflowId,
        agentRole: "coding" as const, round: 1 }, occurredAt: admittedAt };
    const supervisionEvent: SessionEvent = sessionEventSchema.parse({ version: "codeops.session-event/v1",
      eventId: eventId(supervisionBody), ...supervisionBody });
    const updatedParent = sessionSnapshotSchema.parse({ ...parent, eventCursor: supervisionEvent.cursor, updatedAt: admittedAt });
    await client.query(`INSERT INTO codeops.sessions(session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
      VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`, [child.sessionId, request.child.leaseId,
      canonicalJsonText(child), admittedAt, parentRows.rows[0].owner_principal_id]);
    await client.query(`INSERT INTO codeops.session_model_budgets(session_id,budget_id,started_at,provider_requests_limit,
      output_tokens_limit,committed_provider_requests,settled_output_tokens,reserved_output_tokens,observed_input_tokens,
      observed_total_tokens,revision,updated_at) VALUES($1,$1,$2::timestamptz,$3,$4,0,0,0,0,0,1,$2::timestamptz)`,
      [child.sessionId, admittedAt, child.budget.limits.providerRequests, child.budget.limits.outputTokens]);
    await client.query(`INSERT INTO codeops.session_events(event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,1,1,'session_created',$3::jsonb,NULL,$4::timestamptz)`,
      [childEvent.eventId, child.sessionId, canonicalJsonText(childEvent), admittedAt]);
    await client.query(`INSERT INTO codeops.work_item_lifecycle(repository,provider,workspace_id,project_id,work_item_id,
      workflow_id,run_id,phase,attention,sequence,source_sha,updated_at)
      VALUES($1,'plane',$2,$3,$4,$5,$6,'in_progress','clear',1,$7,$8::timestamptz)`,
      [request.workItem.repository, request.workItem.provider.workspaceId, request.workItem.provider.projectId,
        request.workItem.workItemId, request.workItem.workflowId, request.workItem.runId, request.workItem.sourceSha, admittedAt]);
    await client.query(`INSERT INTO codeops.work_item_lifecycle_events(event_id,transition_id,transition_key,repository,
      provider,workspace_id,project_id,work_item_id,workflow_id,run_id,source_sha,sequence,event_digest,event_json,created_at)
      VALUES($1,$2,$3,$4,'plane',$5,$6,$7,$8,$9,$10,1,$11,$12::jsonb,$13::timestamptz)`,
      [lifecycleEvent.eventId, lifecycleEvent.transitionId, lifecycleEvent.transitionKey, request.workItem.repository,
        request.workItem.provider.workspaceId, request.workItem.provider.projectId, request.workItem.workItemId,
        request.workItem.workflowId, request.workItem.runId, request.workItem.sourceSha,
        sha256CanonicalJsonDigest(lifecycleEvent).slice(7), canonicalJsonText(lifecycleEvent), admittedAt]);
    await client.query("INSERT INTO codeops.work_item_lifecycle_publications(event_id,status,available_at) VALUES($1,'pending',$2::timestamptz)",
      [lifecycleEvent.eventId, admittedAt]);
    await client.query(`INSERT INTO codeops.session_events(event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,$3,$4,'acp_update',$5::jsonb,NULL,$6::timestamptz)`, [supervisionEvent.eventId,
      parentSessionId, parent.generation, supervisionEvent.cursor, canonicalJsonText(supervisionEvent), admittedAt]);
    await client.query("UPDATE codeops.sessions SET snapshot_json=$2::jsonb,updated_at=$3::timestamptz WHERE session_id=$1",
      [parentSessionId, canonicalJsonText(updatedParent), admittedAt]);
    const admissionAuthority = { version: "codeops.work-item-admission-authority/v1", admissionId: request.admissionId,
      approvalId, parentSessionId, childSessionId: child.sessionId, dispatchId: dispatch.dispatchId,
      childEventId: childEvent.eventId, repository: request.workItem.repository, provider: request.workItem.provider,
      workItemId: request.workItem.workItemId, workflowId: request.workItem.workflowId, runId: request.workItem.runId,
      sourceSha: request.workItem.sourceSha, lifecycleEventId: lifecycleEvent.eventId,
      supervisionEventId: supervisionEvent.eventId, request: requestAuthority, childSnapshot: child,
      childEvent, dispatch, lifecycleEvent, supervisionEvent, admittedAt } as const;
    const storedAdmission = await client.query(`INSERT INTO codeops.work_item_admissions(admission_id,approval_id,parent_session_id,child_session_id,
      child_dispatch_id,child_event_id,repository,provider,workspace_id,project_id,work_item_id,workflow_id,run_id,source_sha,
      lifecycle_event_id,supervision_event_id,authority_digest,authority_json,admitted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'plane',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::timestamptz)
      RETURNING admission_id`,
      [request.admissionId, approvalId, parentSessionId, child.sessionId, dispatch.dispatchId, childEvent.eventId,
        request.workItem.repository, request.workItem.provider.workspaceId, request.workItem.provider.projectId,
        request.workItem.workItemId, request.workItem.workflowId, request.workItem.runId, request.workItem.sourceSha,
        lifecycleEvent.eventId, supervisionEvent.eventId, sha256CanonicalJsonDigest(admissionAuthority),
        canonicalJsonText(admissionAuthority), admittedAt]);
    if (storedAdmission.rowCount !== 1) {
      throw new WorkItemAdmissionConflictError(
        "work-item admission did not establish one durable authority row",
      );
    }
    await client.query(`INSERT INTO codeops.session_runtime_outbox(dispatch_id,session_id,idempotency_key,principal_id,
      dispatch_json,status,available_at,created_at,admission_id) VALUES($1,$2,$3,$4,$5::jsonb,'pending',$6::timestamptz,$6::timestamptz,$7)`,
      [dispatch.dispatchId, child.sessionId, prompt.idempotencyKey, dispatch.principalId,
        canonicalJsonText(dispatch), admittedAt, request.admissionId]);
    const result = workItemAdmissionResultSchema.parse({ version: "codeops.work-item-admission-result/v1",
      admissionId: request.admissionId, disposition: "created", parentSessionId, childSessionId: child.sessionId,
      dispatchId: dispatch.dispatchId, lifecycleEventId: lifecycleEvent.eventId,
      supervisionEventId: supervisionEvent.eventId });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
