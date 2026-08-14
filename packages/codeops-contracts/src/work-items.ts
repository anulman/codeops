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
const uuid = z.string().uuid();
const workItemText = z.string().trim().min(1).max(20_000);

export const workItemRelationKindSchema = z.enum([
  "blocking",
  "blocked_by",
  "duplicate",
  "relates_to",
  "start_after",
  "start_before",
  "finish_after",
  "finish_before",
]);

export const workItemCreateModeSchema = z.enum(["triage", "direct"]);

export const workItemCreateInputSchema = z
  .object({
    repository,
    mode: workItemCreateModeSchema.default("triage"),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const workItemGetInputSchema = z
  .object({ repository, workItemId: uuid })
  .strict();

export const workItemSearchInputSchema = z
  .object({
    repository,
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(50).default(20),
  })
  .strict();

export const workItemCommentInputSchema = z
  .object({ repository, workItemId: uuid, body: workItemText })
  .strict();

export const workItemUpdateInputSchema = z
  .object({
    repository,
    workItemId: uuid,
    expectedRevision: sha256Digest,
    title: z.string().trim().min(1).max(500).optional(),
    description: workItemText.optional(),
  })
  .strict()
  .refine(
    ({ title, description }) => title !== undefined || description !== undefined,
    "work-item update requires title or description",
  );

export const workItemRelateInputSchema = z
  .object({
    repository,
    workItemId: uuid,
    relatedWorkItemId: uuid,
    relation: workItemRelationKindSchema,
  })
  .strict()
  .refine(
    ({ workItemId, relatedWorkItemId }) => workItemId !== relatedWorkItemId,
    "a work item cannot relate to itself",
  );

export const sessionRuntimeWorkItemCreateRequestSchema = z
  .object({
    version: z.literal("codeops.session-runtime-work-item-create-request/v1"),
    claimToken: z.string().uuid(),
    operationId: identifier,
    input: workItemCreateInputSchema,
  })
  .strict();

function runtimeRequest<Input extends z.ZodTypeAny>(
  operation: "get" | "search" | "comment" | "update" | "relate",
  input: Input,
) {
  return z
    .object({
      version: z.literal(`codeops.session-runtime-work-item-${operation}-request/v1`),
      claimToken: z.string().uuid(),
      operationId: identifier,
      input,
    })
    .strict();
}

export const sessionRuntimeWorkItemGetRequestSchema = runtimeRequest(
  "get",
  workItemGetInputSchema,
);
export const sessionRuntimeWorkItemSearchRequestSchema = runtimeRequest(
  "search",
  workItemSearchInputSchema,
);
export const sessionRuntimeWorkItemCommentRequestSchema = runtimeRequest(
  "comment",
  workItemCommentInputSchema,
);
export const sessionRuntimeWorkItemUpdateRequestSchema = runtimeRequest(
  "update",
  workItemUpdateInputSchema,
);
export const sessionRuntimeWorkItemRelateRequestSchema = runtimeRequest(
  "relate",
  workItemRelateInputSchema,
);

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

const providerProvenanceSchema = z
  .object({
    sessionId: identifier,
    dispatchId: z.string().uuid(),
    principalDigest: sha256Digest,
  })
  .strict();

function providerRequest<Input extends z.ZodRawShape>(
  operation: "get" | "search" | "comment" | "update" | "relate",
  shape: Input,
) {
  return z
    .object({
      version: z.literal(`codeops.work-item-provider-${operation}-request/v1`),
      provider: identifier,
      operationId: identifier,
      payloadDigest: sha256Digest,
      repository,
      provenance: providerProvenanceSchema,
      ...shape,
    })
    .strict();
}

export const workItemProviderGetRequestSchema = providerRequest("get", {
  workItemId: uuid,
});
export const workItemProviderSearchRequestSchema = providerRequest("search", {
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().positive().max(50),
});
export const workItemProviderCommentRequestSchema = providerRequest("comment", {
  workItemId: uuid,
  body: workItemText,
});
export const workItemProviderUpdateRequestSchema = providerRequest("update", {
  workItemId: uuid,
  expectedRevision: sha256Digest,
  title: z.string().trim().min(1).max(500).optional(),
  description: workItemText.optional(),
}).refine(
  ({ title, description }) => title !== undefined || description !== undefined,
  "work-item update requires title or description",
);
export const workItemProviderRelateRequestSchema = providerRequest("relate", {
  workItemId: uuid,
  relatedWorkItemId: uuid,
  relation: workItemRelationKindSchema,
}).refine(
  ({ workItemId, relatedWorkItemId }) => workItemId !== relatedWorkItemId,
  "a work item cannot relate to itself",
);

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

export const workItemProjectionSchema = z
  .object({
    version: z.literal("codeops.work-item-projection/v1"),
    provider: identifier,
    repository,
    workItemId: uuid,
    title: z.string().max(500),
    description: z.string().max(50_000),
    priority: z.string().max(64),
    stateId: uuid.nullable(),
    labelIds: z.array(uuid).max(100),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    revision: sha256Digest,
  })
  .strict();

export const workItemSearchResultSchema = z
  .object({
    version: z.literal("codeops.work-item-search-result/v1"),
    provider: identifier,
    repository,
    query: z.string().max(500),
    items: z.array(workItemProjectionSchema).max(50),
  })
  .strict();

export const workItemCommentResultSchema = z
  .object({
    version: z.literal("codeops.work-item-comment-result/v1"),
    provider: identifier,
    repository,
    workItemId: uuid,
    commentId: uuid,
    operationId: identifier,
    disposition: z.enum(["created", "existing"]),
  })
  .strict();

export const workItemUpdateResultSchema = z
  .object({
    version: z.literal("codeops.work-item-update-result/v1"),
    provider: identifier,
    repository,
    operationId: identifier,
    disposition: z.enum(["updated", "existing", "reload-required"]),
    item: workItemProjectionSchema,
  })
  .strict();

export const workItemRelateResultSchema = z
  .object({
    version: z.literal("codeops.work-item-relate-result/v1"),
    provider: identifier,
    repository,
    workItemId: uuid,
    relatedWorkItemId: uuid,
    relation: workItemRelationKindSchema,
    operationId: identifier,
    disposition: z.enum(["created", "existing"]),
  })
  .strict();

export type WorkItemCreateInput = z.infer<typeof workItemCreateInputSchema>;
export type WorkItemGetInput = z.infer<typeof workItemGetInputSchema>;
export type WorkItemSearchInput = z.infer<typeof workItemSearchInputSchema>;
export type WorkItemCommentInput = z.infer<typeof workItemCommentInputSchema>;
export type WorkItemUpdateInput = z.infer<typeof workItemUpdateInputSchema>;
export type WorkItemRelateInput = z.infer<typeof workItemRelateInputSchema>;
export type SessionRuntimeWorkItemCreateRequest = z.infer<
  typeof sessionRuntimeWorkItemCreateRequestSchema
>;
export type WorkItemProviderCreateRequest = z.infer<
  typeof workItemProviderCreateRequestSchema
>;
export type WorkItemCreateResult = z.infer<typeof workItemCreateResultSchema>;
export type WorkItemProjection = z.infer<typeof workItemProjectionSchema>;
export type WorkItemSearchResult = z.infer<typeof workItemSearchResultSchema>;
export type WorkItemCommentResult = z.infer<typeof workItemCommentResultSchema>;
export type WorkItemUpdateResult = z.infer<typeof workItemUpdateResultSchema>;
export type WorkItemRelateResult = z.infer<typeof workItemRelateResultSchema>;
export type WorkItemProviderGetRequest = z.infer<
  typeof workItemProviderGetRequestSchema
>;
export type WorkItemProviderSearchRequest = z.infer<
  typeof workItemProviderSearchRequestSchema
>;
export type WorkItemProviderCommentRequest = z.infer<
  typeof workItemProviderCommentRequestSchema
>;
export type WorkItemProviderUpdateRequest = z.infer<
  typeof workItemProviderUpdateRequestSchema
>;
export type WorkItemProviderRelateRequest = z.infer<
  typeof workItemProviderRelateRequestSchema
>;
