import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedSessionActionsForState,
  SESSION_BROKER_VERSION,
  sessionActionTypeSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionSnapshotSchema,
} from "../dist/index.js";

const sessionId = "ses_91a4";
const leaseId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

function capabilities(state = "running", hasCheckpoint = true) {
  const enabled = allowedSessionActionsForState(state, hasCheckpoint);
  return sessionActionTypeSchema.options.map((action) => ({
    action,
    availability: enabled.includes(action) ? "enabled" : "disabled",
    ...(enabled.includes(action) ? {} : { reason: "Unavailable in this state." }),
  }));
}

function snapshot() {
  return {
    version: SESSION_BROKER_VERSION.snapshot,
    sessionId,
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
      acquiredAt: "2026-08-04T03:00:00.000Z",
      expiresAt: "2026-08-04T03:05:00.000Z",
    },
    checkpoint: {
      version: SESSION_BROKER_VERSION.checkpoint,
      checkpointId,
      sessionId,
      generation: 2,
      baseSha: "a".repeat(40),
      patchDigest: `sha256:${"b".repeat(64)}`,
      acpSessionId: "thread-123",
      eventCursor: 180,
      evidenceReferences: ["evidence:test-1"],
      createdAt: "2026-08-04T02:58:00.000Z",
    },
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(),
    updatedAt: "2026-08-04T03:04:00.000Z",
  };
}

test("requires one explicit capability decision for every session action", () => {
  const parsed = sessionSnapshotSchema.parse(snapshot());
  assert.deepEqual(
    parsed.capabilities.map(({ action }) => action),
    sessionActionTypeSchema.options,
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().slice(1),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: [...capabilities().slice(1), capabilities()[1]],
    }),
  );
});

test("binds one durable permission request to waiting state", () => {
  const pendingPermission = {
    requestId: "permission-1",
    title: "Run database migration?",
    description: "Apply the reviewed migration to the session database.",
    options: [
      { optionId: "allow_once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ],
    requestedAt: "2026-08-04T03:04:00.000Z",
  };
  assert.doesNotThrow(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "waiting_permission",
      pendingPermission,
      capabilities: capabilities("waiting_permission", true),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({ ...snapshot(), pendingPermission }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "waiting_permission",
      capabilities: capabilities("waiting_permission", true),
    }),
  );
});

test("fails closed on state-incompatible broker capabilities", () => {
  assert.deepEqual(allowedSessionActionsForState("cancelled", true), [
    "fork",
    "archive",
  ]);
  assert.deepEqual(allowedSessionActionsForState("cancelled", false), [
    "archive",
  ]);
  assert.doesNotThrow(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().map((capability) =>
        capability.availability === "enabled" && capability.action !== "prompt"
          ? {
              action: capability.action,
              availability: "disabled",
              reason: "Temporarily unavailable at the broker.",
            }
          : capability,
      ),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().map((capability) =>
        capability.action === "delete"
          ? { action: "delete", availability: "enabled" }
          : capability,
      ),
    }),
  );
});

test("binds snapshots, checkpoints, and leases to one session generation", () => {
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      lease: { ...snapshot().lease, generation: 2 },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      checkpoint: { ...snapshot().checkpoint, sessionId: "ses_foreign" },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      identity: {
        ...snapshot().identity,
        parentSessionId: "ses_parent",
        forkedAtCursor: null,
      },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({ ...snapshot(), lease: null }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "archived",
      lease: {
        leaseId,
        generation: 3,
        status: "released",
        releasedAt: "2026-08-04T03:04:00.000Z",
      },
      checkpoint: null,
      capabilities: capabilities("archived", true),
    }),
  );
});

test("every mutation carries exact generation, lease, and idempotency identity", () => {
  const common = {
    version: SESSION_BROKER_VERSION.command,
    sessionId,
    generation: 3,
    leaseId,
    idempotencyKey,
  };
  const commands = [
    { ...common, type: "prompt", prompt: "Continue the review." },
    {
      ...common,
      type: "respond_permission",
      permissionRequestId: "permission-1",
      decision: { outcome: "selected", optionId: "allow_once" },
    },
    { ...common, type: "cancel", reason: "Operator cancelled." },
    { ...common, type: "checkpoint" },
    { ...common, type: "hibernate" },
    { ...common, type: "resume", checkpointId },
    {
      ...common,
      type: "fork",
      checkpointId,
      parentEventCursor: 184,
      title: "Try an alternate fix",
    },
    { ...common, type: "archive", reason: "Review retained." },
    {
      ...common,
      type: "delete",
      reason: "Retention policy expired.",
      destructiveAuthorizationId: "44444444-4444-4444-8444-444444444444",
    },
  ];
  assert.deepEqual(
    commands.map((command) => sessionCommandSchema.parse(command).type),
    sessionActionTypeSchema.options,
  );
  for (const field of ["generation", "leaseId", "idempotencyKey"]) {
    assert.throws(() => {
      const command = { ...commands[0] };
      delete command[field];
      sessionCommandSchema.parse(command);
    });
  }
});

test("returns a committed durable snapshot for success and retry", () => {
  const common = {
    version: SESSION_BROKER_VERSION.commandResult,
    commandId: "55555555-5555-4555-8555-555555555555",
    sessionId,
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "prompt",
    eventCursor: 185,
    snapshot: { ...snapshot(), eventCursor: 185 },
    committedAt: "2026-08-04T03:04:01.000Z",
  };
  assert.equal(
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "committed",
    }).disposition,
    "committed",
  );
  assert.equal(
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "duplicate",
      originalCommandId: common.commandId,
    }).disposition,
    "duplicate",
  );
  assert.throws(() =>
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "committed",
      snapshot: { ...snapshot(), sessionId: "ses_foreign" },
    }),
  );
});
