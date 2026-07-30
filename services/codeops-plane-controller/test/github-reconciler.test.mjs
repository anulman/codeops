import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileGitHubPullRequestEvent } from "../dist/index.js";

const binding = {
  version: "codeops.pull-request-binding/v1",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
  workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  workflowId: "codeops-ready-123",
  repository: "anulman/renoconcierge",
  number: 158,
  state: "open",
  headSha: "a".repeat(40),
  headRef: "codeops/ticket-b",
  baseRef: "codeops/ticket-a",
  baseTicketId: "77777777-7777-4777-8777-777777777777",
  qualified: true,
  updatedAt: "2026-07-30T21:00:00.000Z",
};

function event(overrides = {}) {
  return {
    repository: binding.repository,
    number: binding.number,
    action: "closed",
    merged: true,
    headSha: binding.headSha,
    headRef: binding.headRef,
    baseRef: binding.baseRef,
    ...overrides,
  };
}

function harness(current = binding) {
  const calls = [];
  let stored = current;
  return {
    calls,
    get stored() {
      return stored;
    },
    input: {
      receivedAt: "2026-07-30T21:30:00.000Z",
      bindings: {
        async getByPullRequest() {
          return stored;
        },
        async getByWorkItem() {
          return stored;
        },
        async put(value) {
          calls.push(["put", value.state, value.headSha, value.qualified]);
          stored = value;
        },
      },
      async completeTicket({ binding: found }) {
        calls.push(["complete", found.workItemId]);
      },
      async requireAttention({ reason }) {
        calls.push(["attention", reason]);
      },
      async reevaluateProject({ projectId }) {
        calls.push(["reevaluate", projectId]);
      },
    },
  };
}

test("completes only an exact bound merged PR, then re-evaluates dependents", async () => {
  const run = harness();
  const result = await reconcileGitHubPullRequestEvent({
    ...run.input,
    event: event(),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(run.calls, [
    ["complete", binding.workItemId],
    ["put", "merged", binding.headSha, false],
    ["reevaluate", binding.projectId],
  ]);
});

test("head drift clears qualification and requires attention without completing", async () => {
  const run = harness();
  const newHead = "b".repeat(40);
  const result = await reconcileGitHubPullRequestEvent({
    ...run.input,
    event: event({ headSha: newHead }),
  });
  assert.equal(result.status, "attention-required");
  assert.deepEqual(run.calls, [
    ["put", "closed", newHead, false],
    ["attention", "bound-pr-head-drifted"],
    ["reevaluate", binding.projectId],
  ]);
});

test("ref drift never completes an otherwise matching merged PR", async () => {
  const run = harness();
  const result = await reconcileGitHubPullRequestEvent({
    ...run.input,
    event: event({ baseRef: "main" }),
  });
  assert.equal(result.status, "attention-required");
  assert.deepEqual(run.calls.slice(0, 2), [
    ["put", "closed", binding.headSha, false],
    ["attention", "bound-pr-ref-drifted"],
  ]);
});

test("synchronize and close-without-merge fail closed and are retry-safe", async () => {
  const synchronized = harness();
  await reconcileGitHubPullRequestEvent({
    ...synchronized.input,
    event: event({ action: "synchronize", merged: false }),
  });
  assert.deepEqual(synchronized.calls.slice(0, 2), [
    ["put", "open", binding.headSha, false],
    ["attention", "bound-pr-head-requires-requalification"],
  ]);

  const closed = harness();
  await reconcileGitHubPullRequestEvent({
    ...closed.input,
    event: event({ merged: false }),
  });
  assert.deepEqual(closed.calls.slice(0, 2), [
    ["put", "closed", binding.headSha, false],
    ["attention", "bound-pr-closed-without-merge"],
  ]);

  const duplicate = harness({ ...binding, state: "merged", qualified: false });
  assert.deepEqual(
    await reconcileGitHubPullRequestEvent({
      ...duplicate.input,
      event: event(),
    }),
    { status: "ignored", reason: "pull-request-merge-already-reconciled" },
  );
  assert.deepEqual(duplicate.calls, []);
});

test("ignores PRs without a durable ticket binding", async () => {
  const run = harness(null);
  assert.deepEqual(
    await reconcileGitHubPullRequestEvent({ ...run.input, event: event() }),
    { status: "ignored", reason: "pull-request-is-not-bound" },
  );
  assert.deepEqual(run.calls, []);
});
