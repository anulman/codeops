import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import { dispatchAgentJob } from "../dist/activities.js";
import { transition } from "../dist/model.js";

test("accepts only the reviewed Trial 0 lifecycle", () => {
  let snapshot = {
    state: "requested",
    sequence: 0,
    summary: "Routing matrix",
  };
  for (const state of [
    "started",
    "planning",
    "approval_required",
    "executing",
    "evidence_ready",
    "validating",
    "completed",
  ]) {
    snapshot = transition(snapshot, state, state);
  }
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.sequence, 7);
});

test("terminal states and skipped gates fail closed", () => {
  assert.throws(
    () =>
      transition(
        { state: "approval_required", sequence: 3, summary: "review" },
        "completed",
        "skip",
      ),
    /invalid CodeOps transition/,
  );
  assert.throws(
    () =>
      transition(
        { state: "completed", sequence: 7, summary: "done" },
        "executing",
        "retry",
      ),
    /invalid CodeOps transition/,
  );
});

test("the Agent Job boundary refuses to simulate execution", async () => {
  await assert.rejects(
    dispatchAgentJob({
      workItemId: "work-1",
      workflowId: "workflow-1",
      baseSha: "a".repeat(40),
      summary: "Routing matrix",
    }),
    /refusing to simulate execution/,
  );
});

test("Temporal can bundle the workflow in its deterministic sandbox", async () => {
  const workflowsPath = fileURLToPath(
    new URL("../dist/workflow.js", import.meta.url),
  );
  const bundle = await bundleWorkflowCode({ workflowsPath });
  assert.ok(bundle.code.length > 1_000);
});
