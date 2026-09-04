import { z } from "zod";

import { providerEffectStateSchema } from "./github-mutations.js";
import { sessionRuntimeTerminalObservationSchema } from "./session-runtime.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const principal = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const isoDateTime = z.string().datetime({ offset: true });
const immutableImage = z.string().min(1).max(500)
  .regex(/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/);

export const workItemRetryDispositionKindSchema = z.enum([
  "retry-same-input",
  "recover-checkpoint",
  "correct-candidate",
  "replan",
  "wait-external",
  "wait-human",
  "reconcile-unknown-effect",
  "stop-terminal",
]);

export const retryTransientFailureCodeSchema = z.enum([
  "rate_limited",
  "provider_timeout",
  "provider_unavailable",
  "transport_error",
  "server_error",
]);

const effectNone = z.object({
  state: z.literal("none"),
  preEffectProofDigest: digest,
  proofEventId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const effectReceipt = z.object({
  state: providerEffectStateSchema,
  effectId: z.string().regex(/^githubmutation-[0-9a-f]{64}$/),
  receiptDigest: digest,
  failureCode: retryTransientFailureCodeSchema.nullable(),
}).strict().superRefine((effect, context) => {
  if ((effect.state === "failed") !== (effect.failureCode !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failureCode"],
      message: "only a failed provider effect can carry one transient failure code" });
  }
});

export const workItemRetryEffectFenceSchema = z.union([effectNone, effectReceipt]);

const successorSchema = z.object({
  admissionId: uuid,
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: uuid,
  holderId: identifier,
  dispatchId: uuid,
  idempotencyKey: uuid,
  prompt: z.string().min(1).max(100_000),
  inputDigest: digest,
  candidateDigest: digest,
  runtimeCapabilityDigest: digest,
  runtimeRelease: immutableImage,
}).strict();

export const workItemRetryDispositionRequestSchema = z.object({
  version: z.literal("codeops.work-item-retry-disposition/v1"),
  dispositionId: uuid,
  lineageRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rootAdmissionId: uuid,
  predecessorSessionId: identifier,
  kind: workItemRetryDispositionKindSchema,
  reasonCode: identifier,
  authority: z.object({
    repository,
    provider: z.object({ kind: z.literal("plane"), workspaceId: uuid, projectId: uuid }).strict(),
    workItemId: uuid,
    workflowId: identifier,
    runId: identifier,
    sourceSha: gitSha,
    ownerPrincipalId: principal,
    predecessorGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    predecessorLeaseId: uuid,
    expiresAt: isoDateTime,
  }).strict(),
  terminalObservation: sessionRuntimeTerminalObservationSchema,
  providerEffect: workItemRetryEffectFenceSchema,
  budget: z.object({
    rootBudgetId: identifier,
    rootRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    providerRequestsConsumed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokensConsumed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  successor: successorSchema.nullable(),
}).strict().superRefine((request, context) => {
  const admittingKind = ["retry-same-input", "recover-checkpoint", "correct-candidate"].includes(request.kind);
  const admits = request.successor !== null;
  if (admits && !admittingKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["successor"],
      message: "only an admitting retry disposition can contain a successor" });
  }
  if (admittingKind && !admits) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["successor"],
      message: "an admitting retry disposition requires one exact successor" });
  }
  if (request.terminalObservation.cause.type !== "failed" ||
      request.terminalObservation.sessionId !== request.predecessorSessionId ||
      request.terminalObservation.generation !== request.authority.predecessorGeneration ||
      request.terminalObservation.leaseId !== request.authority.predecessorLeaseId ||
      request.terminalObservation.runId !== request.authority.runId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalObservation"],
      message: "retry disposition must bind the exact failed predecessor identity" });
  }
  const retryEligibleEffect = request.providerEffect.state === "none" ||
    request.providerEffect.state === "failed";
  if (admits && !retryEligibleEffect) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["providerEffect", "state"],
      message: "provider-effect state blocks successor admission" });
  }
  if (request.providerEffect.state === "authorized" && request.kind !== "stop-terminal") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"],
      message: "an authorized unattempted effect cannot be resumed atomically" });
  }
  if (request.providerEffect.state === "authorized" && request.successor !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["successor"],
      message: "an authorized unattempted effect cannot admit a successor" });
  }
  if (["attempting", "unknown"].includes(request.providerEffect.state) &&
      request.kind !== "reconcile-unknown-effect") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"],
      message: "an indeterminate provider effect requires reconciliation" });
  }
  if (["succeeded", "reconciled_satisfied"].includes(request.providerEffect.state) &&
      request.kind !== "stop-terminal") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"],
      message: "a satisfied provider effect is terminal" });
  }
});

export const workItemRetryDispositionResultSchema = z.object({
  version: z.literal("codeops.work-item-retry-disposition-result/v1"),
  dispositionId: uuid,
  disposition: z.enum(["created", "replayed"]),
  rootAdmissionId: uuid,
  attempt: z.number().int().min(1).max(4),
  successorSessionId: identifier.nullable(),
  successorDispatchId: uuid.nullable(),
  lifecycleEventId: z.string().regex(/^event:[0-9a-f]{64}$/),
  supervisionEventId: digest,
}).strict();

export type WorkItemRetryDispositionRequest = z.infer<typeof workItemRetryDispositionRequestSchema>;
export type WorkItemRetryDispositionResult = z.infer<typeof workItemRetryDispositionResultSchema>;
