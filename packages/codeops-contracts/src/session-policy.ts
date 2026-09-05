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

export const sessionModelSchema = z.enum(["gpt-5.6-sol", "gpt-6-astra"]);

const modelSessionPolicySchema = z
  .object({
    provider: z.literal("openai"),
    model: sessionModelSchema,
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
    const expectedModelPolicy = policy.modelPolicy.provider === "openai" &&
      expected.modelPolicy.provider === "openai"
      ? { ...expected.modelPolicy, model: policy.modelPolicy.model }
      : expected.modelPolicy;
    if (
      policy.workspaceAccess !== expected.workspaceAccess ||
      policy.modelCalls !== expected.modelCalls ||
      JSON.stringify(policy.modelPolicy) !== JSON.stringify(expectedModelPolicy)
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
  model: z.infer<typeof sessionModelSchema> = "gpt-5.6-sol",
): z.infer<typeof sessionPolicySchema> {
  const base = policyByMode[mode];
  return sessionPolicySchema.parse({
    version: "codeops.session-policy/v1",
    mode,
    ...base,
    ...(base.modelPolicy.provider === "openai"
      ? { modelPolicy: { ...base.modelPolicy, model } }
      : {}),
  });
}

export type SessionMode = z.infer<typeof sessionModeSchema>;
export type InteractiveSessionMode = z.infer<
  typeof interactiveSessionModeSchema
>;
export type SessionPolicy = z.infer<typeof sessionPolicySchema>;
export type SessionModel = z.infer<typeof sessionModelSchema>;
