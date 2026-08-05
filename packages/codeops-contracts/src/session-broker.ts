import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const workflowRunIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const safeText = (maximum: number) => z.string().min(1).max(maximum);

export const SESSION_BROKER_VERSION = {
  snapshot: "codeops.session-snapshot/v1",
  checkpoint: "codeops.session-checkpoint/v1",
  command: "codeops.session-command/v1",
  commandResult: "codeops.session-command-result/v1",
  event: "codeops.session-event/v1",
} as const;

export const sessionActionTypeSchema = z.enum([
  "prompt",
  "respond_permission",
  "cancel",
  "checkpoint",
  "hibernate",
  "resume",
  "fork",
  "archive",
  "delete",
]);

export const sessionStateSchema = z.enum([
  "queued",
  "running",
  "waiting_permission",
  "checkpointing",
  "hibernated",
  "completed",
  "failed",
  "cancelled",
  "archived",
  "deleted",
]);

const sessionStateActionPolicy = {
  queued: ["cancel"],
  running: ["prompt", "cancel", "checkpoint", "hibernate"],
  waiting_permission: [
    "respond_permission",
    "cancel",
    "checkpoint",
    "hibernate",
  ],
  checkpointing: ["cancel"],
  hibernated: ["resume", "fork", "archive"],
  completed: ["fork", "archive"],
  failed: ["fork", "archive"],
  cancelled: ["fork", "archive"],
  archived: ["resume", "fork", "delete"],
  deleted: [],
} as const satisfies Record<
  z.infer<typeof sessionStateSchema>,
  readonly z.infer<typeof sessionActionTypeSchema>[]
>;

export function allowedSessionActionsForState(
  state: z.infer<typeof sessionStateSchema>,
  hasCheckpoint: boolean,
): readonly z.infer<typeof sessionActionTypeSchema>[] {
  return sessionStateActionPolicy[state].filter(
    (action) =>
      hasCheckpoint || (action !== "resume" && action !== "fork"),
  );
}

const enabledCapabilitySchema = z
  .object({
    action: sessionActionTypeSchema,
    availability: z.literal("enabled"),
  })
  .strict();

const disabledCapabilitySchema = z
  .object({
    action: sessionActionTypeSchema,
    availability: z.literal("disabled"),
    reason: safeText(500),
  })
  .strict();

export const sessionCapabilitySchema = z.discriminatedUnion("availability", [
  enabledCapabilitySchema,
  disabledCapabilitySchema,
]);

const sessionLeaseIdentity = z.object({
  leaseId: uuid,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const sessionLeaseSchema = z.discriminatedUnion("status", [
  sessionLeaseIdentity
    .extend({
      status: z.literal("active"),
      holderId: identifier,
      acquiredAt: isoDateTime,
      expiresAt: isoDateTime,
    })
    .strict(),
  sessionLeaseIdentity
    .extend({
      status: z.literal("released"),
      releasedAt: isoDateTime,
    })
    .strict(),
]).superRefine((lease, context) => {
  if (
    lease.status === "active" &&
    Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "active session lease must expire after it is acquired",
      path: ["expiresAt"],
    });
  }
});

export const sessionCheckpointSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.checkpoint),
    checkpointId: uuid,
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    baseSha: gitSha,
    patchDigest: sha256Digest,
    acpSessionId: safeText(500),
    eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidenceReferences: z.array(identifier).max(100),
    createdAt: isoDateTime,
  })
  .strict();

export const sessionPermissionRequestSchema = z
  .object({
    requestId: identifier,
    title: safeText(500),
    description: safeText(5_000),
    options: z
      .array(
        z
          .object({
            optionId: identifier,
            label: safeText(500),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    requestedAt: isoDateTime,
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.options.map(({ optionId }) => optionId)).size ===
      request.options.length,
    "permission request options must be unique",
  );

export const sessionIdentitySchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: safeText(200),
    baseSha: gitSha,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    parentSessionId: identifier.nullable(),
    forkedAtCursor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict()
  .refine(
    (identity) =>
      (identity.parentSessionId === null) ===
      (identity.forkedAtCursor === null),
    "fork lineage requires both parent session and event cursor",
  );

export const sessionSnapshotSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.snapshot),
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: sessionStateSchema,
    identity: sessionIdentitySchema,
    lease: sessionLeaseSchema.nullable(),
    checkpoint: sessionCheckpointSchema.nullable(),
    pendingPermission: sessionPermissionRequestSchema.nullable(),
    eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capabilities: z.array(sessionCapabilitySchema).length(
      sessionActionTypeSchema.options.length,
    ),
    updatedAt: isoDateTime,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.state !== "deleted" && snapshot.lease === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-deleted session must retain a durable lease identity",
        path: ["lease"],
      });
    }
    if (
      snapshot.lease !== null &&
      snapshot.lease.generation !== snapshot.generation
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session lease generation must match the snapshot",
        path: ["lease", "generation"],
      });
    }
    const requiresActiveLease = [
      "running",
      "waiting_permission",
      "checkpointing",
    ].includes(snapshot.state);
    if (
      snapshot.lease !== null &&
      (snapshot.lease.status === "active") !== requiresActiveLease
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session lifecycle and lease status must agree",
        path: ["lease", "status"],
      });
    }
    if (
      snapshot.checkpoint !== null &&
      (snapshot.checkpoint.sessionId !== snapshot.sessionId ||
        snapshot.checkpoint.generation > snapshot.generation ||
        snapshot.checkpoint.eventCursor > snapshot.eventCursor)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session checkpoint must belong to this session history",
        path: ["checkpoint"],
      });
    }
    if (
      (snapshot.state === "waiting_permission") !==
      (snapshot.pendingPermission !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "waiting_permission must retain exactly one pending permission request",
        path: ["pendingPermission"],
      });
    }
    const actions = new Set(snapshot.capabilities.map(({ action }) => action));
    for (const action of sessionActionTypeSchema.options) {
      if (!actions.has(action)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing capability ${action}`,
          path: ["capabilities"],
        });
      }
    }
    if (actions.size !== snapshot.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session capabilities must be unique",
        path: ["capabilities"],
      });
    }
    const enabled = snapshot.capabilities
      .filter(({ availability }) => availability === "enabled")
      .map(({ action }) => action);
    const allowedEnabled = allowedSessionActionsForState(
      snapshot.state,
      snapshot.checkpoint !== null,
    );
    if (enabled.some((action) => !allowedEnabled.includes(action))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enabled capabilities must belong to the session lifecycle state",
        path: ["capabilities"],
      });
    }
    if (
      (enabled.includes("resume") || enabled.includes("fork")) &&
      snapshot.checkpoint === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resume and fork require a committed checkpoint",
        path: ["capabilities"],
      });
    }
  });

export const sessionJobInitializationRequestSchema = z
  .object({
    version: z.literal("codeops.session-job-initialization/v1"),
    sessionId: identifier,
    identity: sessionIdentitySchema.refine(
      (identity) =>
        identity.parentSessionId === null && identity.forkedAtCursor === null,
      "a Job may initialize only a root session",
    ),
    leaseId: uuid,
    holderId: identifier,
  })
  .strict();

export const sessionJobInitializationResponseSchema = z
  .object({
    version: z.literal("codeops.session-job-initialization-result/v1"),
    disposition: z.enum(["created", "duplicate"]),
    snapshot: sessionSnapshotSchema,
  })
  .strict();

const commandBase = z.object({
  version: z.literal(SESSION_BROKER_VERSION.command),
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: uuid,
  idempotencyKey: uuid,
});

const promptCommandSchema = commandBase
  .extend({
    type: z.literal("prompt"),
    prompt: safeText(100_000),
  })
  .strict();

const permissionCommandSchema = commandBase
  .extend({
    type: z.literal("respond_permission"),
    permissionRequestId: identifier,
    decision: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("selected"),
          optionId: identifier,
        })
        .strict(),
      z.object({ outcome: z.literal("denied") }).strict(),
    ]),
  })
  .strict();

const reasonCommand = <Type extends "cancel" | "archive" | "delete">(
  type: Type,
) =>
  commandBase
    .extend({
      type: z.literal(type),
      reason: safeText(2_000),
      ...(type === "delete"
        ? { destructiveAuthorizationId: uuid }
        : {}),
    })
    .strict();

export const sessionCommandSchema = z.discriminatedUnion("type", [
  promptCommandSchema,
  permissionCommandSchema,
  reasonCommand("cancel"),
  commandBase.extend({ type: z.literal("checkpoint") }).strict(),
  commandBase
    .extend({
      type: z.literal("hibernate"),
      reason: safeText(2_000).optional(),
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal("resume"),
      checkpointId: uuid,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal("fork"),
      checkpointId: uuid,
      parentEventCursor: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      title: safeText(500),
    })
    .strict(),
  reasonCommand("archive"),
  reasonCommand("delete"),
]);

const commandResultBase = z.object({
  version: z.literal(SESSION_BROKER_VERSION.commandResult),
  commandId: uuid,
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: uuid,
  idempotencyKey: uuid,
  type: sessionActionTypeSchema,
  eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshot: sessionSnapshotSchema,
  committedAt: isoDateTime,
});

export const sessionCommandResultSchema = z
  .discriminatedUnion("disposition", [
    commandResultBase
      .extend({ disposition: z.literal("committed") })
      .strict(),
    commandResultBase
      .extend({
        disposition: z.literal("duplicate"),
        originalCommandId: uuid,
      })
      .strict(),
    commandResultBase
      .extend({
        disposition: z.literal("rejected"),
        rejectionCode: z.enum([
          "capability_unavailable",
          "generation_conflict",
          "lease_conflict",
          "authorization_denied",
          "invalid_state",
        ]),
        reason: safeText(2_000),
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (result.disposition === "rejected") return;
    if (result.type === "fork") {
      if (
        result.snapshot.sessionId === result.sessionId ||
        result.snapshot.identity.parentSessionId !== result.sessionId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fork result must return a child snapshot bound to the parent",
          path: ["snapshot"],
        });
      }
      return;
    }
    if (result.snapshot.sessionId !== result.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command result snapshot must belong to the target session",
        path: ["snapshot", "sessionId"],
      });
    }
    const expectedGeneration =
      result.type === "resume" ? result.generation + 1 : result.generation;
    if (result.snapshot.generation !== expectedGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "committed command returned an unexpected session generation",
        path: ["snapshot", "generation"],
      });
    }
  });

export const sessionCommandAcceptedSchema = z
  .object({
    version: z.literal("codeops.session-command-accepted/v1"),
    disposition: z.literal("accepted"),
    dispatchId: uuid,
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    leaseId: uuid,
    idempotencyKey: uuid,
    type: sessionActionTypeSchema,
  })
  .strict();

export const sessionCommandSubmissionSchema = z.union([
  sessionCommandResultSchema,
  sessionCommandAcceptedSchema,
]);

export const sessionEventSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.event),
    eventId: sha256Digest,
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.enum([
      "session_created",
      "state_changed",
      "acp_update",
      "permission_requested",
      "command_committed",
      "checkpoint_committed",
      "lease_changed",
      "session_archived",
      "session_deleted",
    ]),
    occurredAt: isoDateTime,
  })
  .strict();

export type SessionActionType = z.infer<typeof sessionActionTypeSchema>;
export type SessionCapability = z.infer<typeof sessionCapabilitySchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type SessionLease = z.infer<typeof sessionLeaseSchema>;
export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;
export type SessionPermissionRequest = z.infer<
  typeof sessionPermissionRequestSchema
>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionJobInitializationRequest = z.infer<
  typeof sessionJobInitializationRequestSchema
>;
export type SessionJobInitializationResponse = z.infer<
  typeof sessionJobInitializationResponseSchema
>;
export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export type SessionCommandResult = z.infer<typeof sessionCommandResultSchema>;
export type SessionCommandAccepted = z.infer<typeof sessionCommandAcceptedSchema>;
export type SessionCommandSubmission = z.infer<
  typeof sessionCommandSubmissionSchema
>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
