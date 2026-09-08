import { verifyWorkspaceContextAttachments, workspaceContextAttachmentDescriptors } from "@codeops/codeops-contracts/workspace-context-node";
import {
  buildWorkItemAdmissionPlan, canonicalJsonText, sessionRuntimeDispatchSchema, sha256CanonicalJsonDigest,
  workItemAdmissionInputSchema, workItemAdmissionPlanResultSchema, workItemAdmissionResultSchema,
  type SessionRuntimeDispatch, type WorkItemAdmissionResult,
} from "@codeops/codeops-contracts";
import type { RuntimeExecutionContext, RuntimeWorkItemAdmissionRequest } from "./transport.js";
export { workItemAdmissionInputSchema } from "@codeops/codeops-contracts";

export class WorkItemAdmissionPermissionDeniedError extends Error {}
export class WorkItemAdmissionInactiveError extends Error {}

/** One bounded coordinator operation. No worker credentials cross this interface. */
export function createWorkItemAdmissionAdapter(input: {
  dispatch: SessionRuntimeDispatch;
  context: Pick<RuntimeExecutionContext, "prepareWorkItemAdmission" | "requestPermission" | "admitWorkItem">;
  isActive: () => boolean;
}) {
  const dispatch = sessionRuntimeDispatchSchema.parse(input.dispatch);
  const records = new Map<string, { proposal: string; request?: RuntimeWorkItemAdmissionRequest;
    result?: Promise<WorkItemAdmissionResult> }>();
  const active = () => {
    if (!input.isActive() || dispatch.command.type !== "prompt") throw new WorkItemAdmissionInactiveError("active prompt required");
  };
  return async (raw: unknown): Promise<WorkItemAdmissionResult> => {
    active();
    const proposal = workItemAdmissionInputSchema.parse(raw);
    const identity = dispatch.snapshot.identity;
    if (dispatch.command.type !== "prompt" || !("workspace" in identity) ||
        !identity.workspace.sources.some((source) => source.repository === proposal.repository)) throw new Error("admission source drifted");
    const attachments = verifyWorkspaceContextAttachments(dispatch.command.contextAttachments ?? []);
    if (canonicalJsonText(workspaceContextAttachmentDescriptors(attachments)) !== canonicalJsonText(identity.contextAttachments)) throw new Error("admission context drifted");
    const key = canonicalJsonText({ repository: proposal.repository, workItemId: proposal.workItemId });
    let entry = records.get(key);
    if (entry === undefined) {
      if (records.size >= 16) throw new Error("admission proposal limit reached");
      entry = { proposal: canonicalJsonText(proposal) };
      records.set(key, entry);
    }
    if (entry.proposal !== canonicalJsonText(proposal)) throw new Error("admission proposal content drifted");
    const record = entry;
    if (record.result === undefined) {
      record.result = (async () => {
        if (record.request === undefined) {
          const prepared = workItemAdmissionPlanResultSchema.parse(await input.context.prepareWorkItemAdmission(proposal));
          active();
          const item = prepared.request.workItem;
          const plan = buildWorkItemAdmissionPlan(dispatch, proposal, {
            repository: item.repository, workItemId: item.workItemId, provider: item.provider,
          });
          const event = prepared.event;
          if (canonicalJsonText(prepared.request) !== canonicalJsonText(plan.request) ||
              canonicalJsonText(event.update) !== canonicalJsonText(plan.update) || event.eventId !== plan.eventId ||
              event.sessionId !== dispatch.command.sessionId || event.generation !== dispatch.command.generation ||
              event.cursor <= dispatch.snapshot.eventCursor || event.type !== "acp_update") throw new Error("durable admission plan drifted");
          const decision = await input.context.requestPermission({
            request: { requestId: plan.request.plan.permissionRequestId, title: `Admit ${proposal.title}?`,
              description: "Allow this exact work-item plan once. Provider mutations require separate permission.",
              operation: plan.operation,
              operationDigest: sha256CanonicalJsonDigest(plan.operation),
              options: [{ optionId: "allow-once", label: "Allow once" }, { optionId: "deny", label: "Deny" }],
              requestedAt: event.occurredAt },
            acpSessionId: "codeops-work-item-admissions", toolCallId: plan.request.admissionId,
            options: [{ optionId: "allow-once", acpOptionId: "allow-once" }, { optionId: "deny", acpOptionId: "deny" }],
          });
          active();
          if (decision?.outcome !== "selected" || decision.acpOptionId !== "allow-once") throw new WorkItemAdmissionPermissionDeniedError("admission permission denied");
          record.request = plan.request;
        }
        active();
        const request = record.request;
        const result = workItemAdmissionResultSchema.parse(await input.context.admitWorkItem(request));
        if (result.admissionId !== request.admissionId || result.parentSessionId !== dispatch.command.sessionId ||
            result.childSessionId !== request.child.sessionId || result.dispatchId !== request.child.dispatchId) throw new Error("admission result drifted");
        return result;
      })().catch((error: unknown) => { delete record.result; throw error; });
    }
    return record.result;
  };
}
