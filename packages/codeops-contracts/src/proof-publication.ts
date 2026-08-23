import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const repositorySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const objectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("//") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
    {
      message: "object key must be canonical",
    },
  );

const publicationIdentitySchema = z
  .object({
    repository: repositorySchema,
    pullRequestNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  })
  .strict();

const reviewerVideoSchema = z
  .object({
    kind: z.literal("reviewer-video"),
    mediaType: z.literal("video/mp4"),
    extension: z.literal("mp4"),
    byteLength: z.number().int().positive().max(100 * 1024 * 1024),
    sha256: digestSchema,
    bytesBase64: z.string().min(4),
  })
  .strict();

const posterSchema = z
  .object({
    kind: z.literal("poster"),
    mediaType: z.union([z.literal("image/png"), z.literal("image/jpeg")]),
    extension: z.union([z.literal("png"), z.literal("jpg")]),
    byteLength: z.number().int().positive().max(10 * 1024 * 1024),
    sha256: digestSchema,
    bytesBase64: z.string().min(4),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.mediaType === "image/png" ? "png" : "jpg";
    if (value.extension !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extension"],
        message: "poster extension must match media type",
      });
    }
  });

export const proofPublicationArtifactInputSchema = z.union([
  reviewerVideoSchema,
  posterSchema,
]);

export const proofPublicationRequestSchema = z
  .object({
    version: z.literal("codeops.proof-publication-request/v1"),
    plugin: z.literal("codeops.proof-publisher.s3/v1"),
    expectedDestinationId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/),
    classification: z.union([
      z.literal("sanitized-public"),
      z.literal("sensitive"),
    ]),
    identity: publicationIdentitySchema,
    artifacts: z.tuple([reviewerVideoSchema, posterSchema]),
  })
  .strict();

export const proofPublicationArtifactReceiptSchema = z
  .object({
    kind: z.union([
      z.literal("reviewer-video"),
      z.literal("poster"),
      z.literal("packet-index"),
    ]),
    objectKey: objectKeySchema,
    publicUrl: z.string().url().refine((value) => value.startsWith("https://"), {
      message: "public URL must use HTTPS",
    }),
    mediaType: z.union([
      z.literal("video/mp4"),
      z.literal("image/png"),
      z.literal("image/jpeg"),
      z.literal("application/json"),
    ]),
    byteLength: z.number().int().positive(),
    sha256: digestSchema,
    etag: z.string().min(1).max(200),
  })
  .strict();

const successReceiptSchema = z
  .object({
    version: z.literal("codeops.proof-publication-receipt/v1"),
    plugin: z.literal("codeops.proof-publisher.s3/v1"),
    status: z.literal("published"),
    destinationId: z.string().min(1).max(200),
    identity: publicationIdentitySchema,
    artifacts: z.tuple([
      proofPublicationArtifactReceiptSchema.extend({
        kind: z.literal("reviewer-video"),
      }),
      proofPublicationArtifactReceiptSchema.extend({
        kind: z.literal("poster"),
      }),
      proofPublicationArtifactReceiptSchema.extend({
        kind: z.literal("packet-index"),
      }),
    ]),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const failureReceiptSchema = z
  .object({
    version: z.literal("codeops.proof-publication-receipt/v1"),
    plugin: z.literal("codeops.proof-publisher.s3/v1"),
    status: z.literal("failed"),
    destinationId: z.string().min(1).max(200),
    identity: publicationIdentitySchema,
    code: z.union([
      z.literal("destination_mismatch"),
      z.literal("sensitive_proof"),
      z.literal("artifact_invalid"),
      z.literal("object_conflict"),
      z.literal("upload_failed"),
      z.literal("verification_failed"),
      z.literal("plugin_unavailable"),
    ]),
    retryable: z.boolean(),
  })
  .strict();

export const proofPublicationReceiptSchema = z.discriminatedUnion("status", [
  successReceiptSchema,
  failureReceiptSchema,
]);

export type ProofPublicationArtifactInput = z.infer<
  typeof proofPublicationArtifactInputSchema
>;
export type ProofPublicationRequest = z.infer<typeof proofPublicationRequestSchema>;
export type ProofPublicationArtifactReceipt = z.infer<
  typeof proofPublicationArtifactReceiptSchema
>;
export type ProofPublicationReceipt = z.infer<typeof proofPublicationReceiptSchema>;
