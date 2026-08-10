import assert from "node:assert/strict";
import test from "node:test";
import { sessionRuntimeDispatchDigest } from "../dist/lifecycle.js";
import { reconcileIncompleteRuntimeExecution } from "../dist/repair.js";

const promptResult = {
  type: "prompt",
  material: {
    response: "I completed the bounded implementation.",
    stopReason: "end_turn",
  },
};

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId: "44444444-4444-4444-8444-444444444444",
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "ses_91a4",
      generation: 3,
      leaseId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
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
        leaseId: "11111111-1111-4111-8111-111111111111",
        generation: 3,
        status: "active",
        holderId: "worker-3",
        acquiredAt: "2026-08-04T20:00:00.000Z",
        expiresAt: "2026-08-04T21:00:00.000Z",
      },
      checkpoint: null,
      pendingPermission: null,
      eventCursor: 184,
      capabilities: [
        { action: "prompt", availability: "enabled" },
        ...["respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
          .map((action) => ({ action, availability: "disabled", reason: "Unavailable." })),
      ],
      updatedAt: "2026-08-04T20:00:00.000Z",
    },
    dispatchedAt: "2026-08-04T20:00:00.000Z",
  };
}

function receipts(value = dispatch()) {
  const digest = sessionRuntimeDispatchDigest(value);
  const state = { reservation: { dispatchId: value.dispatchId, dispatchDigest: digest, result: null } };
  return {
    state,
    async read() { return state.reservation; },
    async reserve() { throw new Error("repair must not reserve or execute"); },
    async complete(receipt) { state.reservation = receipt; return receipt; },
  };
}

test("adopts one exact reconciled result without executing side effects", async () => {
  const store = receipts();
  assert.deepEqual(await reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(),
    result: promptResult,
    receipts: store,
  }), promptResult);
  assert.deepEqual(store.state.reservation.result, promptResult);
});

test("replays the exact completed repair but rejects a conflicting result", async () => {
  const completed = receipts();
  completed.state.reservation = { ...completed.state.reservation, result: promptResult };
  assert.deepEqual(await reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(), result: promptResult, receipts: completed,
  }), promptResult);

  completed.state.reservation = {
    ...completed.state.reservation,
    result: {
      type: "checkpoint",
      material: {
        checkpointId: "77777777-7777-4777-8777-777777777777",
        patchDigest: `sha256:${"c".repeat(64)}`,
        acpSessionId: "acp-7",
        evidenceReferences: [],
      },
    },
  };
  await assert.rejects(reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(), result: promptResult, receipts: completed,
  }), /conflicted with the reconciled result/);
});

test("rejects absent, drifted, or wrong-type reservations", async () => {
  const absent = receipts();
  absent.read = async () => null;
  await assert.rejects(reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(), result: promptResult, receipts: absent,
  }), /exact incomplete reservation/);

  const drifted = receipts();
  drifted.state.reservation = { ...drifted.state.reservation, dispatchDigest: `sha256:${"b".repeat(64)}` };
  await assert.rejects(reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(), result: promptResult, receipts: drifted,
  }), /exact incomplete reservation/);

  await assert.rejects(reconcileIncompleteRuntimeExecution({
    dispatch: dispatch(),
    result: {
      type: "checkpoint",
      material: {
        checkpointId: "77777777-7777-4777-8777-777777777777",
        patchDigest: `sha256:${"c".repeat(64)}`,
        acpSessionId: "acp-7",
        evidenceReferences: [],
      },
    },
    receipts: receipts(),
  }), /result type drifted/);
});
