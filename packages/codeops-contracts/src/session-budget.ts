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

const sessionModelBudgetId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const sessionBudgetV2LimitsSchema = z
  .object({
    elapsedSeconds: z.number().int().positive().max(24 * 60 * 60),
    providerRequests: z.number().int().positive().max(1_000),
    outputTokens: z.number().int().positive().max(10_000_000),
    activeChildren: z.number().int().positive().max(16),
  })
  .strict();

export const sessionBudgetV2UsageSchema = z
  .object({
    elapsedSeconds: boundedCount,
    providerRequests: boundedCount,
    outputTokens: boundedCount,
    observedInputTokens: boundedCount,
    observedTotalTokens: boundedCount,
    activeChildren: boundedCount,
  })
  .strict();

export const sessionBudgetV2ReservationSchema = z
  .object({ outputTokens: boundedCount })
  .strict();

export const sessionBudgetV2RemainingSchema = z
  .object({
    elapsedSeconds: boundedCount,
    providerRequests: boundedCount,
    outputTokens: boundedCount,
    activeChildren: boundedCount,
  })
  .strict();

export const sessionBudgetV2ExhaustedLimitSchema = z.enum([
  "elapsed_time",
  "provider_requests",
  "output_tokens",
  "active_children",
]);

export const sessionBudgetV2ProjectionSchema = z
  .object({
    version: z.literal("codeops.session-budget/v2"),
    budgetId: sessionModelBudgetId,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startedAt: isoDateTime,
    observedAt: isoDateTime,
    limits: sessionBudgetV2LimitsSchema,
    usage: sessionBudgetV2UsageSchema,
    reserved: sessionBudgetV2ReservationSchema,
    remaining: sessionBudgetV2RemainingSchema,
    exhaustedLimit: sessionBudgetV2ExhaustedLimitSchema.nullable(),
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
    const expectedRemaining = {
      elapsedSeconds: Math.max(
        0,
        projection.limits.elapsedSeconds - projection.usage.elapsedSeconds,
      ),
      providerRequests: Math.max(
        0,
        projection.limits.providerRequests - projection.usage.providerRequests,
      ),
      outputTokens: Math.max(
        0,
        projection.limits.outputTokens -
          projection.usage.outputTokens -
          projection.reserved.outputTokens,
      ),
      activeChildren: Math.max(
        0,
        projection.limits.activeChildren - projection.usage.activeChildren,
      ),
    };
    for (const field of Object.keys(expectedRemaining) as Array<
      keyof typeof expectedRemaining
    >) {
      if (projection.remaining[field] !== expectedRemaining[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remaining", field],
          message: "session budget remaining value must match durable usage",
        });
      }
    }
    if (
      projection.exhaustedLimit !==
      exhaustedV2Limit(
        projection.limits,
        projection.usage,
        projection.reserved,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exhaustedLimit"],
        message: "session budget exhausted limit must match durable usage",
      });
    }
  });

export const DEFAULT_SESSION_BUDGET_V2_LIMITS: SessionBudgetV2Limits = {
  elapsedSeconds: 6 * 60 * 60,
  providerRequests: 200,
  outputTokens: 1_000_000,
  activeChildren: 4,
};

export function projectSessionBudgetV2(input: {
  readonly budgetId: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly observedAt: string;
  readonly limits?: SessionBudgetV2Limits;
  readonly providerRequests?: number;
  readonly outputTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly observedInputTokens?: number;
  readonly observedTotalTokens?: number;
  readonly activeChildren?: number;
}): SessionBudgetV2Projection {
  const limits = sessionBudgetV2LimitsSchema.parse(
    input.limits ?? DEFAULT_SESSION_BUDGET_V2_LIMITS,
  );
  const usage = sessionBudgetV2UsageSchema.parse({
    elapsedSeconds: Math.max(
      0,
      Math.floor(
        (Date.parse(input.observedAt) - Date.parse(input.startedAt)) / 1_000,
      ),
    ),
    providerRequests: input.providerRequests ?? 0,
    outputTokens: input.outputTokens ?? 0,
    observedInputTokens: input.observedInputTokens ?? 0,
    observedTotalTokens: input.observedTotalTokens ?? 0,
    activeChildren: input.activeChildren ?? 0,
  });
  const reserved = sessionBudgetV2ReservationSchema.parse({
    outputTokens: input.reservedOutputTokens ?? 0,
  });
  return sessionBudgetV2ProjectionSchema.parse({
    version: "codeops.session-budget/v2",
    budgetId: input.budgetId,
    revision: input.revision,
    startedAt: input.startedAt,
    observedAt: input.observedAt,
    limits,
    usage,
    reserved,
    remaining: {
      elapsedSeconds: Math.max(0, limits.elapsedSeconds - usage.elapsedSeconds),
      providerRequests: Math.max(
        0,
        limits.providerRequests - usage.providerRequests,
      ),
      outputTokens: Math.max(
        0,
        limits.outputTokens - usage.outputTokens - reserved.outputTokens,
      ),
      activeChildren: Math.max(
        0,
        limits.activeChildren - usage.activeChildren,
      ),
    },
    exhaustedLimit: exhaustedV2Limit(limits, usage, reserved),
  });
}

function exhaustedV2Limit(
  limits: SessionBudgetV2Limits,
  usage: SessionBudgetV2Usage,
  reserved: SessionBudgetV2Reservation,
): SessionBudgetV2ExhaustedLimit | null {
  if (usage.elapsedSeconds >= limits.elapsedSeconds) return "elapsed_time";
  if (usage.providerRequests >= limits.providerRequests) {
    return "provider_requests";
  }
  if (usage.outputTokens + reserved.outputTokens >= limits.outputTokens) {
    return "output_tokens";
  }
  if (usage.activeChildren >= limits.activeChildren) return "active_children";
  return null;
}

export type SessionBudgetV2Limits = z.infer<
  typeof sessionBudgetV2LimitsSchema
>;
export type SessionBudgetV2Usage = z.infer<typeof sessionBudgetV2UsageSchema>;
export type SessionBudgetV2Reservation = z.infer<
  typeof sessionBudgetV2ReservationSchema
>;
export type SessionBudgetV2Remaining = z.infer<
  typeof sessionBudgetV2RemainingSchema
>;
export type SessionBudgetV2ExhaustedLimit = z.infer<
  typeof sessionBudgetV2ExhaustedLimitSchema
>;
export type SessionBudgetV2Projection = z.infer<
  typeof sessionBudgetV2ProjectionSchema
>;
