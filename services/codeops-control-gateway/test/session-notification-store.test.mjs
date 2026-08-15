import assert from "node:assert/strict";
import test from "node:test";

import {
  registerWebPushSubscription,
  revokeWebPushSubscription,
  WebPushSubscriptionConflictError,
} from "../dist/session-notification-store.js";

const subscription = {
  version: "codeops.web-push-subscription/v1",
  deviceId: "5f132af3-8ec2-47a8-87c3-4b3a1e44b530",
  endpoint: "https://web.push.apple.com/QH2-example",
  expirationTime: null,
  keys: { auth: "a".repeat(22), p256dh: "b".repeat(87) },
};

function database(handler = async (_text, values) => ({
  rowCount: 1,
  rows: [{ subscription_id: `sha256:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(`${values[1]}\0${values[2]}`).digest("hex"))}` }],
})) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return handler(text, values);
    },
  };
}

test("upserts one principal and device bound subscription without returning its endpoint", async () => {
  const store = database();
  const result = await registerWebPushSubscription({
    database: store,
    principalId: "codeops:agents-ui",
    subscription,
    now: "2026-08-14T23:30:00.000Z",
  });
  assert.equal(result.status, "active");
  assert.equal(result.deviceId, subscription.deviceId);
  assert.match(result.subscriptionId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes(subscription.endpoint), false);
  assert.match(store.calls[0].text, /ON CONFLICT \(subscription_id\)/);
  assert.deepEqual(store.calls[0].values.slice(1, 5), [
    "codeops:agents-ui",
    subscription.deviceId,
    `sha256:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(subscription.endpoint).digest("hex"))}`,
    subscription.endpoint,
  ]);
});

test("maps endpoint uniqueness to one stable binding conflict", async () => {
  const store = database(async () => {
    const error = new Error("duplicate endpoint");
    error.code = "23505";
    throw error;
  });
  await assert.rejects(
    registerWebPushSubscription({
      database: store,
      principalId: "codeops:agents-ui",
      subscription,
    }),
    WebPushSubscriptionConflictError,
  );
});

test("revokes only the exact principal, device, and endpoint binding", async () => {
  const store = database(async (_text, values) => ({
    rowCount: 1,
    rows: [{ subscription_id: values[0] }],
  }));
  const result = await revokeWebPushSubscription({
    database: store,
    principalId: "codeops:agents-ui",
    subscription,
    now: "2026-08-14T23:31:00.000Z",
  });
  assert.equal(result.status, "revoked");
  assert.deepEqual(store.calls[0].values.slice(1, 3), [
    "codeops:agents-ui",
    subscription.deviceId,
  ]);

  await assert.rejects(
    revokeWebPushSubscription({
      database: database(async () => ({ rowCount: 0, rows: [] })),
      principalId: "codeops:agents-ui",
      subscription,
    }),
    WebPushSubscriptionConflictError,
  );
});
