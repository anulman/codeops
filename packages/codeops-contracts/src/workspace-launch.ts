import { z } from "zod";
import { sha256CanonicalJsonDigest } from "./canonical-json.js";
import {
  interactiveSessionModeSchema,
  sessionPolicySchema,
} from "./session-policy.js";
import { runtimeLaunchBindingSchema, runtimeRequirementsSchema } from "./runtime-profile.js";

const repositoryIdentity = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const catalogKey = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[a-zA-Z0-9._/-]+$/);
const checkoutPath = z
  .string()
  .min(1)
  .max(80)
  .regex(/^sources\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoDateTime = z.string().datetime({ offset: true });
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const mimeType = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
const contextAttachmentName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?![. ]+$)(?!.*[\\/\u0000-\u001f\u007f])[\p{L}\p{N}][\p{L}\p{N} ._()\[\]-]*$/u);
const canonicalBase64 = z
  .string()
  .min(1)
  .max(350_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const workspaceLaunchIdPattern = /^launch-([0-9a-f]{24})$/;
const workspaceSessionIdPattern = /^ses_([0-9a-f]{24})$/;

export function workspaceLaunchSessionId(launchId: string): string {
  const match = launchId.match(workspaceLaunchIdPattern);
  if (match === null) throw new Error("workspace launch identity is invalid");
  return `ses_${match[1]}`;
}

export function workspaceSessionLaunchId(sessionId: string): string | null {
  const match = sessionId.match(workspaceSessionIdPattern);
  return match === null ? null : `launch-${match[1]}`;
}

export const workspaceSourceSelectionSchema = z
  .object({
    catalogKey,
  })
  .strict();

export const workspaceContextAttachmentDescriptorSchema = z
  .object({
    attachmentId: identifier,
    name: contextAttachmentName,
    mimeType,
    sizeBytes: z.number().int().positive().max(256 * 1_024),
    digest: sha256Digest,
  })
  .strict();

export const workspaceContextAttachmentSchema =
  workspaceContextAttachmentDescriptorSchema
    .extend({ content: canonicalBase64 })
    .strict();

function uniqueContextAttachments<Attachment extends {
  readonly attachmentId: string;
  readonly name: string;
}>(attachments: readonly Attachment[], context: z.RefinementCtx): void {
  for (const [field, values] of [
    ["attachmentId", attachments.map(({ attachmentId }) => attachmentId)],
    ["name", attachments.map(({ name }) => name)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `context attachment ${field} values must be unique`,
      });
    }
  }
}

export const workspaceContextAttachmentDescriptorsSchema = z
  .array(workspaceContextAttachmentDescriptorSchema)
  .max(4)
  .superRefine(uniqueContextAttachments);

export const workspaceContextAttachmentsSchema = z
  .array(workspaceContextAttachmentSchema)
  .max(4)
  .superRefine(uniqueContextAttachments);

export const workspaceSourceSchema = z
  .object({
    catalogKey,
    repository: repositoryIdentity,
    checkoutPath,
    requestedRef: branchName,
    resolvedSha: gitSha,
  })
  .strict();

export const workspaceManifestSchema = z
  .object({
    version: z.literal("codeops.workspace/v1"),
    sources: z.array(workspaceSourceSchema).max(4),
    scratchPath: z.literal("scratch"),
  })
  .strict()
  .superRefine((workspace, context) => {
    const keys = workspace.sources.map(({ catalogKey: key }) => key);
    const repositories = workspace.sources.map(({ repository }) => repository);
    const paths = workspace.sources.map(({ checkoutPath: path }) => path);
    for (const [values, path] of [
      [keys, "catalogKey"],
      [repositories, "repository"],
      [paths, "checkoutPath"],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources"],
          message: `workspace source ${path} values must be unique`,
        });
      }
    }
  });

export const workspaceLaunchRequestSchema = z
  .object({
    version: z.literal("codeops.workspace-launch-request/v1"),
    idempotencyKey: z.string().uuid(),
    mode: interactiveSessionModeSchema,
    prompt: safeText(100_000),
    contextAttachments: workspaceContextAttachmentsSchema.optional(),
    title: safeText(200).optional(),
    sources: z.array(workspaceSourceSelectionSchema).max(4),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.sources.map(({ catalogKey: key }) => key)).size ===
      request.sources.length,
    "workspace launch source selections must be unique",
  );

export const workspaceCatalogEntrySchema = z
  .object({
    key: catalogKey,
    label: safeText(100),
    repository: repositoryIdentity,
    defaultRef: branchName,
  })
  .strict();

export const workspaceCatalogSchema = z
  .object({
    version: z.literal("codeops.workspace-catalog/v1"),
    repositories: z.array(workspaceCatalogEntrySchema).max(100),
  })
  .strict()
  .refine(
    (catalog) =>
      new Set(catalog.repositories.map(({ key }) => key)).size ===
      catalog.repositories.length,
    "workspace catalog keys must be unique",
  );

const launchBaseSchema = z
  .object({
    version: z.literal("codeops.workspace-launch/v1"),
    launchId: identifier,
    idempotencyKey: z.string().uuid(),
    principalId: safeText(320),
    requestDigest: sha256Digest,
    runtimeRequirements: runtimeRequirementsSchema.optional(),
    runtimeRequirementDigest: sha256Digest.optional(),
    runtimeLaunchBinding: runtimeLaunchBindingSchema.optional(),
    legacyRuntimeCompatible: z.boolean().optional(),
    policy: sessionPolicySchema,
    contextAttachments: workspaceContextAttachmentDescriptorsSchema.default([]),
    title: safeText(200).optional(),
    promptDigest: sha256Digest,
    workspace: workspaceManifestSchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deadlineAt: isoDateTime,
    attemptCount: z.number().int().nonnegative().max(100_000),
    nextAttemptAt: isoDateTime.optional(),
    materializedAt: isoDateTime.optional(),
    resourceBindings: z.object({
      sourceAuthority: z.object({ uid: safeText(256), configDigest: sha256Digest,
        resourceName: safeText(253).optional() }).strict().optional(),
      workspaceStorage: z.object({ uid: safeText(256), configDigest: sha256Digest,
        resourceName: safeText(253).optional() }).strict().optional(),
      sourceMaterializer: z.object({ uid: safeText(256), configDigest: sha256Digest,
        resourceName: safeText(253).optional() }).strict().optional(),
      workspaceRuntime: z.object({ uid: safeText(256), configDigest: sha256Digest,
        resourceName: safeText(253).optional() }).strict().optional(),
    }).strict().optional(),
    resourceReplacements: z.object({
      sourceAuthority: z.object({
        uid: safeText(256),
        resourceName: safeText(253),
        configDigest: sha256Digest,
        desiredConfigDigest: sha256Digest,
      }).strict().optional(),
    }).strict().optional(),
    retryRuntime: z.object({
      dispositionId: z.string().uuid(),
      sessionId: identifier,
      workflowId: identifier,
      runId: identifier,
      leaseId: z.string().uuid(),
      promptIdempotencyKey: z.string().uuid(),
      runtimeWorkerImage: z.string().min(1).max(500)
        .regex(/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/),
    }).strict().optional(),
  })
  .strict();

export const workspaceLaunchSchema = z.discriminatedUnion("state", [
  launchBaseSchema.extend({ state: z.literal("queued") }).strict(),
  launchBaseSchema.extend({ state: z.literal("provisioning") }).strict(),
  launchBaseSchema
    .extend({
      state: z.literal("ready"),
      sessionId: identifier,
      initialPromptCommandId: z.string().uuid(),
    })
    .strict(),
  launchBaseSchema
    .extend({
      state: z.literal("failed"),
      failureCode: z.enum([
        "invalid-source",
        "source-unavailable",
        "quota-exceeded",
        "provisioning-failed",
        "provisioning-timeout",
        "identity-conflict",
        "initial-prompt-failed",
      ]),
    })
    .strict(),
]).superRefine((launch, context) => {
  if ((launch.runtimeRequirements === undefined) !== (launch.runtimeRequirementDigest === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime requirements and digest must be present together" });
  }
  if (launch.runtimeRequirements !== undefined &&
      launch.runtimeRequirementDigest !== sha256CanonicalJsonDigest(launch.runtimeRequirements)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime requirement digest must match the canonical requirements" });
  }
  if (launch.runtimeLaunchBinding !== undefined && launch.runtimeRequirementDigest !== launch.runtimeLaunchBinding.requirementDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime launch binding must match the admitted requirement digest" });
  }
});

export const workspaceLaunchDetailSchema = z
  .object({
    version: z.literal("codeops.workspace-launch-detail/v1"),
    launch: workspaceLaunchSchema,
    initialPrompt: safeText(100_000),
    initialPromptStatus: z.enum(["accepted", "committed"]),
  })
  .strict();

export const workspaceCheckpointSchema = z
  .object({
    version: z.literal("codeops.workspace-checkpoint/v1"),
    workspaceManifestDigest: sha256Digest,
    sourcePatches: z
      .array(
        z
          .object({
            catalogKey,
            repository: repositoryIdentity,
            baseSha: gitSha,
            patchDigest: sha256Digest,
          })
          .strict(),
      )
      .max(4),
    scratchArtifactDigest: sha256Digest,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const keys = checkpoint.sourcePatches.map(({ catalogKey: key }) => key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourcePatches"],
        message: "workspace checkpoint source patches must be unique",
      });
    }
  });

export type WorkspaceSourceSelection = z.infer<
  typeof workspaceSourceSelectionSchema
>;
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export type WorkspaceLaunchRequest = z.infer<
  typeof workspaceLaunchRequestSchema
>;
export type WorkspaceContextAttachmentDescriptor = z.infer<
  typeof workspaceContextAttachmentDescriptorSchema
>;
export type WorkspaceContextAttachment = z.infer<
  typeof workspaceContextAttachmentSchema
>;
export type WorkspaceCatalogEntry = z.infer<
  typeof workspaceCatalogEntrySchema
>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type WorkspaceLaunch = z.infer<typeof workspaceLaunchSchema>;
export type WorkspaceLaunchDetail = z.infer<
  typeof workspaceLaunchDetailSchema
>;
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
