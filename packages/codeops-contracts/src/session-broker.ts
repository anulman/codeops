import { z } from "zod";
import {
  sessionPolicyForMode,
  sessionPolicySchema,
} from "./session-policy.js";
import {
  sessionBudgetProjectionSchema,
  sessionBudgetV2ProjectionSchema,
} from "./session-budget.js";
import {
  workspaceContextAttachmentDescriptorsSchema,
  workspaceContextAttachmentsSchema,
  workspaceManifestSchema,
} from "./workspace-launch.js";

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
export const sessionOwnerPrincipalSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const safeText = (maximum: number) => z.string().min(1).max(maximum);
const optionalText = (maximum: number) => z.string().max(maximum).optional();

export const SESSION_BROKER_VERSION = {
  snapshot: "codeops.session-snapshot/v1",
  checkpoint: "codeops.session-checkpoint/v1",
  workspaceCheckpoint: "codeops.session-workspace-checkpoint/v1",
  command: "codeops.session-command/v1",
  commandResult: "codeops.session-command-result/v1",
  event: "codeops.session-event/v1",
  forkComparison: "codeops.session-fork-comparison/v1",
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
  archived: ["resume", "fork"],
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

export const legacySessionCheckpointSchema = z
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

export const sessionWorkspaceCheckpointSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.workspaceCheckpoint),
    checkpointId: uuid,
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workspaceManifestDigest: sha256Digest,
    sourcePatches: z
      .array(
        z
          .object({
            catalogKey: z.string().min(1).max(63),
            repository: z
              .string()
              .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            baseSha: gitSha,
            patchDigest: sha256Digest,
          })
          .strict(),
      )
      .max(4),
    scratchArtifactDigest: sha256Digest,
    acpSessionId: safeText(500),
    eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidenceReferences: z.array(identifier).max(100),
    createdAt: isoDateTime,
  })
  .strict()
  .refine(
    (checkpoint) =>
      new Set(checkpoint.sourcePatches.map(({ catalogKey }) => catalogKey)).size ===
      checkpoint.sourcePatches.length,
    "workspace checkpoint source patches must be unique",
  );

export const sessionCheckpointSchema = z.union([
  legacySessionCheckpointSchema,
  sessionWorkspaceCheckpointSchema,
]);

export const sessionPermissionOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: safeText(20_000),
      cwd: safeText(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp"),
      server: safeText(200),
      tool: safeText(200),
      argumentsJson: safeText(50_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_change"),
      changes: z
        .array(
          z
            .object({
              path: safeText(2_000),
              oldText: z.string().max(100_000).nullable(),
              newText: z.string().max(100_000),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("work_item"),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      operation: z.enum(["create", "comment", "update", "relate"]),
      targetWorkItemId: uuid.nullable(),
      payloadJson: safeText(50_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("github_mutation"),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      operation: z.enum([
        "branch_publish",
        "pull_request_create",
        "pull_request_update_branch",
        "pull_request_update",
        "review_thread_reply",
        "check_rerun",
      ]),
      pullRequestNumber: z.number().int().positive().max(2_147_483_647).nullable(),
      expectedHeadSha: gitSha,
      targetId: safeText(256).nullable(),
      payloadJson: safeText(50_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_permissions"),
      detailsJson: safeText(50_000),
    })
    .strict(),
]).superRefine((operation, context) => {
  if (
    operation.kind === "file_change" &&
    new TextEncoder().encode(JSON.stringify(operation.changes)).byteLength >
      200_000
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "permission file-change representation exceeds 200000 bytes",
      path: ["changes"],
    });
  }
});

export const sessionPermissionRequestSchema = z
  .object({
    requestId: identifier,
    title: safeText(500),
    description: safeText(5_000),
    operation: sessionPermissionOperationSchema,
    operationDigest: sha256Digest,
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

const sessionIdentityCommonShape = {
  workflowId: workflowRunIdentifier,
  runId: workflowRunIdentifier,
  displayName: safeText(200).optional(),
  workItemId: uuid.optional(),
  pullRequestNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  pullRequestHeadSha: gitSha.optional(),
  agentRole: z
    .enum(["coordinator", "research", "persona", "coding", "critic", "revision"])
    .optional(),
  round: z.number().int().positive().max(100).optional(),
  parentSessionId: identifier.nullable(),
  forkedAtCursor: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
} as const;

function refineSessionIdentity<Schema extends z.ZodTypeAny>(
  schema: Schema,
): z.ZodEffects<Schema, z.output<Schema>, z.input<Schema>> {
  return schema.superRefine((value, context) => {
    const identity = value as {
      readonly parentSessionId: string | null;
      readonly forkedAtCursor: number | null;
      readonly pullRequestNumber?: number;
      readonly pullRequestHeadSha?: string;
      readonly agentRole?: string;
      readonly round?: number;
    };
    if (
      (identity.parentSessionId === null) !==
      (identity.forkedAtCursor === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fork lineage requires both parent session and event cursor",
      });
    }
    if (
      (identity.pullRequestNumber === undefined) !==
      (identity.pullRequestHeadSha === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pull request identity requires both number and head SHA",
      });
    }
    if (
      (identity.agentRole === undefined) !== (identity.round === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent role and round must be supplied together",
      });
    }
  });
}

export const legacySessionIdentitySchema = refineSessionIdentity(
  z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: safeText(200),
    baseSha: gitSha,
    ...sessionIdentityCommonShape,
  })
  .strict(),
);

export const workspaceSessionIdentitySchema = refineSessionIdentity(
  z
    .object({
      version: z.literal("codeops.session-workspace-identity/v1"),
      policy: sessionPolicySchema,
      contextAttachments: workspaceContextAttachmentDescriptorsSchema.default([]),
      workspace: workspaceManifestSchema,
      ...sessionIdentityCommonShape,
    })
    .strict(),
);

export const sessionIdentitySchema = z.union([
  legacySessionIdentitySchema,
  workspaceSessionIdentitySchema,
]);

export function isWorkspaceSessionIdentity(
  identity: z.infer<typeof sessionIdentitySchema>,
): identity is z.infer<typeof workspaceSessionIdentitySchema> {
  return "version" in identity &&
    identity.version === "codeops.session-workspace-identity/v1";
}

export const temporalCodeOpsSessionIdentitySchema = legacySessionIdentitySchema
  .superRefine((identity, context) => {
    if (identity.workItemId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workItemId"],
        message: "Temporal CodeOps sessions require a Plane work item identity",
      });
    }
    if (identity.agentRole === undefined || identity.round === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentRole"],
        message: "Temporal CodeOps sessions require an agent role and round",
      });
    }
  });

const currentSessionSnapshotSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.snapshot),
    sessionId: identifier,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: sessionStateSchema,
    identity: sessionIdentitySchema,
    lease: sessionLeaseSchema.nullable(),
    checkpoint: sessionCheckpointSchema.nullable(),
    pendingPermission: sessionPermissionRequestSchema.nullable(),
    budget: z
      .union([sessionBudgetProjectionSchema, sessionBudgetV2ProjectionSchema])
      .optional(),
    eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capabilities: z.array(sessionCapabilitySchema).length(
      sessionActionTypeSchema.options.length,
    ),
    updatedAt: isoDateTime,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.lease === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session must retain a durable lease identity",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project one pre-policy CodeOps 0.4.2 workspace snapshot into the current
 * immutable identity without changing its stored bytes. Keeping this
 * migration at the read boundary lets an atomic upgrade roll back to 0.4.2:
 * the older strict parser continues to see the original persisted identity.
 */
export function migrateLegacyWorkspaceSessionSnapshot(
  input: unknown,
): unknown {
  if (!isRecord(input) || !isRecord(input.identity)) return input;
  const identity = input.identity;
  if (
    identity.version !== "codeops.session-workspace-identity/v1" ||
    Object.hasOwn(identity, "policy") ||
    Object.hasOwn(identity, "contextAttachments")
  ) {
    return input;
  }
  return {
    ...input,
    identity: {
      ...identity,
      policy: sessionPolicyForMode("implement"),
      contextAttachments: [],
    },
  };
}

export const sessionSnapshotSchema = z.preprocess(
  migrateLegacyWorkspaceSessionSnapshot,
  currentSessionSnapshotSchema,
);

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
    ownerPrincipalId: sessionOwnerPrincipalSchema,
  })
  .strict();

export const sessionJobInitializationResponseSchema = z
  .object({
    version: z.literal("codeops.session-job-initialization-result/v1"),
    disposition: z.enum(["created", "duplicate"]),
    snapshot: sessionSnapshotSchema,
    modelProxyToken: z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).optional(),
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
    contextAttachments: workspaceContextAttachmentsSchema.optional(),
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

const reasonCommand = <Type extends "cancel" | "archive">(
  type: Type,
) =>
  commandBase
    .extend({
      type: z.literal(type),
      reason: safeText(2_000),
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
          "budget_exhausted",
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

const encodedMedia = z
  .string()
  .min(1)
  .max(700_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
const mimeType = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
const resourceUri = z.string().min(1).max(4_000);

export const sessionContentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: safeText(100_000) }).strict(),
  z
    .object({
      type: z.literal("image"),
      data: encodedMedia,
      mimeType: mimeType.refine((value) => value.startsWith("image/")),
      uri: resourceUri.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      data: encodedMedia,
      mimeType: mimeType.refine((value) => value.startsWith("audio/")),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource_link"),
      name: safeText(500),
      uri: resourceUri,
      title: optionalText(500),
      description: optionalText(2_000),
      mimeType: mimeType.optional(),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      uri: resourceUri,
      mimeType: mimeType.optional(),
      text: optionalText(100_000),
      blob: encodedMedia.optional(),
    })
    .strict()
    .refine((resource) => (resource.text === undefined) !== (resource.blob === undefined), {
      message: "embedded resource must contain exactly one text or blob payload",
    }),
]);

const sessionPlanEntrySchema = z
  .object({
    content: safeText(10_000),
    priority: z.enum(["high", "medium", "low"]),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict();

const sessionToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: sessionContentBlockSchema }).strict(),
  z
    .object({
      type: z.literal("diff"),
      path: safeText(2_000),
      oldText: z.string().max(100_000).nullable().optional(),
      newText: z.string().max(100_000),
    })
    .strict(),
  z.object({ type: z.literal("terminal"), terminalId: safeText(500) }).strict(),
]);

const sessionToolFields = {
  toolCallId: safeText(500),
  title: safeText(2_000),
  name: optionalText(500),
  toolKind: z
    .enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"])
    .optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
  content: z.array(sessionToolContentSchema).max(100).optional(),
  locations: z
    .array(
      z
        .object({
          path: safeText(2_000),
          line: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    )
    .max(100)
    .optional(),
} as const;

const sessionConfigurationCommon = {
  id: safeText(200),
  name: safeText(500),
  description: optionalText(2_000),
  category: optionalText(200),
} as const;

const sessionConfigurationOptionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("boolean"),
      ...sessionConfigurationCommon,
      currentValue: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      ...sessionConfigurationCommon,
      currentValue: safeText(500),
      values: z
        .array(
          z
            .object({
              value: safeText(500),
              name: safeText(500),
              description: optionalText(2_000),
              groupId: optionalText(200),
              groupName: optionalText(500),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]).superRefine((option, context) => {
  if (
    option.type === "select" &&
    !option.values.some(({ value }) => value === option.currentValue)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selected configuration value must be available",
    });
  }
});

const sessionTimelineUpdateBaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_content"),
      messageId: z.string().min(1).max(500).nullable().optional(),
      content: sessionContentBlockSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant_content"),
      messageId: z.string().min(1).max(500).nullable().optional(),
      content: sessionContentBlockSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("thought"),
      messageId: z.string().min(1).max(500).nullable().optional(),
      content: sessionContentBlockSchema,
    })
    .strict(),
  z.object({ kind: z.literal("plan"), entries: z.array(sessionPlanEntrySchema).max(100) }).strict(),
  z
    .object({
      kind: z.literal("plan_update"),
      planId: safeText(500),
      content: z.discriminatedUnion("type", [
        z.object({ type: z.literal("items"), entries: z.array(sessionPlanEntrySchema).max(100) }).strict(),
        z.object({ type: z.literal("markdown"), markdown: safeText(100_000) }).strict(),
        z.object({ type: z.literal("file"), uri: resourceUri }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("plan_removed"), planId: safeText(500) }).strict(),
  z.object({ kind: z.literal("tool_call"), ...sessionToolFields }).strict(),
  z
    .object({
      kind: z.literal("tool_call_update"),
      ...sessionToolFields,
      title: optionalText(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("available_commands"),
      commands: z
        .array(
          z
            .object({
              name: safeText(200),
              description: safeText(2_000),
              inputHint: optionalText(500),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("current_mode"),
      modeId: safeText(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configuration"),
      options: z.array(sessionConfigurationOptionSchema).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage"),
      usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      cost: z
        .object({
          amount: z.number().finite().nonnegative().max(1_000_000_000),
          currency: z.string().regex(/^[A-Z]{3}$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supervision"),
      projectionId: uuid,
      childSessionId: identifier,
      childState: sessionStateSchema,
      childEventCursor: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
      workItemId: uuid,
      workflowId: workflowRunIdentifier,
      pullRequestNumber: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      pullRequestHeadSha: gitSha,
      agentRole: z.enum(["coding", "critic", "revision"]),
      round: z.number().int().positive().max(100),
      resultUri: resourceUri.optional(),
    })
    .strict(),
]);

export const sessionTimelineUpdateSchema =
  sessionTimelineUpdateBaseSchema.superRefine((update, context) => {
    if (
      update.kind === "usage" &&
      update.usedTokens > update.contextWindowTokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "usage cannot exceed the context window",
      });
    }
  });

export const sessionUserActionSchema = z
  .object({
    type: sessionActionTypeSchema.exclude(["prompt"]),
    detail: optionalText(2_000),
    decision: z
      .object({
        outcome: z.enum(["selected", "denied"]),
        optionLabel: optionalText(500),
      })
      .strict()
      .optional(),
  })
  .strict();

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
      "runtime_terminal",
    ]),
    message: z
      .discriminatedUnion("role", [
        z
          .object({
            role: z.literal("user"),
            text: safeText(100_000),
            contextAttachments:
              workspaceContextAttachmentDescriptorsSchema.optional(),
            messageId: z.string().min(1).max(500).nullable().optional(),
          })
          .strict(),
        z
          .object({
            role: z.literal("assistant"),
            text: z.string().max(200_000),
            messageId: z.string().min(1).max(500).nullable().optional(),
            stopReason: z
              .enum([
                "end_turn",
                "max_tokens",
                "max_turn_requests",
                "refusal",
                "cancelled",
              ])
              .optional(),
          })
          .strict(),
      ])
      .optional(),
    update: sessionTimelineUpdateSchema.optional(),
    action: sessionUserActionSchema.optional(),
    occurredAt: isoDateTime,
  })
  .strict()
  .superRefine((event, context) => {
    if ([event.message, event.update, event.action].filter(Boolean).length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session event may contain only one message, update, or user action",
      });
    }
    if (
      event.message?.role === "user" &&
      event.type !== "command_committed" &&
      event.type !== "acp_update"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user message events must be command_committed or acp_update events",
        path: ["type"],
      });
    }
    if (event.message?.role === "assistant" && event.type !== "acp_update") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assistant message events must be acp_update events",
        path: ["type"],
      });
    }
  });

export const sessionForkCandidateSchema = z
  .object({
    sessionId: identifier,
    workflowId: workflowRunIdentifier,
    displayName: safeText(500),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: sessionStateSchema,
    eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    eventWindow: z
      .object({
        afterCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        eventCount: z.number().int().nonnegative().max(500),
        truncated: z.boolean(),
      })
      .strict(),
    parentSessionId: identifier.nullable(),
    forkedAtCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    checkpoint: z
      .object({
        checkpointId: uuid,
        eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        patchDigests: z.array(sha256Digest).max(5),
        evidenceReferences: z.array(identifier).max(100),
      })
      .strict()
      .nullable(),
    observedDiff: z
      .object({
        fileCount: z.number().int().nonnegative().max(10_000),
        byteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    testEvidence: z
      .array(
        z
          .object({
            label: safeText(500),
            status: z.enum(["completed", "failed"]),
          })
          .strict(),
      )
      .max(20),
    riskSignals: z.array(safeText(1_000)).max(20),
    latestConclusion: safeText(4_000).nullable(),
  })
  .strict();

const sessionForkComparisonContentSchema = z
  .object({
    version: z.literal(SESSION_BROKER_VERSION.forkComparison),
    lineage: z
      .object({
        parentSessionId: identifier,
        forkedAtCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    target: z
      .object({
        sessionId: identifier,
        workflowId: workflowRunIdentifier,
        generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        eventCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    candidates: z.array(sessionForkCandidateSchema).min(2).max(4),
  })
  .strict();

function refineSessionForkComparison(
  comparison: z.infer<typeof sessionForkComparisonContentSchema>,
  context: z.RefinementCtx,
): void {
    if (
      comparison.target.sessionId !== comparison.lineage.parentSessionId ||
      comparison.target.eventCursor < comparison.lineage.forkedAtCursor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "fork comparison target must be the parent at or after the fork cursor",
      });
    }
    const ids = comparison.candidates.map(({ sessionId }) => sessionId);
    if (new Set(ids).size !== ids.length || ids.includes(comparison.target.sessionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "fork comparison candidates must be unique and exclude the target",
      });
    }
    if (ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) >= 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "fork comparison candidates must use canonical session order",
      });
    }
    for (const [index, candidate] of comparison.candidates.entries()) {
      if (
        candidate.parentSessionId !== comparison.lineage.parentSessionId ||
        candidate.forkedAtCursor !== comparison.lineage.forkedAtCursor
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index],
          message: "fork comparison candidate lineage must match the comparison",
        });
      }
      if (
        candidate.eventWindow.truncated !== (candidate.eventWindow.afterCursor > 0) ||
        candidate.eventWindow.afterCursor + candidate.eventWindow.eventCount !== candidate.eventCursor
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "eventWindow"],
          message: "fork comparison event window must end at the candidate cursor",
        });
      }
    }
}

export const sessionForkComparisonSchema = sessionForkComparisonContentSchema
  .extend({ comparisonDigest: sha256Digest })
  .strict()
  .superRefine(refineSessionForkComparison);

export type SessionActionType = z.infer<typeof sessionActionTypeSchema>;
export type SessionCapability = z.infer<typeof sessionCapabilitySchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type SessionLease = z.infer<typeof sessionLeaseSchema>;
export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;
export type LegacySessionCheckpoint = z.infer<
  typeof legacySessionCheckpointSchema
>;
export type SessionWorkspaceCheckpoint = z.infer<
  typeof sessionWorkspaceCheckpointSchema
>;
export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;
export type LegacySessionIdentity = z.infer<typeof legacySessionIdentitySchema>;
export type WorkspaceSessionIdentity = z.infer<
  typeof workspaceSessionIdentitySchema
>;
export type TemporalCodeOpsSessionIdentity = z.infer<
  typeof temporalCodeOpsSessionIdentitySchema
>;
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
export type SessionContentBlock = z.infer<typeof sessionContentBlockSchema>;
export type SessionTimelineUpdate = z.infer<typeof sessionTimelineUpdateSchema>;
export type SessionPermissionOperation = z.infer<
  typeof sessionPermissionOperationSchema
>;
export type SessionForkCandidate = z.infer<typeof sessionForkCandidateSchema>;
export type SessionForkComparison = z.infer<typeof sessionForkComparisonSchema>;
export type SessionUserAction = z.infer<typeof sessionUserActionSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
