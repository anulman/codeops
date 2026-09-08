import {
  ADMISSION_PLAN_PREFIX, buildWorkItemAdmissionPlan, canonicalJsonText,
  sessionEventSchema, sessionSnapshotSchema, sha256CanonicalJsonDigest,
  workItemAdmissionPlanRequestSchema, workItemAdmissionPlanResultSchema,
  workItemAdmissionRequestSchema, workItemMembershipSchema, workItemProviderGetRequestSchema,
  type WorkItemMembership, type WorkItemProviderGetRequest,
} from "@codeops/codeops-contracts";
import { verifyWorkspaceContextAttachments, workspaceContextAttachmentDescriptors }
  from "@codeops/codeops-contracts/workspace-context-node";
import { assertBrokeredProviderEffects, loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource, ClaimedDispatchAuthorityConflictError } from "./claimed-dispatch-authority.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { resolveSessionRuntimeCompletionSnapshot } from "./session-runtime-permissions.js";
import { admitSessionRuntimeWorkItem } from "./work-item-admission.js";

function exact(actual: unknown, expected: unknown): void {
  if (canonicalJsonText(actual) !== canonicalJsonText(expected)) {
    throw new ClaimedDispatchAuthorityConflictError("immutable admission plan or membership drifted");
  }
}

export async function prepareSessionRuntimeWorkItemAdmission(client: TransactionClient, input: {
  dispatchId: string; workerId: string; request: unknown;
  membership: (request: WorkItemProviderGetRequest) => Promise<WorkItemMembership>;
  now?: () => Date;
}) {
  const request = workItemAdmissionPlanRequestSchema.parse(input.request);
  const now = input.now ?? (() => new Date());
  const authorityInput = { dispatchId: input.dispatchId, workerId: input.workerId,
    claimToken: request.claimToken, requireClaimCount: true, allowedCommandTypes: ["prompt"] as const, now };
  const discovered = await loadClaimedDispatchAuthority(client, authorityInput);
  assertBrokeredProviderEffects(discovered);
  const source = selectClaimedWorkspaceSource(discovered, { repository: request.input.repository });
  if (discovered.claimCount !== 1) throw new ClaimedDispatchAuthorityConflictError("reclaimed admission execution requires reconciliation");
  // Credentials and the repository->project selection stay in the existing
  // controller. This is a project-scoped read, never an agent-supplied binding.
  const membership = workItemMembershipSchema.parse(await input.membership(workItemProviderGetRequestSchema.parse({
    version: "codeops.work-item-provider-get-request/v1", provider: "plane",
    operationId: `admission-membership-${sha256CanonicalJsonDigest({ dispatchId: input.dispatchId, input: request.input }).slice(7)}`,
    payloadDigest: sha256CanonicalJsonDigest({ repository: request.input.repository, workItemId: request.input.workItemId }),
    repository: request.input.repository, workItemId: request.input.workItemId,
    provenance: { sessionId: discovered.dispatch.command.sessionId, dispatchId: input.dispatchId,
      principalDigest: sha256CanonicalJsonDigest(discovered.dispatch.principalId) },
  })));
  if (membership.repository !== source.repository || membership.workItemId !== request.input.workItemId) {
    throw new ClaimedDispatchAuthorityConflictError("work item does not belong to the selected project source");
  }
  await client.query("BEGIN");
  try {
    // Same lock order as permission/completion/admission: session, then outbox.
    const rows = await client.query(`SELECT snapshot_json FROM codeops.sessions WHERE session_id=$1 FOR UPDATE`,
      [discovered.dispatch.command.sessionId]);
    await client.query("SELECT dispatch_id FROM codeops.session_runtime_outbox WHERE dispatch_id=$1 FOR UPDATE", [input.dispatchId]);
    const claimed = await loadClaimedDispatchAuthority(client, authorityInput);
    exact(claimed.dispatch, discovered.dispatch);
    if (claimed.claimCount !== 1) throw new ClaimedDispatchAuthorityConflictError("reclaimed admission execution requires reconciliation");
    const snapshot = sessionSnapshotSchema.parse(rows.rows[0]?.snapshot_json);
    const command = claimed.dispatch.command;
    if (command.type !== "prompt" || snapshot.generation !== command.generation ||
        snapshot.lease?.leaseId !== command.leaseId || snapshot.lease.status !== "active" ||
        Date.parse(snapshot.lease.expiresAt) <= now().getTime() ||
        !["running", "waiting_permission"].includes(snapshot.state)) {
      throw new ClaimedDispatchAuthorityConflictError("admission plan requires the active session generation and lease");
    }
    const attachments = verifyWorkspaceContextAttachments(command.contextAttachments ?? []);
    const identity = claimed.snapshot.identity;
    if (!("contextAttachments" in identity)) throw new ClaimedDispatchAuthorityConflictError("workspace context required");
    exact(workspaceContextAttachmentDescriptors(attachments), identity.contextAttachments);
    const plan = buildWorkItemAdmissionPlan(claimed.dispatch, request.input, membership);
    const existing = await client.query(`SELECT event_json FROM codeops.session_events WHERE event_id=$1`, [plan.eventId]);
    if (existing.rows[0]) {
      const event = sessionEventSchema.parse(existing.rows[0].event_json);
      exact(event.update, plan.update);
      if (event.eventId !== plan.eventId || event.sessionId !== snapshot.sessionId || event.generation !== snapshot.generation ||
          event.cursor <= claimed.snapshot.eventCursor || event.cursor > snapshot.eventCursor || event.type !== "acp_update") {
        throw new ClaimedDispatchAuthorityConflictError("admission plan receipt drifted");
      }
      await client.query("COMMIT");
      return workItemAdmissionPlanResultSchema.parse({ version: "codeops.work-item-admission-plan-result/v1", event, request: plan.request });
    }
    await resolveSessionRuntimeCompletionSnapshot(client, { dispatch: claimed.dispatch, claimToken: request.claimToken });
    if (snapshot.state !== "running" || snapshot.pendingPermission !== null) throw new ClaimedDispatchAuthorityConflictError("permission is pending");
    const count = await client.query(`SELECT count(*)::integer AS count FROM codeops.session_events
      WHERE session_id=$1 AND cursor>$2 AND event_json#>>'{update,kind}'='plan_update'
        AND starts_with(event_json#>>'{update,planId}', $3)`, [snapshot.sessionId, claimed.snapshot.eventCursor, ADMISSION_PLAN_PREFIX]);
    const planCount = Number(count.rows[0]?.count);
    if (!Number.isSafeInteger(planCount) || planCount < 0 || planCount >= 16) throw new ClaimedDispatchAuthorityConflictError("admission plan limit reached");
    const occurredAt = now().toISOString();
    const event = sessionEventSchema.parse({ version: "codeops.session-event/v1", eventId: plan.eventId,
      sessionId: snapshot.sessionId, generation: snapshot.generation, cursor: snapshot.eventCursor + 1,
      type: "acp_update", update: plan.update, occurredAt });
    await client.query(`INSERT INTO codeops.session_events(event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,$3,$4,'acp_update',$5::jsonb,NULL,$6::timestamptz)`,
      [event.eventId,event.sessionId,event.generation,event.cursor,canonicalJsonText(event),occurredAt]);
    const updated = await client.query(`UPDATE codeops.sessions SET snapshot_json=$1::jsonb,updated_at=$2::timestamptz
      WHERE session_id=$3 AND generation=$4 AND lease_id=$5`,
      [canonicalJsonText({ ...snapshot, eventCursor: event.cursor, updatedAt: occurredAt }),occurredAt,snapshot.sessionId,snapshot.generation,command.leaseId]);
    if (updated.rowCount !== 1) throw new ClaimedDispatchAuthorityConflictError("session drifted before plan append");
    await client.query("COMMIT");
    return workItemAdmissionPlanResultSchema.parse({ version: "codeops.work-item-admission-plan-result/v1", event, request: plan.request });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** Revalidate the controller membership and exact prepared request before admission. */
export async function admitPreparedSessionRuntimeWorkItem(client: TransactionClient, input:
  Parameters<typeof admitSessionRuntimeWorkItem>[1] & {
    membership: (request: WorkItemProviderGetRequest) => Promise<WorkItemMembership>;
  }) {
  const request = workItemAdmissionRequestSchema.parse(input.request);
  if (request.plan.planId.startsWith(ADMISSION_PLAN_PREFIX)) {
    const prepared = await prepareSessionRuntimeWorkItemAdmission(client, { ...input,
      request: { version: "codeops.work-item-admission-plan-request/v1", claimToken: request.claimToken,
        input: { repository: request.workItem.repository, workItemId: request.workItem.workItemId,
          title: request.workItem.title, prompt: request.workItem.prompt } } });
    const { version: _version, claimToken: _token, ...bounded } = request;
    exact(prepared.request, bounded);
  }
  return admitSessionRuntimeWorkItem(client, input);
}
