import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_BUDGET_LIMITS,
  DEFAULT_SESSION_BUDGET_V2_LIMITS,
  projectSessionBudget,
  projectSessionBudgetV2,
  sessionBudgetProjectionSchema,
  sessionBudgetV2ProjectionSchema,
} from "../dist/session-budget.js";

test("projects exact current, limit, remaining, and exhausted budget state", () => {
  const startedAt = "2026-08-14T18:00:00.000Z";
  const active = projectSessionBudget({
    startedAt,
    observedAt: "2026-08-14T18:01:30.000Z",
    totalTokens: 12_000,
    modelRequests: 3,
    activeChildren: 2,
  });
  assert.deepEqual(active.limits, DEFAULT_SESSION_BUDGET_LIMITS);
  assert.deepEqual(active.usage, {
    elapsedSeconds: 90,
    totalTokens: 12_000,
    modelRequests: 3,
    activeChildren: 2,
  });
  assert.equal(active.remaining.elapsedSeconds, 21_510);
  assert.equal(active.remaining.totalTokens, 988_000);
  assert.equal(active.remaining.modelRequests, 197);
  assert.equal(active.remaining.activeChildren, 2);
  assert.equal(active.exhaustedLimit, null);

  assert.equal(projectSessionBudget({
    startedAt,
    observedAt: "2026-08-15T00:00:00.000Z",
  }).exhaustedLimit, "elapsed_time");
  assert.equal(projectSessionBudget({
    startedAt,
    observedAt: startedAt,
    totalTokens: 1_000_000,
  }).exhaustedLimit, "total_tokens");
  assert.equal(projectSessionBudget({
    startedAt,
    observedAt: startedAt,
    modelRequests: 200,
  }).exhaustedLimit, "model_requests");
  assert.equal(projectSessionBudget({
    startedAt,
    observedAt: startedAt,
    activeChildren: 4,
  }).exhaustedLimit, "active_children");
});

test("projects hard provider and output limits separately from telemetry", () => {
  const projection = projectSessionBudgetV2({
    budgetId: "session-123",
    revision: 7,
    startedAt: "2026-08-14T18:00:00.000Z",
    observedAt: "2026-08-14T18:01:30.000Z",
    providerRequests: 3,
    outputTokens: 1_200,
    reservedOutputTokens: 300,
    observedInputTokens: 8_000,
    observedTotalTokens: 9_200,
    activeChildren: 2,
  });
  assert.deepEqual(projection.limits, DEFAULT_SESSION_BUDGET_V2_LIMITS);
  assert.deepEqual(projection.usage, {
    elapsedSeconds: 90,
    providerRequests: 3,
    outputTokens: 1_200,
    observedInputTokens: 8_000,
    observedTotalTokens: 9_200,
    activeChildren: 2,
  });
  assert.deepEqual(projection.reserved, { outputTokens: 300 });
  assert.equal(projection.remaining.providerRequests, 197);
  assert.equal(projection.remaining.outputTokens, 998_500);
  assert.equal(projection.exhaustedLimit, null);
});

test("counts reserved output against the hard version 2 ceiling", () => {
  const exact = projectSessionBudgetV2({
    budgetId: "session-123",
    revision: 1,
    startedAt: "2026-08-14T18:00:00.000Z",
    observedAt: "2026-08-14T18:00:00.000Z",
    limits: {
      ...DEFAULT_SESSION_BUDGET_V2_LIMITS,
      outputTokens: 2_000,
    },
    outputTokens: 1_200,
    reservedOutputTokens: 800,
  });
  assert.equal(exact.remaining.outputTokens, 0);
  assert.equal(exact.exhaustedLimit, "output_tokens");
  assert.throws(
    () =>
      sessionBudgetV2ProjectionSchema.parse({
        ...exact,
        remaining: { ...exact.remaining, outputTokens: 1 },
      }),
    /remaining value/,
  );
});

test("rejects forged remaining values and exhausted limits", () => {
  const exact = projectSessionBudget({
    startedAt: "2026-08-14T18:00:00.000Z",
    observedAt: "2026-08-14T18:01:00.000Z",
  });
  assert.throws(() => sessionBudgetProjectionSchema.parse({
    ...exact,
    remaining: { ...exact.remaining, totalTokens: 1 },
  }), /remaining value/);
  assert.throws(() => sessionBudgetProjectionSchema.parse({
    ...exact,
    exhaustedLimit: "total_tokens",
  }), /exhausted limit/);
});
