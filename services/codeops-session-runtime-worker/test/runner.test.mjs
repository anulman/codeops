import assert from "node:assert/strict";
import test from "node:test";
import { runSessionRuntimeWorker } from "../dist/runner.js";

const committed = {
  version: "codeops.session-command-result/v1",
  commandId: "66666666-6666-4666-8666-666666666666",
  sessionId: "ses_91a4",
  generation: 3,
  leaseId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  type: "prompt",
  eventCursor: 185,
  snapshot: {},
  committedAt: "2026-08-04T20:03:01.000Z",
  disposition: "committed",
};

test("polls serially, reports completion, and stops on its signal", async () => {
  const controller = new AbortController();
  const calls = [];
  const completed = [];
  await runSessionRuntimeWorker({
    transport: {
      async runOne(input) {
        calls.push(input);
        if (calls.length === 1) return committed;
        controller.abort();
        return null;
      },
    },
    execute: async () => ({ type: "prompt" }),
    leaseMs: 900_000,
    idlePollMs: 100,
    signal: controller.signal,
    onCompleted: (result) => completed.push(result),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].leaseMs, 900_000);
  assert.equal(calls[0].execute, calls[1].execute);
  assert.deepEqual(completed, [committed]);
});

test("propagates execution errors without automatically claiming again", async () => {
  let calls = 0;
  await assert.rejects(
    runSessionRuntimeWorker({
      transport: {
        async runOne() {
          calls += 1;
          throw new Error("ambiguous ACP operation");
        },
      },
      execute: async () => ({ type: "prompt" }),
      leaseMs: 1_000,
      idlePollMs: 100,
      signal: new AbortController().signal,
    }),
    /ambiguous ACP operation/,
  );
  assert.equal(calls, 1);
});

test("rejects poll and lease bounds before claiming", async () => {
  let calls = 0;
  const transport = { async runOne() { calls += 1; return null; } };
  await assert.rejects(runSessionRuntimeWorker({
    transport,
    execute: async () => ({ type: "prompt" }),
    leaseMs: 999,
    idlePollMs: 100,
    signal: new AbortController().signal,
  }), /claim lease/);
  await assert.rejects(runSessionRuntimeWorker({
    transport,
    execute: async () => ({ type: "prompt" }),
    leaseMs: 1_000,
    idlePollMs: 31_000,
    signal: new AbortController().signal,
  }), /idle poll/);
  assert.equal(calls, 0);
});
