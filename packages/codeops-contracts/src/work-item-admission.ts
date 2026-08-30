import { z } from "zod";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const lifecycleEventId = z.string().regex(/^event:[0-9a-f]{64}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);

const workItemIdentitySchema = z.object({
  repository,
  provider: z.object({ kind: z.literal("plane"), workspaceId: uuid, projectId: uuid }).strict(),
  workItemId: uuid,
}).strict();

export const workItemAdmissionRequestSchema = z.object({
  version: z.literal("codeops.work-item-admission/v1"),
  admissionId: uuid,
  claimToken: uuid,
  plan: z.object({ planId: z.string().min(1).max(500), planDigest: digest,
    permissionRequestId: identifier }).strict(),
  workItem: workItemIdentitySchema.extend({ workflowId: identifier, runId: identifier,
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/), title: z.string().min(1).max(500),
    prompt: z.string().min(1).max(100_000) }).strict(),
  child: z.object({ sessionId: identifier, leaseId: uuid, holderId: identifier,
    dispatchId: uuid, idempotencyKey: uuid }).strict(),
}).strict();

export const workItemAdmissionResultSchema = z.object({
  version: z.literal("codeops.work-item-admission-result/v1"), admissionId: uuid,
  disposition: z.enum(["created", "replayed"]), parentSessionId: identifier,
  childSessionId: identifier, dispatchId: uuid, lifecycleEventId,
  supervisionEventId: digest,
}).strict();

export type WorkItemAdmissionRequest = z.infer<typeof workItemAdmissionRequestSchema>;
export type WorkItemAdmissionResult = z.infer<typeof workItemAdmissionResultSchema>;
