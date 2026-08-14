import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });
const boundedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sessionBudgetLimitsSchema = z
  .object({
    elapsedSeconds: z.number().int().positive().max(24 * 60 * 60),
    totalTokens: z.number().int().positive().max(10_000_000),
    modelRequests: z.number().int().positive().max(1_000),
    activeChildren: z.number().int().positive().max(16),
  })
  .strict();

export const sessionBudgetUsageSchema = z
  .object({
    elapsedSeconds: boundedCount,
    totalTokens: boundedCount,
    modelRequests: boundedCount,
    activeChildren: boundedCount,
  })
  .strict();

export const sessionBudgetExhaustedLimitSchema = z.enum([
  "elapsed_time",
  "total_tokens",
  "model_requests",
  "active_children",
]);

export const sessionBudgetProjectionSchema = z
  .object({
    version: z.literal("codeops.session-budget/v1"),
    startedAt: isoDateTime,
    observedAt: isoDateTime,
    limits: sessionBudgetLimitsSchema,
    usage: sessionBudgetUsageSchema,
    remaining: sessionBudgetUsageSchema,
    exhaustedLimit: sessionBudgetExhaustedLimitSchema.nullable(),
  })
  .strict()
  .superRefine((projection, context) => {
    if (Date.parse(projection.observedAt) < Date.parse(projection.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedAt"],
        message: "session budget observation cannot precede its start",
      });
    }
    for (const field of [
      "elapsedSeconds",
      "totalTokens",
      "modelRequests",
      "activeChildren",
    ] as const) {
      if (
        projection.remaining[field] !==
        Math.max(0, projection.limits[field] - projection.usage[field])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remaining", field],
          message: "session budget remaining value must match its exact usage",
        });
      }
    }
    if (projection.exhaustedLimit !== exhaustedLimit(projection.limits, projection.usage)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exhaustedLimit"],
        message: "session budget exhausted limit must match its exact usage",
      });
    }
  });

export const DEFAULT_SESSION_BUDGET_LIMITS: SessionBudgetLimits = {
  elapsedSeconds: 6 * 60 * 60,
  totalTokens: 1_000_000,
  modelRequests: 200,
  activeChildren: 4,
};

export function projectSessionBudget(input: {
  readonly startedAt: string;
  readonly observedAt: string;
  readonly limits?: SessionBudgetLimits;
  readonly totalTokens?: number;
  readonly modelRequests?: number;
  readonly activeChildren?: number;
}): SessionBudgetProjection {
  const limits = sessionBudgetLimitsSchema.parse(
    input.limits ?? DEFAULT_SESSION_BUDGET_LIMITS,
  );
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.parse(input.observedAt) - Date.parse(input.startedAt)) / 1_000),
  );
  const usage = sessionBudgetUsageSchema.parse({
    elapsedSeconds,
    totalTokens: input.totalTokens ?? 0,
    modelRequests: input.modelRequests ?? 0,
    activeChildren: input.activeChildren ?? 0,
  });
  return sessionBudgetProjectionSchema.parse({
    version: "codeops.session-budget/v1",
    startedAt: input.startedAt,
    observedAt: input.observedAt,
    limits,
    usage,
    remaining: {
      elapsedSeconds: Math.max(0, limits.elapsedSeconds - usage.elapsedSeconds),
      totalTokens: Math.max(0, limits.totalTokens - usage.totalTokens),
      modelRequests: Math.max(0, limits.modelRequests - usage.modelRequests),
      activeChildren: Math.max(0, limits.activeChildren - usage.activeChildren),
    },
    exhaustedLimit: exhaustedLimit(limits, usage),
  });
}

function exhaustedLimit(
  limits: SessionBudgetLimits,
  usage: SessionBudgetUsage,
): SessionBudgetExhaustedLimit | null {
  if (usage.elapsedSeconds >= limits.elapsedSeconds) return "elapsed_time";
  if (usage.totalTokens >= limits.totalTokens) return "total_tokens";
  if (usage.modelRequests >= limits.modelRequests) return "model_requests";
  if (usage.activeChildren >= limits.activeChildren) return "active_children";
  return null;
}

export type SessionBudgetLimits = z.infer<typeof sessionBudgetLimitsSchema>;
export type SessionBudgetUsage = z.infer<typeof sessionBudgetUsageSchema>;
export type SessionBudgetExhaustedLimit = z.infer<
  typeof sessionBudgetExhaustedLimitSchema
>;
export type SessionBudgetProjection = z.infer<
  typeof sessionBudgetProjectionSchema
>;
