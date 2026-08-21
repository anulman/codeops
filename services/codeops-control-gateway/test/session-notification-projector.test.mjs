import assert from "node:assert/strict";
import test from "node:test";

import {
  notificationForProjection,
  projectNextSessionNotification,
} from "../dist/session-notification-projector.js";

const capabilities = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive",
].map((action) => ["respond_permission", "cancel", "checkpoint", "hibernate"].includes(action)
  ? { action, availability: "enabled" }
  : { action, availability: "disabled", reason: "Unavailable." });

const snapshot = {
  version: "codeops.session-snapshot/v1",
  sessionId: "session-1",
  generation: 1,
  state: "waiting_permission",
  identity: {
    repository: "anulman/codeops",
    branch: "feat/web-push-notifications",
    baseSha: "a".repeat(40),
    workflowId: "workflow-1",
    runId: "run-1",
    parentSessionId: null,
    forkedAtCursor: null,
  },
  lease: {
    leaseId: "2d2bdc08-11f7-44f4-b582-018249f825c4",
    generation: 1,
    status: "active",
    holderId: "worker-1",
    acquiredAt: "2026-08-14T23:00:00.000Z",
    expiresAt: "2026-08-15T00:00:00.000Z",
  },
  pendingPermission: {
    requestId: `permission-${"a".repeat(64)}`,
    title: "Publish a secret value",
    description: "Review the bounded operation.",
    operation: { kind: "command", command: "secret command", cwd: "/workspace" },
    operationDigest: `sha256:${"b".repeat(64)}`,
    options: [{ optionId: "allow-once", label: "Allow once" }],
    requestedAt: "2026-08-14T23:40:00.000Z",
  },
  checkpoint: null,
  capabilities,
  eventCursor: 9,
  updatedAt: "2026-08-14T23:40:00.000Z",
};

test("creates a minimal identity-bound notification for an actionable transition", () => {
  const item = notificationForProjection({
    generation: 1,
    eventCursor: 8,
    state: "running",
    exhaustedLimit: null,
  }, snapshot);
  assert.equal(item.kind, "permission-needed");
  assert.equal(item.url, "/sessions/session-1");
  assert.match(item.key, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(item).includes("secret"), false);
});

test("does not notify for initial projection, generation changes, or running progress", () => {
  assert.equal(notificationForProjection(null, snapshot), null);
  assert.equal(notificationForProjection({
    generation: 2,
    eventCursor: 8,
    state: "running",
    exhaustedLimit: null,
  }, snapshot), null);
  assert.equal(notificationForProjection({
    generation: 1,
    eventCursor: 8,
    state: "queued",
    exhaustedLimit: null,
  }, { ...snapshot, state: "running", pendingPermission: null }), null);
});

test("fans one notification organization-wide to active subscriptions and replays idempotently", async () => {
  const calls = [];
  const subscriptions = [
    { subscriptionId: "subscription-a", principalId: "principal-a", status: "active" },
    { subscriptionId: "subscription-b", principalId: "principal-b", status: "active" },
    { subscriptionId: "subscription-revoked", principalId: "principal-a", status: "revoked" },
  ];
  const deliveries = new Map();
  const database = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("SELECT s.snapshot_json")) {
        return { rowCount: 1, rows: [{
          snapshot_json: snapshot,
          projected_generation: 1,
          projected_event_cursor: 8,
          projected_state: "running",
          exhausted_limit: null,
        }] };
      }
      if (text.includes("INSERT INTO codeops.session_notification_deliveries")) {
        const selectedSubscriptions = text.includes("WHERE status = 'active'")
          ? subscriptions.filter(({ status }) => status === "active")
          : subscriptions;
        for (const subscription of selectedSubscriptions) {
          const pair = `${values[0]}\0${subscription.subscriptionId}`;
          if (!deliveries.has(pair)) {
            deliveries.set(pair, {
              notificationId: values[0],
              subscriptionId: subscription.subscriptionId,
              principalId: subscription.principalId,
            });
          }
        }
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const input = { database, now: "2026-08-14T23:41:00.000Z" };
  assert.equal(await projectNextSessionNotification(input), true);
  assert.equal(await projectNextSessionNotification(input), true);
  assert.equal(calls[0].text, "BEGIN");
  assert.match(calls[2].text, /session_notification_projections/);
  assert.match(calls[3].text, /session_notification_outbox/);
  const deliveryWrites = calls.filter(({ text }) =>
    text.includes("INSERT INTO codeops.session_notification_deliveries"));
  assert.equal(deliveryWrites.length, 2);
  assert.match(deliveryWrites[0].text, /WHERE status = 'active'/);
  assert.doesNotMatch(deliveryWrites[0].text, /principal_id|owner/);
  assert.match(
    deliveryWrites[0].text,
    /ON CONFLICT \(notification_id, subscription_id\) DO NOTHING/,
  );
  assert.deepEqual([...deliveries.values()].map(({ subscriptionId, principalId }) => ({
    subscriptionId,
    principalId,
  })), [
    { subscriptionId: "subscription-a", principalId: "principal-a" },
    { subscriptionId: "subscription-b", principalId: "principal-b" },
  ]);
  assert.equal(new Set([...deliveries.values()].map(({ notificationId }) => notificationId)).size, 1);
  assert.equal(calls.at(-1).text, "COMMIT");
  assert.equal(JSON.stringify(calls).includes("secret command"), false);
});

test("commits an empty projector poll without writing projection state", async () => {
  const calls = [];
  const database = {
    async query(text) {
      calls.push(text);
      return text.includes("SELECT s.snapshot_json")
        ? { rowCount: 0, rows: [] }
        : { rowCount: 0, rows: [] };
    },
  };
  assert.equal(await projectNextSessionNotification({ database }), false);
  assert.deepEqual([calls[0], calls.at(-1)], ["BEGIN", "COMMIT"]);
});
