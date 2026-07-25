import { createHash } from "node:crypto";
import { z } from "zod";

const VERSION = {
  workItem: "codeops.work-item/v1",
  event: "codeops.workflow-event/v1",
  controlCommand: "codeops.control-command/v1",
  controlResult: "codeops.control-result/v1",
  evidence: "codeops.evidence/v1",
  secretReference: "codeops.secret-reference/v1",
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
  .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[a-zA-Z0-9._/-]+$/);
const repository = z
  .object({
    owner: z.string().min(1).max(100).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();
const isoDateTime = z.string().datetime({ offset: true });
const safeText = (maximum: number) => z.string().min(1).max(maximum);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

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

export const contractVersions = VERSION;

export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type WorkItemRequest = z.infer<typeof workItemRequestSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlResult = z.infer<typeof controlResultSchema>;
