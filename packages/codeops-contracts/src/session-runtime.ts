import { z } from "zod";
import {
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionPermissionRequestSchema,
  sessionIdentitySchema,
  sessionSnapshotSchema,
  sessionTimelineUpdateSchema,
  sessionRuntimeTerminalObservationSchema,
  type SessionCommand,
} from "./session-broker.js";
import { runtimeBindingSchema, runtimeProfileSchema } from "./runtime-profile.js";
export { sessionRuntimeTerminalObservationSchema } from "./session-broker.js";

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
    retryAuthority: z.object({
      dispositionId: uuid,
      rootAdmissionId: uuid,
      attempt: z.number().int().min(2).max(4),
      expiresAt: isoDateTime,
      inputDigest: sha256Digest,
      candidateDigest: sha256Digest,
      runtimeCapabilityDigest: sha256Digest,
      runtimeRelease: z.string().min(1).max(500)
        .regex(/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/),
    }).strict().optional(),
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

export const legacySessionRuntimeCheckpointMaterialSchema = z
  .object({
    checkpointId: uuid,
    patchDigest: sha256Digest,
    acpSessionId: z.string().min(1).max(500),
    evidenceReferences: z.array(identifier).max(100),
  })
  .strict();

export const workspaceSessionRuntimeCheckpointMaterialSchema = z
  .object({
    version: z.literal("codeops.session-workspace-checkpoint-material/v1"),
    checkpointId: uuid,
    workspaceManifestDigest: sha256Digest,
    sourcePatches: z
      .array(
        z
          .object({
            catalogKey: z.string().min(1).max(63),
            repository: z
              .string()
              .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            baseSha: z.string().regex(/^[0-9a-f]{40}$/),
            patchDigest: sha256Digest,
          })
          .strict(),
      )
      .max(4),
    scratchArtifactDigest: sha256Digest,
    acpSessionId: z.string().min(1).max(500),
    evidenceReferences: z.array(identifier).max(100),
  })
  .strict()
  .refine(
    (checkpoint) =>
      new Set(checkpoint.sourcePatches.map(({ catalogKey }) => catalogKey)).size ===
      checkpoint.sourcePatches.length,
    "workspace checkpoint source patches must be unique",
  );

export const sessionRuntimeCheckpointMaterialSchema = z.union([
  legacySessionRuntimeCheckpointMaterialSchema,
  workspaceSessionRuntimeCheckpointMaterialSchema,
]);

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

const sessionRuntimeForkCommon = {
  ...leaseFields,
  sessionId: identifier,
  workflowId: workflowRunIdentifier,
  runId: workflowRunIdentifier,
} as const;

export const sessionRuntimeForkMaterialSchema = z.union([
  z
  .object({
    ...sessionRuntimeForkCommon,
    branch: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    "runtime lease must expire after it is acquired",
  ),
  z
    .object({
      ...sessionRuntimeForkCommon,
      workspace: z.literal(true),
    })
    .strict()
    .refine(
      (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
      "runtime lease must expire after it is acquired",
    ),
]);

export const MAX_SESSION_TIMELINE_UPDATES = 2_000;

export const sessionRuntimeCompletionSchema = z.discriminatedUnion("type", [
  completionBase
    .extend({
      type: z.literal("prompt"),
      material: z
        .object({
          response: z.string().max(200_000),
          checkpoint: sessionRuntimeCheckpointMaterialSchema.optional(),
          stopReason: promptStopReason,
          updates: z
            .array(sessionTimelineUpdateSchema)
            .max(MAX_SESSION_TIMELINE_UPDATES)
            .optional(),
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

const sessionRuntimeDispatchClaimV1Schema = z
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

const sessionRuntimeDispatchClaimBaseSchema = z
  .object({
    dispatch: sessionRuntimeDispatchSchema,
    claimToken: uuid,
    claimExpiresAt: isoDateTime,
    claimCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    runtimeBinding: runtimeBindingSchema,
  })
  .strict();

export const sessionRuntimeDispatchClaimSchema = sessionRuntimeDispatchClaimBaseSchema
  .refine(
    (claim) =>
      Date.parse(claim.claimExpiresAt) > Date.parse(claim.dispatch.dispatchedAt),
    "runtime claim must expire after dispatch",
  );

export const sessionRuntimeDispatchClaimV2Schema = sessionRuntimeDispatchClaimBaseSchema
  .extend({ isAdmittedInitialDispatch: z.boolean() })
  .strict()
  .refine(
    (claim) =>
      Date.parse(claim.claimExpiresAt) > Date.parse(claim.dispatch.dispatchedAt),
    "runtime claim must expire after dispatch",
  );

const sessionRuntimeClaimRequestV1Schema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-request/v1"),
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    leaseId: uuid,
    identity: sessionIdentitySchema,
    leaseMs: z.number().int().min(1_000).max(15 * 60_000),
  })
  .strict();

export const sessionRuntimeClaimRequestV2Schema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-request/v2"),
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    leaseId: uuid,
    identity: sessionIdentitySchema,
    runtimeProfileId: identifier,
    runtimeReleaseDigest: sha256Digest,
    runtimeCapabilityDigest: sha256Digest,
    runtimeProfile: runtimeProfileSchema,
    leaseMs: z.number().int().min(1_000).max(15 * 60_000),
  })
  .strict();

export const sessionRuntimeClaimRequestSchema = z.discriminatedUnion("version", [
  sessionRuntimeClaimRequestV1Schema,
  sessionRuntimeClaimRequestV2Schema,
]).refine((value) => value.version === "codeops.session-runtime-claim-request/v1" || (
  value.runtimeProfile.profileId === value.runtimeProfileId &&
  value.runtimeProfile.releaseDigest === value.runtimeReleaseDigest &&
  value.runtimeProfile.capabilityDigest === value.runtimeCapabilityDigest
), "runtime claim profile must match its selected identity");

const sessionRuntimeClaimResponseV1Schema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-response/v1"),
    claim: sessionRuntimeDispatchClaimV1Schema.nullable(),
  })
  .strict();

export const sessionRuntimeClaimResponseV2Schema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-response/v2"),
    claim: sessionRuntimeDispatchClaimV2Schema.nullable(),
  })
  .strict();

export const sessionRuntimeClaimRenewalRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-renewal-request/v1"),
    claimToken: uuid,
    leaseMs: z.number().int().min(1_000).max(15 * 60_000),
  })
  .strict();

export const sessionRuntimeClaimRenewalResponseSchema = z
  .object({
    version: z.literal("codeops.session-runtime-claim-renewal-result/v1"),
    claim: sessionRuntimeDispatchClaimV2Schema,
  })
  .strict();

export const sessionRuntimeModelAuthorityRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-model-authority-request/v1"),
    claimToken: uuid,
  })
  .strict();

export const sessionRuntimeModelAuthorityResponseSchema = z
  .object({
    version: z.literal("codeops.session-runtime-model-authority-result/v1"),
    dispatchId: uuid,
    modelProxyToken: z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    expiresAt: isoDateTime,
  })
  .strict();

export const sessionRuntimeClaimResponseSchema = z.discriminatedUnion("version", [
  sessionRuntimeClaimResponseV1Schema,
  sessionRuntimeClaimResponseV2Schema,
]);

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
export type SessionRuntimeDispatchClaimV2 = z.infer<
  typeof sessionRuntimeDispatchClaimV2Schema
>;
export type SessionRuntimeModelAuthorityRequest = z.infer<
  typeof sessionRuntimeModelAuthorityRequestSchema
>;
export type SessionRuntimeModelAuthorityResponse = z.infer<
  typeof sessionRuntimeModelAuthorityResponseSchema
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
export type SessionRuntimeTerminalObservation = z.infer<
  typeof sessionRuntimeTerminalObservationSchema
>;
