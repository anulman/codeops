import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionRuntimeLifecycleExecutor,
} from "../dist/lifecycle.js";
import { SessionRuntimeTransportError } from "../dist/transport.js";

const dispatchId = "44444444-4444-4444-8444-444444444444";
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive", "delete",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "ses_91a4",
      generation: 3,
      leaseId,
      idempotencyKey,
      type: "prompt",
      prompt: "Continue the bounded implementation.",
    },
    snapshot: {
      version: "codeops.session-snapshot/v1",
      sessionId: "ses_91a4",
      generation: 3,
      state: "running",
      identity: {
        repository: "anulman/renoconcierge",
        branch: "feat/agents-ui",
        baseSha: "a".repeat(40),
        workflowId: "workflow-155",
        runId: "run-155",
        parentSessionId: null,
        forkedAtCursor: null,
      },
      lease: {
        leaseId,
        generation: 3,
        status: "active",
        holderId: "worker-3",
        acquiredAt: "2026-08-04T20:00:00.000Z",
        expiresAt: "2026-08-04T21:00:00.000Z",
      },
      checkpoint: null,
      pendingPermission: null,
      eventCursor: 184,
      capabilities: capabilities(),
      updatedAt: "2026-08-04T20:00:00.000Z",
    },
    dispatchedAt: "2026-08-04T20:00:00.000Z",
  };
}

function memoryReceipts() {
  const records = new Map();
  return {
    records,
    async read(id) { return records.get(id) ?? null; },
    async reserve(input) {
      if (!records.has(input.dispatchId)) {
        const reservation = { ...input, result: null };
        records.set(input.dispatchId, reservation);
        return { acquired: true, reservation };
      }
      return { acquired: false, reservation: records.get(input.dispatchId) };
    },
    async complete(receipt) {
      const current = records.get(receipt.dispatchId);
      if (current?.result === null) records.set(receipt.dispatchId, receipt);
      return records.get(receipt.dispatchId);
    },
  };
}

function lifecycle(overrides = {}) {
  return {
    async prompt() { return { type: "prompt" }; },
    async checkpoint() { throw new Error("unexpected checkpoint"); },
    async hibernate() { throw new Error("unexpected hibernate"); },
    async resume() { throw new Error("unexpected resume"); },
    async fork() { throw new Error("unexpected fork"); },
    ...overrides,
  };
}

test("prepares one ACP/workspace result and replays its immutable receipt", async () => {
  const receipts = memoryReceipts();
  let calls = 0;
  const execute = createSessionRuntimeLifecycleExecutor({
    receipts,
    lifecycle: lifecycle({
      async prompt(value) {
        calls += 1;
        assert.deepEqual(value, dispatch());
        assert.equal("claimToken" in value, false);
        return { type: "prompt" };
      },
    }),
  });
  assert.deepEqual(await execute(dispatch()), { type: "prompt" });
  assert.deepEqual(await execute(dispatch()), { type: "prompt" });
  assert.equal(calls, 1);
  assert.match(receipts.records.get(dispatchId).dispatchDigest, /^sha256:[0-9a-f]{64}$/);
});

test("rejects a receipt rebound to changed dispatch identity", async () => {
  const receipts = memoryReceipts();
  const execute = createSessionRuntimeLifecycleExecutor({
    receipts,
    lifecycle: lifecycle(),
  });
  await execute(dispatch());
  await assert.rejects(
    execute({
      ...dispatch(),
      principalId: "access:mallory@example.com",
    }),
    SessionRuntimeTransportError,
  );
});

test("fails closed on an incomplete reservation without repeating side effects", async () => {
  const receipts = memoryReceipts();
  receipts.records.set(dispatchId, {
    dispatchId,
    dispatchDigest: `sha256:${"a".repeat(64)}`,
    result: null,
  });
  let calls = 0;
  const execute = createSessionRuntimeLifecycleExecutor({
    receipts,
    lifecycle: lifecycle({ async prompt() { calls += 1; return { type: "prompt" }; } }),
  });
  await assert.rejects(
    execute(dispatch()),
    /incomplete and requires repair/,
  );
  assert.equal(calls, 0);
});

test("rejects conflicting completion results after side effects", async () => {
  const receipts = memoryReceipts();
  receipts.complete = async (receipt) => ({
    ...receipt,
    result: { type: "checkpoint", material: {} },
  });
  const execute = createSessionRuntimeLifecycleExecutor({
    receipts,
    lifecycle: lifecycle(),
  });
  await assert.rejects(execute(dispatch()));
});
