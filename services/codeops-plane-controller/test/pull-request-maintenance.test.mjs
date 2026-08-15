import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePullRequestMaintenance } from "../dist/index.js";

const oldBaseSha = "a".repeat(40);
const newBaseSha = "b".repeat(40);
const headSha = "c".repeat(40);

function position(overrides = {}) {
  return {
    repository: "example-org/example-repository",
    number: 35,
    state: "open",
    headRef: "feat/model-budget-ledger-service",
    headSha,
    baseRef: "main",
    baseSha: oldBaseSha,
    ...overrides,
  };
}

test("keeps an exact reviewed head on its exact current target", () => {
  assert.deepEqual(
    evaluatePullRequestMaintenance({
      binding: position(),
      current: position(),
      target: { ref: "main", sha: oldBaseSha },
      stackParentMerged: false,
    }),
    { action: "current" },
  );
});

test("plans a rebase when unrelated work advances protected main", () => {
  assert.deepEqual(
    evaluatePullRequestMaintenance({
      binding: position(),
      current: position({ baseSha: newBaseSha }),
      target: { ref: "main", sha: newBaseSha },
      stackParentMerged: false,
    }),
    {
      action: "rebase",
      expectedHeadSha: headSha,
      expectedBaseRef: "main",
      expectedBaseSha: oldBaseSha,
      targetBaseRef: "main",
      targetBaseSha: newBaseSha,
      reason: "target-advanced",
    },
  );
});

test("plans an exact retarget and rebase after a stack parent merges", () => {
  const binding = position({
    baseRef: "refactor/claimed-dispatch-authority",
    baseSha: oldBaseSha,
  });
  assert.deepEqual(
    evaluatePullRequestMaintenance({
      binding,
      current: binding,
      target: { ref: "main", sha: newBaseSha },
      stackParentMerged: true,
    }),
    {
      action: "retarget-and-rebase",
      expectedHeadSha: headSha,
      expectedBaseRef: "refactor/claimed-dispatch-authority",
      expectedBaseSha: oldBaseSha,
      targetBaseRef: "main",
      targetBaseSha: newBaseSha,
      reason: "stack-parent-merged",
    },
  );
});

test("recognizes provider retargeting but still requires the branch rebase", () => {
  const binding = position({
    baseRef: "refactor/claimed-dispatch-authority",
    baseSha: oldBaseSha,
  });
  assert.equal(
    evaluatePullRequestMaintenance({
      binding,
      current: position({ baseSha: newBaseSha }),
      target: { ref: "main", sha: newBaseSha },
      stackParentMerged: true,
    }).reason,
    "target-retarget-observed",
  );
});

test("requires requalification after any observed head rewrite", () => {
  assert.deepEqual(
    evaluatePullRequestMaintenance({
      binding: position(),
      current: position({ headSha: "d".repeat(40) }),
      target: { ref: "main", sha: oldBaseSha },
      stackParentMerged: false,
    }),
    {
      action: "requalify",
      expectedHeadSha: headSha,
      currentHeadSha: "d".repeat(40),
      reason: "head-rewritten",
    },
  );
});

test("fails closed for legacy unknown base authority", () => {
  assert.deepEqual(
    evaluatePullRequestMaintenance({
      binding: position({ baseSha: null }),
      current: position(),
      target: { ref: "main", sha: oldBaseSha },
      stackParentMerged: false,
    }),
    { action: "attention", reason: "base-authority-unknown" },
  );
});
