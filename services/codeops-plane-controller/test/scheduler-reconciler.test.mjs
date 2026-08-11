import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileProjectScheduling } from "../dist/index.js";

const mainSha = "a".repeat(40);
const reviewSha = "b".repeat(40);

function ticket(id, overrides = {}) {
  return {
    id,
    state: "ready",
    blockedBy: [],
    workflow: "none",
    ...overrides,
  };
}

test("starts eligible siblings on the exact review head in deterministic order", async () => {
  const parent = ticket("a", {
    state: "needs_attention",
    pullRequest: {
      repository: "example-org/example-repository",
      number: 158,
      state: "open",
      headSha: reviewSha,
      headRef: "codeops/ticket-a",
      baseRef: "main",
      qualified: true,
    },
  });
  const tickets = new Map([
    ["c", ticket("c", { blockedBy: ["a"] })],
    ["a", parent],
    ["b", ticket("b", { blockedBy: ["a"] })],
  ]);
  const calls = [];
  const actions = await reconcileProjectScheduling({
    tickets,
    protectedMainSha: mainSha,
    async start({ ticket, decision }) {
      calls.push([
        "start",
        ticket.id,
        decision.mode,
        decision.baseSha,
        decision.stackStrategy,
      ]);
    },
    async cancel() {
      throw new Error("unexpected cancellation");
    },
  });
  assert.deepEqual(calls, [
    ["start", "b", "stacked", reviewSha, "native"],
    ["start", "c", "stacked", reviewSha, "branch-only"],
  ]);
  assert.deepEqual(actions.map(({ ticketId }) => ticketId), ["b", "c"]);
});

test("cancels running descendants before leaving held tickets untouched", async () => {
  const tickets = new Map([
    ["a", ticket("a", { state: "paused" })],
    [
      "b",
      ticket("b", {
        state: "in_progress",
        blockedBy: ["a"],
        workflow: "running",
      }),
    ],
    ["c", ticket("c", { blockedBy: ["a"] })],
  ]);
  const calls = [];
  const actions = await reconcileProjectScheduling({
    tickets,
    protectedMainSha: mainSha,
    async start() {
      throw new Error("unexpected start");
    },
    async cancel({ ticket, decision }) {
      calls.push([ticket.id, decision.reason]);
    },
  });
  assert.deepEqual(calls, [["b", "blocker-a-state-paused"]]);
  assert.deepEqual(actions.map(({ ticketId }) => ticketId), ["b"]);
});

test("after a parent merge, starts the formerly held direct child from main", async () => {
  const tickets = new Map([
    [
      "a",
      ticket("a", {
        state: "complete",
        pullRequest: {
          repository: "example-org/example-repository",
          number: 158,
          state: "merged",
          headSha: reviewSha,
          headRef: "codeops/ticket-a",
          baseRef: "main",
          qualified: false,
        },
      }),
    ],
    ["b", ticket("b", { blockedBy: ["a"] })],
  ]);
  const calls = [];
  await reconcileProjectScheduling({
    tickets,
    protectedMainSha: mainSha,
    async start({ ticket, decision }) {
      calls.push([ticket.id, decision.mode, decision.baseSha]);
    },
    async cancel() {},
  });
  assert.deepEqual(calls, [["b", "main", mainSha]]);
});
