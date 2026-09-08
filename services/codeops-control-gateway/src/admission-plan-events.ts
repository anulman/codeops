import { ADMISSION_PLAN_PREFIX, buildWorkItemAdmissionPlan, canonicalJsonText,
  sessionEventSchema, sha256CanonicalJsonDigest, type SessionRuntimeDispatch,
  type SessionSnapshot, type SessionTimelineUpdate } from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";

export function verifyAdmissionPlanEvent(dispatch: SessionRuntimeDispatch, raw: unknown) {
  const event = sessionEventSchema.parse(raw);
  if (event.type !== "acp_update" || event.update?.kind !== "plan_update" ||
      !event.update.planId.startsWith(ADMISSION_PLAN_PREFIX) || event.update.content.type !== "markdown" ||
      event.sessionId !== dispatch.command.sessionId || event.generation !== dispatch.command.generation ||
      event.cursor <= dispatch.snapshot.eventCursor || Date.parse(event.occurredAt) < Date.parse(dispatch.dispatchedAt)) {
    throw new Error("admission plan event identity drifted");
  }
  const content = JSON.parse(event.update.content.markdown);
  const { repository, workItemId, title, prompt, provider } = content.workItem;
  const plan = buildWorkItemAdmissionPlan(dispatch, { repository, workItemId, title, prompt }, { repository, workItemId, provider });
  if (event.eventId !== plan.eventId || canonicalJsonText(event.update) !== canonicalJsonText(plan.update)) throw new Error("admission plan content drifted");
  return { event, plan };
}

/** Only these durable gateway projections may advance an otherwise exact lineage. */
export async function projectAdmissionEvents(client: TransactionClient, input: {
  dispatch: SessionRuntimeDispatch; claimToken: string; expected: SessionSnapshot; current: SessionSnapshot;
}): Promise<SessionSnapshot> {
  if (input.expected.eventCursor === input.current.eventCursor) return input.expected;
  const rows = await client.query(`SELECT event.event_json,event.command_id,
      admission.authority_json,admission.authority_digest,approval.dispatch_id,approval.authority_json AS approval_json
    FROM codeops.session_events event
    LEFT JOIN codeops.work_item_admissions admission ON admission.supervision_event_id=event.event_id
    LEFT JOIN codeops.project_plan_approvals approval ON approval.approval_id=admission.approval_id
    WHERE event.session_id=$1 AND event.cursor>$2 AND event.cursor<=$3 ORDER BY event.cursor`,
    [input.dispatch.command.sessionId,input.expected.eventCursor,input.current.eventCursor]);
  let projected = input.expected;
  for (const row of rows.rows) {
    const event = sessionEventSchema.parse(row.event_json);
    if (row.command_id !== null || event.cursor !== projected.eventCursor + 1 ||
        event.sessionId !== projected.sessionId || event.generation !== projected.generation ||
        Date.parse(event.occurredAt) < Date.parse(projected.updatedAt)) throw new Error("runtime projection order drifted");
    if (event.update?.kind === "plan_update") {
      verifyAdmissionPlanEvent(input.dispatch, event);
    } else if (event.update?.kind === "supervision") {
      const authority = row.authority_json as Record<string, unknown> | null;
      const approval = row.approval_json as { permissionRequest?: { claimToken?: string } } | null;
      if (authority === null || row.dispatch_id !== input.dispatch.dispatchId ||
          approval?.permissionRequest?.claimToken !== input.claimToken ||
          row.authority_digest !== sha256CanonicalJsonDigest(authority) ||
          authority.parentSessionId !== projected.sessionId || authority.childSessionId !== event.update.childSessionId ||
          canonicalJsonText(authority.supervisionEvent) !== canonicalJsonText(event)) {
        throw new Error("runtime supervision admission drifted");
      }
    } else throw new Error("runtime lineage contains an unrelated event");
    projected = { ...projected, eventCursor: event.cursor, updatedAt: event.occurredAt };
  }
  return projected;
}

export async function filterPersistedAdmissionPlans(client: TransactionClient, dispatch: SessionRuntimeDispatch,
  updates: readonly SessionTimelineUpdate[]): Promise<SessionTimelineUpdate[]> {
  const result: SessionTimelineUpdate[] = [];
  for (const update of updates) {
    if ((update.kind === "plan_update" || update.kind === "plan_removed") && update.planId.startsWith(ADMISSION_PLAN_PREFIX)) {
      if (update.kind === "plan_removed") throw new Error("durable admission plan cannot be removed");
      const rows = await client.query(`SELECT event_json FROM codeops.session_events
        WHERE session_id=$1 AND event_json#>>'{update,planId}'=$2 AND command_id IS NULL`, [dispatch.command.sessionId,update.planId]);
      if (rows.rows.length !== 1) throw new Error("completion cannot create an admission plan");
      const { event } = verifyAdmissionPlanEvent(dispatch, rows.rows[0]!.event_json);
      if (canonicalJsonText(event.update) !== canonicalJsonText(update)) throw new Error("completion admission plan drifted");
    } else result.push(update);
  }
  return result;
}
