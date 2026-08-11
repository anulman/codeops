import { z } from "zod";
import {
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionPermissionRequestSchema,
  sessionIdentitySchema,
  sessionSnapshotSchema,
  sessionTimelineUpdateSchema,
  type SessionCommand,
} from "./session-broker.js";

const uuid = z.string().uuid();
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const workflowRunIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoDateTime = z.string().datetime({ offset: true });
const principal = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/);
const boundedAcpIdentity = z.string().min(1).max(500);
const promptStopReason = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export const sessionRuntimeCommandTypes = [
  "prompt",
  "checkpoint",
  "hibernate",
  "resume",
  "fork",
] as const;

export type SessionRuntimeCommand = Extract<
  SessionCommand,
  { readonly type: (typeof sessionRuntimeCommandTypes)[number] }
>;

export const sessionRuntimeCommandSchema = sessionCommandSchema.refine(
  (command): command is SessionRuntimeCommand =>
    sessionRuntimeCommandTypes.includes(
      command.type as (typeof sessionRuntimeCommandTypes)[number],
    ),
  "session command does not require the ACP runtime",
);

export const sessionRuntimeDispatchSchema = z
  .object({
    version: z.literal("codeops.session-runtime-dispatch/v1"),
    dispatchId: uuid,
    principalId: principal,
    command: sessionRuntimeCommandSchema,
    snapshot: sessionSnapshotSchema,
    dispatchedAt: isoDateTime,
  })
  .strict()
  .superRefine((dispatch, context) => {
    const { command, snapshot } = dispatch;
    if (
      command.sessionId !== snapshot.sessionId ||
      command.generation !== snapshot.generation ||
      command.leaseId !== snapshot.lease?.leaseId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime dispatch must bind the exact session generation and lease",
        path: ["command"],
      });
    }
    if (
      snapshot.capabilities.find(({ action }) => action === command.type)
        ?.availability !== "enabled"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime dispatch requires an enabled session capability",
        path: ["snapshot", "capabilities"],
      });
    }
  });

const completionBase = z.object({
  version: z.literal("codeops.session-runtime-completion/v1"),
  dispatchId: uuid,
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: uuid,
  idempotencyKey: uuid,
  observedEventCursor: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  completedAt: isoDateTime,
});

export const sessionRuntimeCheckpointMaterialSchema = z
  .object({
    checkpointId: uuid,
    patchDigest: sha256Digest,
    acpSessionId: z.string().min(1).max(500),
    evidenceReferences: z.array(identifier).max(100),
  })
  .strict();

const leaseFields = {
  leaseId: uuid,
  holderId: identifier,
  acquiredAt: isoDateTime,
  expiresAt: isoDateTime,
} as const;

export const sessionRuntimeLeaseMaterialSchema = z
  .object(leaseFields)
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    "runtime lease must expire after it is acquired",
  );

export const sessionRuntimeForkMaterialSchema = z
  .object({
    ...leaseFields,
    sessionId: identifier,
    branch: z.string().min(1).max(200),
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
  })
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    "runtime lease must expire after it is acquired",
  );

export const sessionRuntimeCompletionSchema = z.discriminatedUnion("type", [
  completionBase
    .extend({
      type: z.literal("prompt"),
      material: z
        .object({
          response: z.string().max(200_000),
          stopReason: promptStopReason,
          updates: z.array(sessionTimelineUpdateSchema).max(499).optional(),
        })
        .strict(),
    })
    .strict(),
  completionBase
    .extend({
      type: z.literal("checkpoint"),
      material: sessionRuntimeCheckpointMaterialSchema,
    })
    .strict(),
  completionBase
    .extend({
      type: z.literal("hibernate"),
      material: sessionRuntimeCheckpointMaterialSchema,
    })
    .strict(),
  completionBase
    .extend({
      type: z.literal("resume"),
      material: sessionRuntimeLeaseMaterialSchema,
    })
    .strict(),
  completionBase
    .extend({
      type: z.literal("fork"),
      material: sessionRuntimeForkMaterialSchema,
    })
    .strict(),
]);

export const sessionRuntimeDispatchClaimSchema = z
  .object({
    dispatch: sessionRuntimeDispatchSchema,
    claimToken: uuid,
    claimExpiresAt: isoDateTime,
    claimCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (claim) =>
      Date.parse(claim.claimExpiresAt) > Date.parse(claim.dispatch.dispatchedAt),
    "runtime claim must expire after dispatch",
  );

export const sessionRuntimeClaimRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-request/v1"),
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    leaseId: uuid,
    identity: sessionIdentitySchema,
    leaseMs: z.number().int().min(1_000).max(15 * 60_000),
  })
  .strict();

export const sessionRuntimeClaimResponseSchema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-response/v1"),
    claim: sessionRuntimeDispatchClaimSchema.nullable(),
  })
  .strict();

export const sessionRuntimeCompletionRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-completion-request/v1"),
    claimToken: uuid,
    completion: sessionRuntimeCompletionSchema,
  })
  .strict();

export const sessionRuntimeCompletionResponseSchema =
  sessionCommandResultSchema;

export const sessionRuntimePermissionSubmissionSchema = z
  .object({
    version: z.literal("codeops.session-runtime-permission-submission/v1"),
    claimToken: uuid,
    request: sessionPermissionRequestSchema,
    acpSessionId: boundedAcpIdentity,
    toolCallId: boundedAcpIdentity,
    options: z
      .array(
        z
          .object({
            optionId: identifier,
            acpOptionId: boundedAcpIdentity,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((submission, context) => {
    const brokerOptionIds = submission.request.options.map(
      ({ optionId }) => optionId,
    );
    const mappedOptionIds = submission.options.map(({ optionId }) => optionId);
    if (
      new Set(mappedOptionIds).size !== mappedOptionIds.length ||
      brokerOptionIds.length !== mappedOptionIds.length ||
      brokerOptionIds.some((optionId) => !mappedOptionIds.includes(optionId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime permission options must map every broker option exactly once",
        path: ["options"],
      });
    }
  });

export const sessionRuntimePermissionPollSchema = z
  .object({
    version: z.literal("codeops.session-runtime-permission-poll/v1"),
    claimToken: uuid,
    requestId: identifier,
  })
  .strict();

const permissionDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), acpOptionId: boundedAcpIdentity }).strict(),
  z.object({ outcome: z.literal("denied") }).strict(),
]);

export const sessionRuntimePermissionResultSchema = z
  .object({
    version: z.literal("codeops.session-runtime-permission-result/v1"),
    dispatchId: uuid,
    requestId: identifier,
    disposition: z.enum(["pending", "decided"]),
    decision: permissionDecisionSchema.nullable(),
  })
  .strict()
  .refine(
    (result) =>
      (result.disposition === "pending") === (result.decision === null),
    "a runtime permission result has a decision exactly when decided",
  );

export type SessionRuntimeDispatch = z.infer<
  typeof sessionRuntimeDispatchSchema
>;
export type SessionRuntimeCompletion = z.infer<
  typeof sessionRuntimeCompletionSchema
>;
export type SessionRuntimeDispatchClaim = z.infer<
  typeof sessionRuntimeDispatchClaimSchema
>;
export type SessionRuntimePermissionSubmission = z.infer<
  typeof sessionRuntimePermissionSubmissionSchema
>;
export type SessionRuntimePermissionPoll = z.infer<
  typeof sessionRuntimePermissionPollSchema
>;
export type SessionRuntimePermissionResult = z.infer<
  typeof sessionRuntimePermissionResultSchema
>;
