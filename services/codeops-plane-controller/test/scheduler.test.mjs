import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePullRequestEvent,
  evaluateTicketScheduling,
} from "../dist/index.js";

const MAIN = "8f3d2c033f70be04b4b2dc8a005683806e84e209";
const A_HEAD = "a".repeat(40);
const B_HEAD = "b".repeat(40);
const UPDATED_A_HEAD = "c".repeat(40);

function ticket(id, input = {}) {
  return {
    id,
    state: "ready",
    blockedBy: [],
    workflow: "none",
    ...input,
  };
}

function decide(ticketId, values) {
  return evaluateTicketScheduling({
    ticketId,
    tickets: new Map(values.map((value) => [value.id, value])),
    protectedMainSha: MAIN,
  });
}

test("starts an unblocked Ready ticket from exact protected main", () => {
  assert.deepEqual(decide("A", [ticket("A")]), {
    action: "start",
    mode: "main",
    baseSha: MAIN,
    baseRef: "main",
    reason: "all-blockers-complete",
  });
});

test("holds Ready descendants for every unresolved non-review blocker state", () => {
  for (const state of [
    "ready",
    "in_progress",
    "paused",
    "cancelled",
    "failed",
    "unknown",
  ]) {
    assert.deepEqual(
      decide("B", [
        ticket("A", { state }),
        ticket("B", { blockedBy: ["A"] }),
      ]),
      { action: "hold", reason: `blocker-A-state-${state}` },
    );
  }
});

test("uses one native stack and branch-only fallback for direct Ready siblings", () => {
  const parent = ticket("A", {
    state: "needs_attention",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  for (const [childId, stackStrategy] of [
    ["B", "native"],
    ["C", "branch-only"],
  ]) {
    assert.deepEqual(
      decide(childId, [
        parent,
        ticket("B", { blockedBy: ["A"] }),
        ticket("C", { blockedBy: ["A"] }),
      ]),
      {
        action: "start",
        mode: "stacked",
        baseSha: A_HEAD,
        baseRef: "feat/a",
        parentTicketId: "A",
        stackStrategy,
        reason: "qualified-direct-blocker-review",
      },
    );
  }
});

test("requires a qualified exact open PR instead of trusting Needs attention alone", () => {
  for (const pullRequest of [
    undefined,
    {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "closed",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
    {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: false,
    },
  ]) {
    assert.deepEqual(
      decide("B", [
        ticket("A", { state: "needs_attention", pullRequest }),
        ticket("B", { blockedBy: ["A"] }),
      ]),
      { action: "hold", reason: "blocker-A-has-no-qualified-open-pr" },
    );
  }
});

test("prohibits a third unmerged PR in one dependency chain", () => {
  const a = ticket("A", {
    state: "needs_attention",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  const b = ticket("B", {
    state: "needs_attention",
    blockedBy: ["A"],
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 159,
      state: "open",
      headSha: B_HEAD,
      headRef: "feat/b",
      baseRef: "feat/a",
      baseTicketId: "A",
      qualified: true,
    },
  });
  assert.deepEqual(
    decide("D", [a, b, ticket("D", { blockedBy: ["B"] })]),
    { action: "hold", reason: "maximum-unmerged-stack-depth-reached" },
  );
});

test("fails closed when a review parent has any unresolved ancestor state", () => {
  const a = ticket("A", { state: "paused" });
  const b = ticket("B", {
    state: "needs_attention",
    blockedBy: ["A"],
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 159,
      state: "open",
      headSha: B_HEAD,
      headRef: "feat/b",
      baseRef: "feat/a",
      baseTicketId: "A",
      qualified: true,
    },
  });
  assert.deepEqual(
    decide("D", [a, b, ticket("D", { blockedBy: ["B"] })]),
    { action: "hold", reason: "maximum-unmerged-stack-depth-reached" },
  );
});

test("allows the next stack after the older ancestor becomes Complete", () => {
  const a = ticket("A", {
    state: "complete",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "merged",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  const b = ticket("B", {
    state: "needs_attention",
    blockedBy: ["A"],
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 159,
      state: "open",
      headSha: B_HEAD,
      headRef: "feat/b",
      baseRef: "main",
      qualified: true,
    },
  });
  assert.deepEqual(
    decide("D", [a, b, ticket("D", { blockedBy: ["B"] })]),
    {
      action: "start",
      mode: "stacked",
      baseSha: B_HEAD,
      baseRef: "feat/b",
      parentTicketId: "B",
      stackStrategy: "native",
      reason: "qualified-direct-blocker-review",
    },
  );
});

test("retains integration provenance when a completed child landed in an open parent branch", () => {
  const a = ticket("A", {
    state: "needs_attention",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: UPDATED_A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  const b = ticket("B", {
    state: "complete",
    blockedBy: ["A"],
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 159,
      state: "merged",
      headSha: B_HEAD,
      headRef: "feat/b",
      baseRef: "feat/a",
      baseTicketId: "A",
      qualified: true,
    },
  });
  assert.deepEqual(
    decide("D", [a, b, ticket("D", { blockedBy: ["B"] })]),
    {
      action: "start",
      mode: "stacked",
      baseSha: UPDATED_A_HEAD,
      baseRef: "feat/a",
      parentTicketId: "A",
      stackStrategy: "branch-only",
      reason: "qualified-direct-blocker-review",
    },
  );
});

test("extends a native stack only from its exact current top", () => {
  const parent = (position, size) =>
    ticket("A", {
      state: "needs_attention",
      pullRequest: {
        repository: "anulman/renoconcierge",
        number: 158,
        state: "open",
        headSha: A_HEAD,
        headRef: "feat/a",
        baseRef: "main",
        nativeStack: {
          number: 42,
          position,
          size,
          base: { ref: "main", sha: MAIN },
          active: true,
        },
        qualified: true,
      },
    });
  assert.equal(
    decide("B", [parent(2, 2), ticket("B", { blockedBy: ["A"] })])
      .stackStrategy,
    "native",
  );
  assert.equal(
    decide("B", [parent(1, 2), ticket("B", { blockedBy: ["A"] })])
      .stackStrategy,
    "branch-only",
  );
});

test("cancels running work when any direct blocker becomes ineligible", () => {
  assert.deepEqual(
    decide("D", [
      ticket("A", { state: "needs_attention" }),
      ticket("B", { state: "paused" }),
      ticket("D", {
        state: "in_progress",
        blockedBy: ["A", "B"],
        workflow: "running",
      }),
    ]),
    { action: "cancel", reason: "blocker-B-state-paused" },
  );
});

test("fails closed when multiple qualified review blockers imply unrelated bases", () => {
  const review = (id, number, headSha) =>
    ticket(id, {
      state: "needs_attention",
      pullRequest: {
        repository: "anulman/renoconcierge",
        number,
        state: "open",
        headSha,
        headRef: `feat/${id.toLowerCase()}`,
        baseRef: "main",
        qualified: true,
      },
    });
  assert.deepEqual(
    decide("D", [
      review("A", 158, A_HEAD),
      review("B", 159, B_HEAD),
      ticket("D", { blockedBy: ["A", "B"] }),
    ]),
    { action: "hold", reason: "multiple-unresolved-blockers" },
  );
});

test("cancels running work when its own ticket is paused or cancelled", () => {
  for (const state of ["paused", "cancelled"]) {
    assert.deepEqual(
      decide("A", [ticket("A", { state, workflow: "running" })]),
      {
        action: "cancel",
        reason: `ticket-state-${state}-is-not-runnable`,
      },
    );
  }
});

test("marks only an exact bound merged PR complete", () => {
  const bound = ticket("A", {
    state: "needs_attention",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  assert.deepEqual(
    evaluatePullRequestEvent({
      ticket: bound,
      event: {
        repository: "anulman/renoconcierge",
        number: 158,
        action: "closed",
        merged: true,
        headSha: A_HEAD,
      },
    }),
    { action: "complete-ticket", ticketId: "A" },
  );
  assert.deepEqual(
    evaluatePullRequestEvent({
      ticket: bound,
      event: {
        repository: "anulman/renoconcierge",
        number: 158,
        action: "closed",
        merged: true,
        headSha: B_HEAD,
      },
    }),
    {
      action: "require-attention",
      ticketId: "A",
      reason: "bound-pr-head-drifted",
    },
  );
});

test("never completes a closed-unmerged or rewritten PR", () => {
  const bound = ticket("A", {
    state: "needs_attention",
    pullRequest: {
      repository: "anulman/renoconcierge",
      number: 158,
      state: "open",
      headSha: A_HEAD,
      headRef: "feat/a",
      baseRef: "main",
      qualified: true,
    },
  });
  assert.deepEqual(
    evaluatePullRequestEvent({
      ticket: bound,
      event: {
        repository: "anulman/renoconcierge",
        number: 158,
        action: "closed",
        merged: false,
        headSha: A_HEAD,
      },
    }),
    {
      action: "require-attention",
      ticketId: "A",
      reason: "bound-pr-closed-without-merge",
    },
  );
  assert.deepEqual(
    evaluatePullRequestEvent({
      ticket: bound,
      event: {
        repository: "anulman/renoconcierge",
        number: 158,
        action: "synchronize",
        merged: false,
        headSha: B_HEAD,
      },
    }),
    {
      action: "require-attention",
      ticketId: "A",
      reason: "bound-pr-head-drifted",
    },
  );
});
