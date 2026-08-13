import { z } from "zod";

const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const workItemCreateModeSchema = z.enum(["triage", "direct"]);

export const workItemCreateInputSchema = z
  .object({
    repository,
    mode: workItemCreateModeSchema.default("triage"),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const sessionRuntimeWorkItemCreateRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-work-item-create-request/v1"),
    claimToken: z.string().uuid(),
    operationId: identifier,
    input: workItemCreateInputSchema,
  })
  .strict();

export const workItemProviderCreateRequestSchema = z
  .object({
    version: z.literal("codeops.work-item-provider-create-request/v1"),
    provider: identifier,
    operationId: identifier,
    payloadDigest: sha256Digest,
    repository,
    mode: workItemCreateModeSchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(20_000),
    provenance: z
      .object({
        sessionId: identifier,
        dispatchId: z.string().uuid(),
        principalDigest: sha256Digest,
      })
      .strict(),
  })
  .strict();

export const workItemCreateResultSchema = z
  .object({
    version: z.literal("codeops.work-item-create-result/v1"),
    provider: identifier,
    operationId: identifier,
    repository,
    workItemId: z.string().uuid(),
    disposition: z.enum(["created", "existing"]),
  })
  .strict();

export type WorkItemCreateInput = z.infer<typeof workItemCreateInputSchema>;
export type SessionRuntimeWorkItemCreateRequest = z.infer<
  typeof sessionRuntimeWorkItemCreateRequestSchema
>;
export type WorkItemProviderCreateRequest = z.infer<
  typeof workItemProviderCreateRequestSchema
>;
export type WorkItemCreateResult = z.infer<typeof workItemCreateResultSchema>;
