import { z } from "zod";
import {
  interactiveSessionModeSchema,
  sessionPolicySchema,
} from "./session-policy.js";

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
    policy: sessionPolicySchema,
    title: safeText(200).optional(),
    promptDigest: sha256Digest,
    workspace: workspaceManifestSchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deadlineAt: isoDateTime,
    attemptCount: z.number().int().nonnegative().max(100_000),
    nextAttemptAt: isoDateTime.optional(),
    materializedAt: isoDateTime.optional(),
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
]);

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
export type WorkspaceCatalogEntry = z.infer<
  typeof workspaceCatalogEntrySchema
>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type WorkspaceLaunch = z.infer<typeof workspaceLaunchSchema>;
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;
