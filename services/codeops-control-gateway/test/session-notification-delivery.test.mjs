import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeWebPushDelivery,
  claimWebPushDelivery,
  sendClaimedWebPush,
  WebPushDeliveryClaimConflictError,
} from "../dist/session-notification-delivery.js";

const notification = {
  version: "codeops.session-push-notification/v1",
  key: `sha256:${"a".repeat(64)}`,
  kind: "permission-needed",
  sessionId: "session-1",
  generation: 1,
  eventCursor: 3,
  title: "Session needs permission",
  body: "Open the session to approve or deny the requested operation.",
  url: "/sessions/session-1",
};

const claim = {
  notificationId: notification.key,
  subscriptionId: `sha256:${"b".repeat(64)}`,
  claimToken: "11111111-1111-4111-8111-111111111111",
  workerId: "control-gateway:web-push",
  endpoint: "https://web.push.apple.com/example",
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  notification,
  attemptCount: 1,
};

test("claims one active subscription with an exact expiring delivery fence", async () => {
  const calls = [];
  const database = {
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [{
        notification_id: notification.key,
        subscription_id: claim.subscriptionId,
        endpoint: claim.endpoint,
        p256dh: claim.keys.p256dh,
        auth: claim.keys.auth,
        notification_json: notification,
        attempt_count: 1,
      }] };
    },
  };
  const result = await claimWebPushDelivery({
    database,
    workerId: claim.workerId,
    now: new Date("2026-08-14T23:45:00.000Z"),
    claimToken: () => claim.claimToken,
  });
  assert.deepEqual(result, claim);
  assert.match(calls[0].text, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(calls[0].text, /s\.status = 'active'/);
  assert.equal(calls[0].values[3], "2026-08-14T23:45:30.000Z");
});

function ackDatabase(rowOverrides = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("SELECT status, claim_token")) {
        return { rowCount: 1, rows: [{
          status: "claimed",
          claim_token: claim.claimToken,
          claimed_by: claim.workerId,
          claim_expires_at: "2026-08-14T23:46:00.000Z",
          attempt_count: claim.attemptCount,
          ...rowOverrides,
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

test("acknowledges only the exact unexpired delivery claim", async () => {
  const database = ackDatabase();
  await acknowledgeWebPushDelivery({
    database,
    claim,
    outcome: { status: "delivered", statusCode: 201 },
    now: new Date("2026-08-14T23:45:10.000Z"),
  });
  assert.match(database.calls[2].text, /status = 'delivered'/);
  assert.equal(database.calls.at(-1).text, "COMMIT");

  await assert.rejects(acknowledgeWebPushDelivery({
    database: ackDatabase({ claim_token: "22222222-2222-4222-8222-222222222222" }),
    claim,
    outcome: { status: "delivered", statusCode: 201 },
    now: new Date("2026-08-14T23:45:10.000Z"),
  }), WebPushDeliveryClaimConflictError);
});

test("revokes expired endpoints and backs off retryable failures", async () => {
  const expired = ackDatabase();
  await acknowledgeWebPushDelivery({
    database: expired,
    claim,
    outcome: { status: "failed", statusCode: 410 },
    now: new Date("2026-08-14T23:45:10.000Z"),
  });
  assert.match(expired.calls[2].text, /web_push_subscriptions/);
  assert.match(expired.calls[3].text, /status = 'revoked'/);

  const retry = ackDatabase();
  await acknowledgeWebPushDelivery({
    database: retry,
    claim,
    outcome: { status: "failed", statusCode: 503 },
    now: new Date("2026-08-14T23:45:10.000Z"),
  });
  assert.equal(retry.calls[2].values[4], "failed");
  assert.equal(retry.calls[2].values[5], "2026-08-14T23:45:15.000Z");
});

test("sends only the minimal notification with VAPID and bounded delivery options", async () => {
  let sent;
  const outcome = await sendClaimedWebPush({
    claim,
    vapid: { subject: "mailto:ops@example.com", publicKey: "x", privateKey: "y" },
    send: async (...args) => {
      sent = args;
      return { statusCode: 201, headers: {}, body: "" };
    },
  });
  assert.deepEqual(outcome, { status: "delivered", statusCode: 201 });
  assert.deepEqual(JSON.parse(sent[1]), notification);
  assert.equal(sent[2].TTL, 300);
  assert.equal(sent[2].timeout, 10_000);
  assert.equal(sent[2].urgency, "high");
});
