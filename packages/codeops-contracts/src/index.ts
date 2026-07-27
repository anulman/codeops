import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

const VERSION = {
  workItem: "codeops.work-item/v1",
  event: "codeops.workflow-event/v1",
  controlCommand: "codeops.control-command/v1",
  controlResult: "codeops.control-result/v1",
  evidence: "codeops.evidence/v1",
  secretReference: "codeops.secret-reference/v1",
  planeCommentEvent: "codeops.plane-comment-event/v1",
  researchRequest: "codeops.research-request/v2",
  researchPersonaReport: "codeops.research-persona-report/v1",
  researchPacket: "codeops.research-packet/v2",
  researchMutationBatch: "codeops.research-mutation-batch/v1",
  readinessGate: "codeops.readiness-gate/v1",
  codingRequest: "codeops.coding-request/v1",
  agentJobDispatch: "codeops.agent-job-dispatch/v1",
  agentJobDispatchResult: "codeops.agent-job-dispatch-result/v1",
} as const;

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
const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[a-zA-Z0-9._/-]+$/)
  .refine(
    (value) =>
      value !== "HEAD" &&
      !value.startsWith("-") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock") &&
      value.split("/").every((component) => !component.startsWith(".")),
    "invalid Git branch name",
  );
const repository = z
  .object({
    owner: z.string().min(1).max(100).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();
const isoDateTime = z.string().datetime({ offset: true });
const safeText = (maximum: number) => z.string().min(1).max(maximum);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();

function hasSafeEvidenceUri(value: string): boolean {
  if (value.length > 2_048) return false;

  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") {
      return url.hostname.length > 0 && !url.search;
    }
    if (url.protocol === "s3:") {
      return url.hostname.length > 0 && url.pathname.length > 1 && !url.search;
    }
    if (url.protocol === "artifact:") {
      return !url.host && url.pathname.startsWith("/") && url.pathname.length > 1 && !url.search;
    }
  } catch {
    return false;
  }

  return false;
}

export const secretReferenceSchema = z
  .object({
    version: z.literal(VERSION.secretReference),
    provider: z.enum(["kubernetes", "github-actions", "external-secrets"]),
    reference: identifier,
    scope: identifier,
  })
  .strict();

export const evidenceReferenceSchema = z
  .object({
    version: z.literal(VERSION.evidence),
    kind: z.enum(["log", "test-report", "patch", "checkpoint", "artifact", "video"]),
    uri: z.string().refine(hasSafeEvidenceUri, "unsafe evidence URI"),
    digest: sha256Digest,
    sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
    mediaType: z.string().min(1).max(128),
  })
  .strict();

export const workItemRequestSchema = z
  .object({
    version: z.literal(VERSION.workItem),
    workItemId: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    repository,
    baseSha: gitSha,
    branch: branchName,
    summary: safeText(500),
    acceptanceCriteria: z.array(safeText(2_000)).min(1).max(50),
    secretReferences: z.array(secretReferenceSchema).max(32).default([]),
    requestedAt: isoDateTime,
  })
  .strict();

export const codingRequestSchema = z
  .object({
    version: z.literal(VERSION.codingRequest),
    requestId: identifier,
    eventId: identifier,
    workspaceId: uuid,
    projectId: uuid,
    requestedBy: uuid,
    planeRevisionDigest: sha256Digest,
    workItem: workItemRequestSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.requestId !== request.workItem.workflowId ||
      request.workItem.runId !== request.workItem.workflowId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workItem", "workflowId"],
        message:
          "coding request identity must match its workflow and initial run identity",
      });
    }
  });

export const workflowStateSchema = z.enum([
  "requested",
  "started",
  "stage_changed",
  "attention_required",
  "approval_required",
  "evidence_ready",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function canonicalSerialize(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
    .join(",")}}`;
}

function logicalId(namespace: string, parts: Readonly<Record<string, string>>): string {
  const digest = createHash("sha256")
    .update(canonicalSerialize({ namespace, ...parts }))
    .digest("hex");
  return `${namespace}:${digest}`;
}

export function createTransitionId(input: {
  workflowId: string;
  transitionKey: string;
  version?: typeof VERSION.event;
}): string {
  return logicalId("transition", {
    version: input.version ?? VERSION.event,
    workflowId: workflowRunIdentifier.parse(input.workflowId),
    transitionKey: identifier.parse(input.transitionKey),
  });
}

export function createEventId(input: {
  workflowId: string;
  transitionId: string;
  version?: typeof VERSION.event;
}): string {
  return logicalId("event", {
    version: input.version ?? VERSION.event,
    workflowId: workflowRunIdentifier.parse(input.workflowId),
    transitionId: identifier.parse(input.transitionId),
  });
}

export const workflowEventSchema = z
  .object({
    version: z.literal(VERSION.event),
    eventId: identifier,
    transitionId: identifier,
    transitionKey: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    workItemId: identifier,
    state: workflowStateSchema,
    baseSha: gitSha,
    occurredAt: isoDateTime,
    summary: safeText(1_000),
    evidence: z.array(evidenceReferenceSchema).max(32).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    const transitionId = createTransitionId(event);
    if (event.transitionId !== transitionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitionId"],
        message: "transitionId does not match the logical transition",
      });
    }
    const eventId = createEventId(event);
    if (event.eventId !== eventId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventId"],
        message: "eventId does not match the logical event",
      });
    }
  });

const commandBase = {
  commandId: identifier,
  workflowId: workflowRunIdentifier,
  runId: workflowRunIdentifier,
  requestedAt: isoDateTime,
};

export const controlCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("attach"),
      payload: z.object({ fromSequence: z.number().int().nonnegative().max(1_000_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("status"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("follow_up"),
      payload: z.object({ message: safeText(8_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("cancel"),
      payload: z.object({ reason: safeText(1_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("permission_response"),
      payload: z
        .object({
          requestId: identifier,
          decision: z.enum(["approve", "deny"]),
          reason: z.string().max(1_000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const controlResultSchema = z
  .object({
    version: z.literal(VERSION.controlResult),
    commandId: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    status: z.enum(["accepted", "applied", "duplicate", "rejected"]),
    message: z.string().max(1_000).optional(),
    recordedAt: isoDateTime,
  })
  .strict();

export const planeCommentEventSchema = z
  .object({
    version: z.literal(VERSION.planeCommentEvent),
    deliveryId: uuid,
    eventId: uuid,
    action: z.enum(["create", "update", "delete"]),
    workspaceId: uuid,
    projectId: uuid,
    workItemId: uuid,
    commentId: uuid,
    actor: z
      .object({
        id: uuid,
        kind: z.enum(["human", "service"]),
      })
      .strict(),
    comment: z.string().max(8_000),
    occurredAt: isoDateTime,
  })
  .strict();

export const researchPersonaHandles = [
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
] as const;

export const researchPersonaHandleSchema = z.enum(researchPersonaHandles);

const researchPersonasSchema = z
  .array(researchPersonaHandleSchema)
  .min(1)
  .max(researchPersonaHandles.length)
  .refine(
    (personas) => new Set(personas).size === personas.length,
    "research persona handles must be unique",
  );

export const researchRequestSchema = z
  .object({
    version: z.literal(VERSION.researchRequest),
    requestId: identifier,
    projectId: uuid,
    workItemId: uuid,
    triggerCommentId: uuid,
    requestedBy: uuid,
    repository,
    baseSha: gitSha,
    planeRevisionDigest: sha256Digest,
    personas: researchPersonasSchema,
    brief: safeText(8_000),
    requestedAt: isoDateTime,
  })
  .strict();

export const researchPersonaReportSchema = z
  .object({
    version: z.literal(VERSION.researchPersonaReport),
    requestId: identifier,
    persona: researchPersonaHandleSchema,
    outcome: z.enum(["findings", "no-additional-findings"]),
    summary: safeText(2_000),
    currentBehavior: z.array(safeText(4_000)).max(50),
    expectedBehavior: z.array(safeText(4_000)).max(50),
    decisions: z
      .array(
        z
          .object({
            question: safeText(2_000),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(25),
  })
  .strict();

const agentJobBaseSchema = z
  .object({
    workItemId: identifier,
    workflowId: identifier,
    baseSha: gitSha,
    summary: safeText(500),
  })
  .strict();

export const agentJobDispatchRequestSchema = z
  .discriminatedUnion("role", [
    agentJobBaseSchema
      .extend({
        version: z.literal(VERSION.agentJobDispatch),
        role: z.literal("coding-agent"),
      })
      .strict(),
    agentJobBaseSchema
      .extend({
        version: z.literal(VERSION.agentJobDispatch),
        role: z.literal("qa-contract-researcher"),
        researchRequest: researchRequestSchema,
        researchPersona: researchPersonaHandleSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.role !== "qa-contract-researcher") return;
    if (!value.researchRequest.personas.includes(value.researchPersona)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["researchPersona"],
        message: "research persona was not requested",
      });
    }
    if (
      value.workItemId !== value.researchRequest.workItemId ||
      value.workflowId !== value.researchRequest.requestId ||
      value.baseSha !== value.researchRequest.baseSha
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["researchRequest"],
        message: "research dispatch identity does not match its request",
      });
    }
  });

const agentJobDispatchResultBaseSchema = z
  .object({
    version: z.literal(VERSION.agentJobDispatchResult),
    runId: workflowRunIdentifier,
    checkpointUri: z
      .string()
      .regex(/^artifact:\/\/\/agent-runs\/[a-z0-9-]+\/checkpoint\.json$/),
    checkpointDigest: sha256Digest,
    checkpointSizeBytes: z.number().int().positive().max(25_000_000),
  })
  .strict();

export const agentJobDispatchResultSchema = z.discriminatedUnion("role", [
  agentJobDispatchResultBaseSchema
    .extend({
      role: z.literal("coding-agent"),
    })
    .strict(),
  agentJobDispatchResultBaseSchema
    .extend({
      role: z.literal("qa-contract-researcher"),
      researchReport: researchPersonaReportSchema,
    })
    .strict(),
]);

const ticketChangesSchema = z
  .object({
    name: safeText(500).optional(),
    descriptionHtml: safeText(50_000).optional(),
    priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
    moduleId: uuid.nullable().optional(),
    parentId: uuid.nullable().optional(),
    assigneeIds: z.array(uuid).max(32).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "ticket update is empty");

const projectChangesSchema = z
  .object({
    name: safeText(255).optional(),
    description: safeText(50_000).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "project update is empty");

export const researchPlaneMutationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("comment.create"),
      targetWorkItemId: uuid,
      bodyHtml: safeText(50_000),
      attachments: z.array(evidenceReferenceSchema).max(32).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("label.upsert"),
      key: identifier,
      name: safeText(255),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      description: z.string().max(1_000).default(""),
    })
    .strict(),
  z
    .object({
      type: z.enum(["label.attach", "label.detach"]),
      targetWorkItemId: uuid,
      key: identifier,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.update"),
      changes: projectChangesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ticket.update"),
      targetWorkItemId: uuid,
      changes: ticketChangesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ticket.create"),
      name: safeText(500),
      descriptionHtml: safeText(50_000),
      moduleId: uuid.nullable().optional(),
      parentId: uuid.nullable().optional(),
      labelKeys: z.array(identifier).max(32).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("ticket.cancel-proposal"),
      targetWorkItemId: uuid,
      reason: safeText(2_000),
    })
    .strict(),
]);

export const researchMutationBatchSchema = z
  .object({
    version: z.literal(VERSION.researchMutationBatch),
    requestId: identifier,
    projectId: uuid,
    sourceWorkItemId: uuid,
    mutations: z.array(researchPlaneMutationSchema).max(100),
  })
  .strict();

export const researchPacketSchema = z
  .object({
    version: z.literal(VERSION.researchPacket),
    personas: researchPersonasSchema,
    perspectives: z
      .array(
        z
          .object({
            persona: researchPersonaHandleSchema,
            outcome: z.enum(["findings", "no-additional-findings"]),
            summary: safeText(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(researchPersonaHandles.length),
    requestId: identifier,
    projectId: uuid,
    workItemId: uuid,
    baseSha: gitSha,
    planeRevisionDigest: sha256Digest,
    summary: safeText(2_000),
    currentBehavior: z.array(safeText(4_000)).max(100),
    expectedBehavior: z.array(safeText(4_000)).max(100),
    fixtureManifest: evidenceReferenceSchema.optional(),
    evidence: z.array(evidenceReferenceSchema).max(32),
    videoNotApplicableReason: z.string().min(1).max(1_000).optional(),
    decisions: z
      .array(
        z
          .object({
            question: safeText(2_000),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    proposedMutations: researchMutationBatchSchema,
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((packet, context) => {
    const videos = packet.evidence.filter((item) => item.kind === "video");
    if (videos.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "research packet may include at most one canonical video",
      });
    }
    if (videos.length === 1 && packet.videoNotApplicableReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["videoNotApplicableReason"],
        message: "video rationale is invalid when a canonical video is present",
      });
    }
    if (
      packet.projectId !== packet.proposedMutations.projectId ||
      packet.workItemId !== packet.proposedMutations.sourceWorkItemId ||
      packet.requestId !== packet.proposedMutations.requestId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedMutations"],
        message: "research mutation batch does not match the source request",
      });
    }
    const requested = new Set(packet.personas);
    const reported = new Set(
      packet.perspectives.map((perspective) => perspective.persona),
    );
    if (
      requested.size !== packet.personas.length ||
      reported.size !== packet.perspectives.length ||
      requested.size !== reported.size ||
      [...requested].some((persona) => !reported.has(persona))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perspectives"],
        message:
          "research packet must report one terminal perspective for every requested persona",
      });
    }
  });

const readinessIdentity = {
  version: z.literal(VERSION.readinessGate),
  projectId: uuid,
  workItemId: uuid,
  repository,
  baseSha: gitSha,
  planeRevisionDigest: sha256Digest,
  evaluatedAt: isoDateTime,
};

const readinessCriterionSchema = z
  .object({
    id: identifier,
    category: z.enum([
      "intent",
      "source",
      "current-behavior",
      "reproduction",
      "expected-behavior",
      "fixture",
      "oracle",
      "cleanup",
      "provenance",
      "coverage",
      "independence",
      "retention",
      "video",
      "decision",
      "other",
    ]),
    requirement: z.enum(["required", "recommended"]),
    applicability: z.enum(["applicable", "not-applicable"]),
    status: z.enum(["satisfied", "missing", "not-applicable"]),
    rationale: safeText(2_000),
    evidence: z.array(evidenceReferenceSchema).max(8).default([]),
  })
  .strict()
  .superRefine((criterion, context) => {
    const statusIsNotApplicable = criterion.status === "not-applicable";
    const criterionIsNotApplicable = criterion.applicability === "not-applicable";
    if (statusIsNotApplicable !== criterionIsNotApplicable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "criterion status must agree with applicability",
      });
    }
  });

export const readinessGateSchema = z
  .object({
    ...readinessIdentity,
    policy: z.literal("qa-ticket-readiness/v1"),
    profile: z.enum(["research", "implementation", "qualification"]),
    objective: safeText(4_000),
    expectedOutcome: safeText(4_000),
    criteria: z.array(readinessCriterionSchema).min(1).max(100),
    blockingProductDecisions: z.number().int().nonnegative().max(100),
    ready: z.boolean(),
  })
  .strict()
  .superRefine((gate, context) => {
    const criterionIds = new Set<string>();
    for (const [index, criterion] of gate.criteria.entries()) {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criteria", index, "id"],
          message: "readiness criterion ids must be unique",
        });
      }
      criterionIds.add(criterion.id);
    }

    const hasMissingRequiredCriterion = gate.criteria.some(
      (criterion) =>
        criterion.requirement === "required" &&
        criterion.applicability === "applicable" &&
        criterion.status === "missing",
    );
    const computedReady =
      gate.blockingProductDecisions === 0 && !hasMissingRequiredCriterion;
    if (gate.ready !== computedReady) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ready"],
        message:
          "ready must be derived from applicable required criteria and blocking product decisions",
      });
    }
  });

export const qaContractResearcherPolicy = Object.freeze({
  persona: "qa-contract-researcher/v2",
  trigger: "human-authored registered @ai-* persona mention",
  personaHandles: Object.freeze(researchPersonaHandles),
  allowedMutationTypes: Object.freeze([
    "comment.create",
    "label.upsert",
    "label.attach",
    "label.detach",
    "project.update",
    "ticket.update",
    "ticket.create",
    "ticket.cancel-proposal",
  ]),
  forbiddenMutationTypes: Object.freeze([
    "state.update",
    "ticket.cancel",
    "ticket.delete",
    "project.delete",
  ]),
} as const);

function personaMentionPattern(): RegExp {
  return /(^|[\s([{:;,])(@ai-[a-z][a-z0-9-]*)(?=$|[\s)\]}:;,!.?])/g;
}

export function parseResearchPersonaRound(
  comment: string,
): Readonly<{ personas: ResearchPersonaHandle[]; brief: string }> | null {
  const personas: ResearchPersonaHandle[] = [];
  const seen = new Set<ResearchPersonaHandle>();
  const registered = new Set<string>(researchPersonaHandles);
  const matcher = personaMentionPattern();
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(comment)) !== null) {
    const handle = match[2];
    if (
      handle !== undefined &&
      registered.has(handle) &&
      !seen.has(handle as ResearchPersonaHandle)
    ) {
      seen.add(handle as ResearchPersonaHandle);
      personas.push(handle as ResearchPersonaHandle);
    }
  }
  if (personas.length === 0) return null;

  const brief = comment
    .replace(personaMentionPattern(), "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { personas, brief };
}

export function createResearchRequestId(input: {
  eventId: string;
  commentId: string;
  planeRevisionDigest: string;
}): string {
  return logicalId("research-request", {
    version: VERSION.researchRequest,
    eventId: uuid.parse(input.eventId),
    commentId: uuid.parse(input.commentId),
    planeRevisionDigest: sha256Digest.parse(input.planeRevisionDigest),
  });
}

export function createResearchRequestFromPlaneComment(
  input: unknown,
  source: {
    repository: z.infer<typeof repository>;
    baseSha: string;
    planeRevisionDigest: string;
    defaultBrief: string;
  },
): ResearchRequest | null {
  const event = planeCommentEventSchema.parse(input);
  const round = parseResearchPersonaRound(event.comment);
  if (
    event.action !== "create" ||
    event.actor.kind !== "human" ||
    round === null
  ) {
    return null;
  }

  return researchRequestSchema.parse({
    version: VERSION.researchRequest,
    requestId: createResearchRequestId({
      eventId: event.eventId,
      commentId: event.commentId,
      planeRevisionDigest: source.planeRevisionDigest,
    }),
    projectId: event.projectId,
    workItemId: event.workItemId,
    triggerCommentId: event.commentId,
    requestedBy: event.actor.id,
    repository: source.repository,
    baseSha: source.baseSha,
    planeRevisionDigest: source.planeRevisionDigest,
    personas: round.personas,
    brief: round.brief || source.defaultBrief,
    requestedAt: event.occurredAt,
  });
}

export function verifyPlaneWebhookSignature(input: {
  secret: string;
  rawBody: string | Buffer;
  signature: string;
}): boolean {
  if (input.secret.length === 0 || !/^[0-9a-f]{64}$/i.test(input.signature)) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(input.signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const contractVersions = VERSION;

export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type WorkItemRequest = z.infer<typeof workItemRequestSchema>;
export type CodingRequest = z.infer<typeof codingRequestSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlResult = z.infer<typeof controlResultSchema>;
export type PlaneCommentEvent = z.infer<typeof planeCommentEventSchema>;
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchPersonaReport = z.infer<
  typeof researchPersonaReportSchema
>;
export type AgentJobDispatchRequest = z.infer<
  typeof agentJobDispatchRequestSchema
>;
export type AgentJobDispatchResult = z.infer<
  typeof agentJobDispatchResultSchema
>;
export type ResearchPersonaHandle = z.infer<typeof researchPersonaHandleSchema>;
export type ResearchPlaneMutation = z.infer<typeof researchPlaneMutationSchema>;
export type ResearchMutationBatch = z.infer<typeof researchMutationBatchSchema>;
export type ResearchPacket = z.infer<typeof researchPacketSchema>;
export type ReadinessGate = z.infer<typeof readinessGateSchema>;
