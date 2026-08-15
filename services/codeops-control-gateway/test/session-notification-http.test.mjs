import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidSessionNotificationRequestError,
  serveSessionNotifications,
} from "../dist/session-notification-http.js";
import { WebPushSubscriptionConflictError } from "../dist/session-notification-store.js";

const readToken = "r".repeat(32);
const writeToken = "w".repeat(32);
const subscription = {
  version: "codeops.web-push-subscription/v1",
  deviceId: "5f132af3-8ec2-47a8-87c3-4b3a1e44b530",
  endpoint: "https://web.push.apple.com/QH2-example",
  expirationTime: null,
  keys: { auth: "a".repeat(22), p256dh: "b".repeat(87) },
};
const active = {
  version: "codeops.web-push-subscription-result/v1",
  subscriptionId: `sha256:${"c".repeat(64)}`,
  deviceId: subscription.deviceId,
  status: "active",
};

function request(overrides = {}) {
  return serveSessionNotifications({
    method: "POST",
    url: "/v1/session-notifications/subscriptions",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
      "x-codeops-principal": "codeops:agents-ui",
    },
    readToken,
    writeToken,
    configuration: {
      version: "codeops.web-push-configuration/v1",
      enabled: true,
      publicKey: "p".repeat(87),
    },
    readBody: async () => subscription,
    register: async () => active,
    revoke: async () => ({ ...active, status: "revoked" }),
    ...overrides,
  });
}

test("uses separate read and write authority for configuration and subscriptions", async () => {
  const configuration = await request({
    method: "GET",
    url: "/v1/session-notifications/config",
    headers: { authorization: `Bearer ${readToken}` },
  });
  assert.equal(configuration.status, 200);
  assert.equal(configuration.body.publicKey, "p".repeat(87));
  assert.equal((await request({ headers: {} })).status, 401);
  assert.equal((await request({
    method: "GET",
    url: "/v1/session-notifications/config",
    headers: { authorization: `Bearer ${writeToken}` },
  })).status, 401);
});

test("binds registration and revocation to the authenticated principal", async () => {
  const calls = [];
  const registered = await request({
    register: async (body, principalId) => {
      calls.push({ action: "register", body, principalId });
      return active;
    },
  });
  assert.equal(registered.body.status, "active");
  const revoked = await request({
    method: "DELETE",
    revoke: async (body, principalId) => {
      calls.push({ action: "revoke", body, principalId });
      return { ...active, status: "revoked" };
    },
  });
  assert.equal(revoked.body.status, "revoked");
  assert.deepEqual(calls.map(({ action, principalId }) => ({ action, principalId })), [
    { action: "register", principalId: "codeops:agents-ui" },
    { action: "revoke", principalId: "codeops:agents-ui" },
  ]);
});

test("rejects malformed input before the store and hides binding details", async () => {
  await assert.rejects(
    request({ readBody: async () => ({ ...subscription, endpoint: "http://localhost" }) }),
    InvalidSessionNotificationRequestError,
  );
  await assert.rejects(
    request({
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/json",
      },
    }),
    /principal/,
  );
  assert.equal((await request({
    headers: {
      authorization: `Bearer ${writeToken}`,
      "x-codeops-principal": "codeops:agents-ui",
    },
  })).status, 415);
  assert.deepEqual(await request({
    register: async () => {
      throw new WebPushSubscriptionConflictError("private endpoint detail");
    },
  }), { status: 409, body: { status: "subscription-conflict" } });
  assert.equal(await request({ method: "GET", url: "/healthz" }), null);
  assert.deepEqual(await request({
    configuration: {
      version: "codeops.web-push-configuration/v1",
      enabled: false,
      publicKey: null,
    },
  }), { status: 503, body: { status: "notifications-disabled" } });
});
