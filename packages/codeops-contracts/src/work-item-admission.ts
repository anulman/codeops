import { z } from "zod";
import { sessionRuntimeDispatchSchema } from "./session-runtime.js";
import { sessionPolicySchema } from "./session-policy.js";
import { workspaceSessionIdentitySchema } from "./session-broker.js";
import {
  workspaceContextAttachmentsSchema,
  workspaceSourceSchema,
} from "./workspace-launch.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const lifecycleEventId = z.string().regex(/^event:[0-9a-f]{64}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const isoDateTime = z.string().datetime({ offset: true });
const immutableImage = z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
const release = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);

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

export const admittedChildMaterializationInputSchema = z.object({
  version: z.literal("codeops.admitted-child-materialization-input/v1"),
  admissionId: uuid,
  admissionDigest: digest,
  approvalId: uuid,
  approvalDigest: digest,
  parentSessionId: identifier,
  childSessionId: identifier,
  childDispatchId: uuid,
  principalId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/),
  workItem: workItemIdentitySchema.extend({
    workflowId: identifier,
    runId: identifier,
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  }).strict(),
  source: workspaceSourceSchema,
  policy: sessionPolicySchema,
  profile: z.enum(["full-managed", "full-external", "custom"]),
  release,
  images: z.object({ agent: immutableImage, runtimeWorker: immutableImage }).strict(),
  contextAttachments: workspaceContextAttachmentsSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lease: z.object({
    leaseId: uuid,
    holderId: identifier,
    acquiredAt: isoDateTime,
    expiresAt: isoDateTime,
  }).strict().refine((value) => Date.parse(value.expiresAt) > Date.parse(value.acquiredAt),
    "materialization lease must expire after acquisition"),
  workflowId: identifier,
  runId: identifier,
  initialDispatch: sessionRuntimeDispatchSchema,
  identity: workspaceSessionIdentitySchema,
  admittedAt: isoDateTime,
}).strict().superRefine((input, context) => {
  const failures = [
    input.workItem.repository !== input.source.repository,
    input.workItem.sourceSha !== input.source.resolvedSha,
    input.workItem.workflowId !== input.workflowId,
    input.workItem.runId !== input.runId,
    input.initialDispatch.dispatchId !== input.childDispatchId,
    input.initialDispatch.principalId !== input.principalId,
    input.initialDispatch.command.sessionId !== input.childSessionId,
    input.initialDispatch.command.generation !== input.generation,
    input.initialDispatch.command.leaseId !== input.lease.leaseId,
    input.initialDispatch.snapshot.sessionId !== input.childSessionId,
    input.initialDispatch.snapshot.generation !== input.generation,
    input.initialDispatch.snapshot.lease?.leaseId !== input.lease.leaseId,
    JSON.stringify(input.identity) !== JSON.stringify(input.initialDispatch.snapshot.identity),
    JSON.stringify(input.identity.policy) !== JSON.stringify(input.policy),
    input.identity.workflowId !== input.workflowId,
    input.identity.runId !== input.runId,
    !input.identity.workspace.sources.some((source) =>
      source.repository === input.source.repository &&
      source.resolvedSha === input.source.resolvedSha),
  ];
  if (failures.some(Boolean)) context.addIssue({ code: z.ZodIssueCode.custom,
    message: "materialization input identities must bind exactly" });
});

const materializationStateBase = z.object({
  version: z.literal("codeops.admitted-child-materialization-state/v1"),
  admissionId: uuid,
  inputDigest: digest,
  attemptCount: z.number().int().nonnegative().max(100_000),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  resources: z.object({
    sourceAuthority: z.object({ uid: z.string().min(1).max(256), configDigest: digest,
      resourceName: z.string().min(1).max(253).optional() }).strict().optional(),
    workspaceStorage: z.object({ uid: z.string().min(1).max(256), configDigest: digest,
      resourceName: z.string().min(1).max(253).optional() }).strict().optional(),
    sourceMaterializer: z.object({ uid: z.string().min(1).max(256), configDigest: digest,
      resourceName: z.string().min(1).max(253).optional() }).strict().optional(),
    workspaceRuntime: z.object({ uid: z.string().min(1).max(256), configDigest: digest,
      resourceName: z.string().min(1).max(253).optional() }).strict().optional(),
  }).strict(),
  resourceReplacements: z.object({
    sourceAuthority: z.object({
      uid: z.string().min(1).max(256),
      resourceName: z.string().min(1).max(253),
      configDigest: digest,
      desiredConfigDigest: digest,
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const materializationCleanupResidualSchema = z.discriminatedUnion("reason", [
  z.object({
    resourceRole: z.enum(["source-authority", "source-materializer", "workspace-runtime"]),
    reason: z.literal("immutable-identity-drift"),
  }).strict(),
  z.object({
    resourceRole: z.enum(["source-authority", "source-materializer", "workspace-runtime"]),
    reason: z.literal("kubernetes-permanent-failure"),
    operation: z.enum(["ensure", "get-job", "list-pods", "get-pod-logs", "delete", "recover"]),
    status: z.number().int().min(100).max(599),
  }).strict(),
]);

export const admittedChildMaterializationStateSchema = z.discriminatedUnion("state", [
  materializationStateBase.extend({ state: z.literal("queued") }).strict(),
  materializationStateBase.extend({ state: z.literal("provisioning") }).strict(),
  materializationStateBase.extend({ state: z.literal("runtime-authorized") }).strict(),
  materializationStateBase.extend({ state: z.literal("success-finalizing"),
    finalizingAt: isoDateTime }).strict(),
  materializationStateBase.extend({ state: z.literal("cleanup-pending"),
    failureCode: z.enum(["authority-drift", "identity-conflict", "resource-configuration",
      "source-unavailable", "provisioning-failed", "provisioning-timeout"]),
    failedAt: isoDateTime,
    cleanupResiduals: z.array(materializationCleanupResidualSchema).max(3).optional() }).strict(),
  materializationStateBase.extend({ state: z.literal("ready"), readyAt: isoDateTime }).strict(),
  materializationStateBase.extend({ state: z.literal("failed"),
    failureCode: z.enum(["authority-drift", "identity-conflict", "resource-configuration",
      "source-unavailable",
      "provisioning-failed", "provisioning-timeout"]), failedAt: isoDateTime,
    cleanupResiduals: z.array(materializationCleanupResidualSchema).max(3).optional() }).strict(),
]);

export type WorkItemAdmissionRequest = z.infer<typeof workItemAdmissionRequestSchema>;
export type WorkItemAdmissionResult = z.infer<typeof workItemAdmissionResultSchema>;
export type AdmittedChildMaterializationInput = z.infer<typeof admittedChildMaterializationInputSchema>;
export type AdmittedChildMaterializationState = z.infer<typeof admittedChildMaterializationStateSchema>;
