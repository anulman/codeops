import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLocalSessionTransition,
  applyPermissionSessionTransition,
} from "../dist/session-broker-transitions.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-8222-222222222222";
const occurredAt = "2026-08-04T04:45:00.000Z";

const allActions = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive", "delete",
];

function capabilities(enabled) {
  return allActions.map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot({ state = "running", checkpoint = true, enabled = ["prompt", "cancel", "checkpoint", "hibernate"] } = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
    generation: 3,
    state,
    identity: {
      repository: "anulman/renoconcierge",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "workflow-155",
      runId: "run-155",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: state === "running" || state === "waiting_permission"
      ? {
          leaseId,
          generation: 3,
          status: "active",
          holderId: "worker-3",
          acquiredAt: "2026-08-04T04:30:00.000Z",
          expiresAt: "2026-08-04T04:50:00.000Z",
        }
      : {
          leaseId,
          generation: 3,
          status: "released",
          releasedAt: "2026-08-04T04:40:00.000Z",
        },
    checkpoint: checkpoint
      ? {
          version: "codeops.session-checkpoint/v1",
          checkpointId,
          sessionId: "ses_91a4",
          generation: 3,
          baseSha: "a".repeat(40),
          patchDigest: `sha256:${"b".repeat(64)}`,
          acpSessionId: "acp-ses-91a4",
          eventCursor: 184,
          evidenceReferences: [],
          createdAt: "2026-08-04T04:40:00.000Z",
        }
      : null,
    pendingPermission: state === "waiting_permission"
      ? {
          requestId: "permission-1",
          title: "Run database migration?",
          description: "Apply the reviewed migration.",
          options: [
            { optionId: "allow_once", label: "Allow once" },
            { optionId: "deny", label: "Deny" },
          ],
          requestedAt: "2026-08-04T04:39:00.000Z",
        }
      : null,
    eventCursor: 184,
    capabilities: capabilities(enabled),
    updatedAt: "2026-08-04T04:40:00.000Z",
  };
}

function command(type, overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    type,
    reason: "Operator requested lifecycle transition.",
    ...overrides,
  };
}

test("cancel releases the lease and retains a resumable checkpoint", () => {
  const result = applyLocalSessionTransition(snapshot(), command("cancel"), occurredAt);
  assert.equal(result.snapshot.state, "cancelled");
  assert.equal(result.snapshot.lease.status, "released");
  assert.equal(result.snapshot.checkpoint.checkpointId, checkpointId);
  assert.deepEqual(
    result.snapshot.capabilities.filter(({ availability }) => availability === "enabled").map(({ action }) => action),
    ["fork", "archive"],
  );
  assert.equal(result.event.type, "state_changed");
  assert.equal(result.event.cursor, 185);
});

test("permission response resolves only the exact pending request", () => {
  const current = snapshot({
    state: "waiting_permission",
    enabled: ["respond_permission", "cancel", "checkpoint", "hibernate"],
  });
  const permission = command("respond_permission", {
    permissionRequestId: "permission-1",
    decision: { outcome: "selected", optionId: "allow_once" },
  });
  const result = applyPermissionSessionTransition(
    current,
    permission,
    occurredAt,
  );
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.snapshot.pendingPermission, null);
  assert.equal(result.snapshot.lease.status, "active");
  assert.equal(result.event.type, "command_committed");
  assert.equal(result.event.cursor, 185);
  assert.throws(() =>
    applyPermissionSessionTransition(
      current,
      { ...permission, permissionRequestId: "permission-other" },
      occurredAt,
    ),
  );
  assert.throws(() =>
    applyPermissionSessionTransition(
      current,
      { ...permission, decision: { outcome: "selected", optionId: "always" } },
      occurredAt,
    ),
  );
});

test("archive remains resumable only when a checkpoint exists", () => {
  for (const checkpoint of [true, false]) {
    const current = snapshot({
      state: "completed",
      checkpoint,
      enabled: checkpoint ? ["fork", "archive"] : ["archive"],
    });
    const result = applyLocalSessionTransition(current, command("archive"), occurredAt);
    assert.equal(result.snapshot.state, "archived");
    assert.equal(result.snapshot.lease.status, "released");
    const enabled = result.snapshot.capabilities
      .filter(({ availability }) => availability === "enabled")
      .map(({ action }) => action);
    assert.deepEqual(enabled, checkpoint ? ["resume", "fork", "delete"] : ["delete"]);
    assert.equal(result.event.type, "session_archived");
  }
});

test("delete creates a durable tombstone without lease or checkpoint material", () => {
  const current = snapshot({
    state: "archived",
    enabled: ["resume", "fork", "delete"],
  });
  const result = applyLocalSessionTransition(
    current,
    command("delete", {
      destructiveAuthorizationId: "44444444-4444-4444-8444-444444444444",
    }),
    occurredAt,
  );
  assert.equal(result.snapshot.state, "deleted");
  assert.equal(result.snapshot.lease, null);
  assert.equal(result.snapshot.checkpoint, null);
  assert.equal(
    result.snapshot.capabilities.every(({ availability }) => availability === "disabled"),
    true,
  );
  assert.equal(result.event.type, "session_deleted");
  assert.match(result.event.eventId, /^sha256:[0-9a-f]{64}$/);
});
