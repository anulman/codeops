import { z } from "zod";

export const EVIDENCE_KINDS = [
  "simulated-provider",
  "browser-acceptance",
  "released-image",
  "live-provider",
] as const;

export const evidenceDeclarationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("simulated-provider"),
      providerMode: z.literal("fake"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser-acceptance"),
      providerDelivery: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("released-image"),
      sourceCheckout: z.literal(false),
      immutableImageRefs: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("live-provider"),
      providerDelivery: z.literal(true),
      authorizationMode: z.literal("explicit"),
    })
    .strict(),
]);

export type EvidenceDeclaration = z.infer<typeof evidenceDeclarationSchema>;
