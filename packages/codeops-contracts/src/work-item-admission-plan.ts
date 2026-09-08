import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonText, sha256CanonicalJsonDigest } from "./canonical-json.js";
import { isWorkspaceSessionIdentity, sessionEventSchema, sessionPermissionOperationSchema,
  sessionTimelineUpdateSchema } from "./session-broker.js";
import { sessionRuntimeDispatchSchema } from "./session-runtime.js";
import { workItemAdmissionRequestSchema } from "./work-item-admission.js";

export const workItemAdmissionInputSchema = workItemAdmissionRequestSchema.shape.workItem
  .pick({ repository: true, workItemId: true, title: true, prompt: true })
  .extend({ title: z.string().trim().min(1).max(200), prompt: z.string().min(1).max(20_000) });
export const workItemMembershipSchema = workItemAdmissionRequestSchema.shape.workItem
  .pick({ repository: true, provider: true, workItemId: true });
export const preparedWorkItemAdmissionSchema = workItemAdmissionRequestSchema.omit({ version: true, claimToken: true });
export const workItemAdmissionPlanRequestSchema = z.object({
  version: z.literal("codeops.work-item-admission-plan-request/v1"),
  claimToken: z.string().uuid(), input: workItemAdmissionInputSchema,
}).strict();
export const workItemAdmissionPlanResultSchema = z.object({
  version: z.literal("codeops.work-item-admission-plan-result/v1"),
  event: sessionEventSchema, request: preparedWorkItemAdmissionSchema,
}).strict();
export type WorkItemAdmissionInput = z.infer<typeof workItemAdmissionInputSchema>;
export type WorkItemMembership = z.infer<typeof workItemMembershipSchema>;
export type WorkItemAdmissionPlanResult = z.infer<typeof workItemAdmissionPlanResultSchema>;

export const ADMISSION_PLAN_PREFIX = "work-item-admission:";
function uuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

/** Inputs other than the bounded proposal come only from trusted runtime state. */
export function buildWorkItemAdmissionPlan(rawDispatch: unknown, rawInput: unknown, rawMembership: unknown) {
  const dispatch = sessionRuntimeDispatchSchema.parse(rawDispatch);
  const input = workItemAdmissionInputSchema.parse(rawInput);
  const membership = workItemMembershipSchema.parse(rawMembership);
  const identity = dispatch.snapshot.identity;
  if (dispatch.command.type !== "prompt" || !isWorkspaceSessionIdentity(identity)) throw new Error("workspace prompt required");
  const source = identity.workspace.sources.find((source) => source.repository === input.repository);
  if (!source || membership.repository !== input.repository || membership.workItemId !== input.workItemId) throw new Error("admission membership or source drifted");
  // Content is intentionally absent from the operation key: changed content for
  // one work item in one dispatch must conflict, never create a replacement.
  const key = canonicalJsonText({ dispatchId: dispatch.dispatchId, repository: input.repository, workItemId: input.workItemId });
  const admissionId = uuid(`admission:${key}`);
  const child = { sessionId: `ses_${admissionId.replaceAll("-", "")}`,
    leaseId: uuid(`lease:${key}`), holderId: `admitted:${admissionId}`,
    dispatchId: uuid(`dispatch:${key}`), idempotencyKey: uuid(`command:${key}`) };
  const workItem = { ...input, provider: membership.provider, sourceSha: source.resolvedSha,
    workflowId: `work-item-${admissionId}`, runId: `admission-${admissionId}` };
  const planId = `${ADMISSION_PLAN_PREFIX}${admissionId}`;
  const content = { type: "markdown" as const, markdown: canonicalJsonText({
    workItem, child, source, contextAttachments: identity.contextAttachments }) };
  const update = sessionTimelineUpdateSchema.parse({ kind: "plan_update", planId, content });
  const planDigest = sha256CanonicalJsonDigest(content);
  const operation = sessionPermissionOperationSchema.parse({ kind: "project_plan", planId, planDigest, workItems: [membership] });
  const permissionRequestId = `permission-${createHash("sha256").update(canonicalJsonText(operation))
    .update("\0").update(dispatch.dispatchId).update("\0").update(admissionId).digest("hex")}`;
  const request = preparedWorkItemAdmissionSchema.parse({ admissionId, child, workItem,
    plan: { planId, planDigest, permissionRequestId } });
  const eventId = sha256CanonicalJsonDigest({ kind: "work-item-admission-plan", dispatchId: dispatch.dispatchId, planId });
  return { request, operation, update, eventId };
}
