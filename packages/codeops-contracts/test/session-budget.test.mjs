import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_BUDGET_LIMITS,
  projectSessionBudget,
  sessionBudgetProjectionSchema,
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
