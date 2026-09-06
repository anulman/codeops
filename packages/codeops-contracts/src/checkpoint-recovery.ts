import { z } from "zod";

const identifier = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const repository = z.string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const catalogKey = z.string().min(1).max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const bytes = z.number().int().nonnegative().max(24_000_000);
const relativePath = z.string().min(1).max(2_000).refine((value) =>
  value !== "." && !value.startsWith("/") && !value.includes("\\") &&
  !value.includes("\0") && value.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".."
  ), "checkpoint path must be a safe relative POSIX path");

export const checkpointWorkspaceBindingSchema = z.object({
  version: z.literal("codeops.checkpoint-workspace-binding/v1"),
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workspaceJobUid: uuid,
  resourceConfigurationDigest: digest,
  workspaceConfigurationDigest: digest,
  workspaceManifestDigest: digest,
}).strict();

export const checkpointPathEntrySchema = z.discriminatedUnion("type", [
  z.object({ path: relativePath, type: z.literal("directory"), bytes: z.literal(0) }).strict(),
  z.object({
    path: relativePath,
    type: z.literal("file"),
    bytes,
    digest,
    executable: z.boolean(),
  }).strict(),
]);

const checkpointArtifactSchema = z.object({
  artifactId: z.string().regex(/^artifact:[0-9a-f-]{36}:(?:scratch|source:[a-z0-9][a-z0-9-]{0,62})$/),
  bytes: z.number().int().nonnegative().max(16_000_000),
  digest,
}).strict();

const sourceArtifactSchema = checkpointArtifactSchema.extend({
  catalogKey,
  repository,
  checkoutPath: z.string().regex(/^sources\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  baseSha: gitSha,
}).strict().superRefine((source, context) => {
  if (!source.artifactId.endsWith(`:source:${source.catalogKey}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "source artifact identity must match its catalog key" });
  }
  if (source.bytes > 2_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bytes"],
      message: "source patch must not exceed 2000000 bytes" });
  }
});

export const checkpointManifestSchema = z.object({
  version: z.literal("codeops.checkpoint-manifest/v1"),
  binding: checkpointWorkspaceBindingSchema,
  checkpointId: uuid,
  sourcePatches: z.array(sourceArtifactSchema).max(4),
  scratchArtifact: checkpointArtifactSchema,
  pathSetDigest: digest,
  pathCount: z.number().int().nonnegative().max(10_004),
  totalBytes: bytes,
  capturedAt: timestamp,
}).strict().superRefine((manifest, context) => {
  const artifactPrefix = `artifact:${manifest.checkpointId}:`;
  if (!manifest.scratchArtifact.artifactId.startsWith(artifactPrefix) ||
      !manifest.scratchArtifact.artifactId.endsWith(":scratch")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scratchArtifact", "artifactId"],
      message: "scratch artifact identity must match the checkpoint" });
  }
  if (manifest.sourcePatches.some((source) =>
    !source.artifactId.startsWith(artifactPrefix))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourcePatches"],
      message: "source artifact identity must match the checkpoint" });
  }
  for (const values of [
    manifest.sourcePatches.map(({ catalogKey: value }) => value),
    manifest.sourcePatches.map(({ repository: value }) => value),
    manifest.sourcePatches.map(({ checkoutPath: value }) => value),
  ]) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: "checkpoint manifest identities and paths must be unique" });
    }
  }
  const total = manifest.sourcePatches.reduce((sum, item) => sum + item.bytes, 0) +
    manifest.scratchArtifact.bytes;
  if (total !== manifest.totalBytes || total > 24_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalBytes"],
      message: "checkpoint artifact total must be exact and at most 24000000 bytes" });
  }
});

export const checkpointDescriptorSchema = z.object({
  version: z.literal("codeops.checkpoint-descriptor/v1"),
  manifest: checkpointManifestSchema,
  manifestDigest: digest,
}).strict().refine((descriptor) =>
  new TextEncoder().encode(JSON.stringify(descriptor)).byteLength <= 900_000,
"checkpoint descriptor must fit the completion transport bound");

const receiptIdentity = {
  checkpointId: uuid,
  binding: checkpointWorkspaceBindingSchema,
  descriptorDigest: digest,
  manifestDigest: digest,
} as const;

export const checkpointReceiptSchema = z.object({
  version: z.literal("codeops.checkpoint-receipt/v1"),
  ...receiptIdentity,
  issuedAt: timestamp,
}).strict();

export const restoreReceiptSchema = z.object({
  version: z.literal("codeops.restore-receipt/v1"),
  ...receiptIdentity,
  restoreOperationId: uuid,
  restoredWorkspaceJobUid: uuid,
  restoredResourceConfigurationDigest: digest,
  restoredGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  restoredPathSetDigest: digest,
  restoredAt: timestamp,
}).strict().refine((receipt) =>
  receipt.restoredGeneration > receipt.binding.generation,
  "restore receipt requires a later Session generation");

const operatorPrincipal = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

export const checkpointHoldEventSchema = z.object({
  version: z.literal("codeops.checkpoint-hold-event/v1"),
  eventId: uuid,
  checkpointId: uuid,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  action: z.enum(["placed", "released"]),
  operatorPrincipalId: operatorPrincipal,
  reason: z.string().min(1).max(1_000),
  occurredAt: timestamp,
}).strict();

export const checkpointRetentionDecisionSchema = z.object({
  version: z.literal("codeops.checkpoint-retention-decision/v1"),
  decisionId: uuid,
  checkpointId: uuid,
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  configured: z.literal(true),
  retainUntil: timestamp,
  expiresAt: timestamp,
  decidedAt: timestamp,
  operatorPrincipalId: operatorPrincipal,
}).strict().refine((decision) =>
  Date.parse(decision.retainUntil) > Date.parse(decision.decidedAt) &&
  Date.parse(decision.expiresAt) > Date.parse(decision.retainUntil),
  "retention and decision expiry must be ordered after the decision");

export const cleanupRefusalReasonSchema = z.enum([
  "policy-not-configured",
  "checkpoint-receipt-missing",
  "restore-receipt-missing",
  "receipt-mismatch",
  "stale-readback",
  "later-generation",
  "active-hold",
  "retention-not-expired",
  "retention-expired",
  "authority-drift",
  "legacy-unverified",
  "session-not-terminal",
]);

export const checkpointCleanupDecisionSchema = z.discriminatedUnion("authorized", [
  z.object({
    version: z.literal("codeops.checkpoint-cleanup-decision/v1"),
    decisionId: uuid,
    checkpointId: uuid,
    authorized: z.literal(true),
    checkpointReceipt: checkpointReceiptSchema,
    restoreReceipt: restoreReceiptSchema,
    retentionDecision: checkpointRetentionDecisionSchema,
    holdRevision: z.number().int().nonnegative(),
    retentionRevision: z.number().int().positive(),
    liveGeneration: z.number().int().positive(),
    decidedAt: timestamp,
    consumedAt: timestamp,
  }).strict(),
  z.object({
    version: z.literal("codeops.checkpoint-cleanup-decision/v1"),
    decisionId: uuid,
    checkpointId: uuid,
    authorized: z.literal(false),
    reason: cleanupRefusalReasonSchema,
    decidedAt: timestamp,
  }).strict(),
]);

export type CheckpointWorkspaceBinding = z.infer<typeof checkpointWorkspaceBindingSchema>;
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
export type CheckpointDescriptor = z.infer<typeof checkpointDescriptorSchema>;
export type CheckpointReceipt = z.infer<typeof checkpointReceiptSchema>;
export type RestoreReceipt = z.infer<typeof restoreReceiptSchema>;
export type CheckpointHoldEvent = z.infer<typeof checkpointHoldEventSchema>;
export type CheckpointRetentionDecision = z.infer<typeof checkpointRetentionDecisionSchema>;
export type CheckpointCleanupDecision = z.infer<typeof checkpointCleanupDecisionSchema>;
