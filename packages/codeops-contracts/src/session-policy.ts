import { z } from "zod";

export const sessionModeSchema = z.enum([
  "explore",
  "plan",
  "implement",
  "review",
  "validate",
]);

export const interactiveSessionModeSchema = z.enum([
  "explore",
  "plan",
  "implement",
  "review",
]);

const modelSessionPolicySchema = z
  .object({
    provider: z.literal("openai"),
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.enum(["medium", "high"]),
  })
  .strict();

const deterministicSessionPolicySchema = z
  .object({
    provider: z.literal("none"),
    model: z.null(),
    reasoningEffort: z.null(),
  })
  .strict();

const policyByMode = {
  explore: {
    workspaceAccess: "read-only",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
  },
  plan: {
    workspaceAccess: "read-only",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  },
  implement: {
    workspaceAccess: "bounded-writes",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
  },
  review: {
    workspaceAccess: "read-only",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  },
  validate: {
    workspaceAccess: "deterministic",
    modelCalls: "forbidden",
    modelPolicy: {
      provider: "none",
      model: null,
      reasoningEffort: null,
    },
  },
} as const;

const sessionPolicyShapeSchema = z
  .object({
    version: z.literal("codeops.session-policy/v1"),
    mode: sessionModeSchema,
    workspaceAccess: z.enum(["read-only", "bounded-writes", "deterministic"]),
    modelCalls: z.enum(["allowed", "forbidden"]),
    modelPolicy: z.union([
      modelSessionPolicySchema,
      deterministicSessionPolicySchema,
    ]),
  })
  .strict();

export const sessionPolicySchema = sessionPolicyShapeSchema.superRefine(
  (policy, context) => {
    const expected = policyByMode[policy.mode];
    if (
      policy.workspaceAccess !== expected.workspaceAccess ||
      policy.modelCalls !== expected.modelCalls ||
      JSON.stringify(policy.modelPolicy) !== JSON.stringify(expected.modelPolicy)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session policy must match the immutable policy for its mode",
      });
    }
  },
);

export function sessionPolicyForMode(
  mode: z.infer<typeof sessionModeSchema>,
): z.infer<typeof sessionPolicySchema> {
  return sessionPolicySchema.parse({
    version: "codeops.session-policy/v1",
    mode,
    ...policyByMode[mode],
  });
}

export type SessionMode = z.infer<typeof sessionModeSchema>;
export type InteractiveSessionMode = z.infer<
  typeof interactiveSessionModeSchema
>;
export type SessionPolicy = z.infer<typeof sessionPolicySchema>;
