import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionPushNotificationSchema,
  webPushConfigurationSchema,
  webPushSubscriptionSchema,
} from "../dist/session-notification.js";

const subscription = {
  version: "codeops.web-push-subscription/v1",
  deviceId: "5f132af3-8ec2-47a8-87c3-4b3a1e44b530",
  endpoint: "https://web.push.apple.com/QH2-example",
  expirationTime: null,
  keys: {
    auth: "a".repeat(22),
    p256dh: "b".repeat(87),
  },
};

test("binds one credential-free HTTPS Web Push subscription to one device", () => {
  assert.deepEqual(webPushSubscriptionSchema.parse(subscription), subscription);
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/example",
    "https://updates.push.services.mozilla.com/wpush/v2/example",
  ]) {
    assert.equal(webPushSubscriptionSchema.parse({ ...subscription, endpoint }).endpoint, endpoint);
  }
  for (const endpoint of [
    "http://web.push.apple.com/example",
    "https://user:secret@web.push.apple.com/example",
    "https://web.push.apple.com/example#fragment",
    "https://kubernetes.default.svc/api/v1/secrets",
    "https://push.attacker.example/collect",
  ]) {
    assert.throws(() => webPushSubscriptionSchema.parse({ ...subscription, endpoint }));
  }
  assert.throws(() => webPushSubscriptionSchema.parse({
    ...subscription,
    keys: { ...subscription.keys, extra: "secret" },
  }));
});

test("requires one VAPID public key exactly when Web Push is enabled", () => {
  assert.deepEqual(webPushConfigurationSchema.parse({
    version: "codeops.web-push-configuration/v1",
    enabled: true,
    publicKey: "a".repeat(87),
  }).enabled, true);
  assert.throws(() => webPushConfigurationSchema.parse({
    version: "codeops.web-push-configuration/v1",
    enabled: true,
    publicKey: null,
  }));
});

test("keeps a push payload bounded and bound to one exact session route", () => {
  const notification = {
    version: "codeops.session-push-notification/v1",
    key: `sha256:${"a".repeat(64)}`,
    kind: "permission-needed",
    sessionId: "ses_1234",
    generation: 2,
    eventCursor: 19,
    title: "CodeOps session needs permission",
    body: "Open the authorized session to approve or deny the operation.",
    url: "/sessions/ses_1234",
  };
  assert.deepEqual(sessionPushNotificationSchema.parse(notification), notification);
  assert.throws(() => sessionPushNotificationSchema.parse({
    ...notification,
    url: "/sessions/another-session",
  }));
  assert.throws(() => sessionPushNotificationSchema.parse({
    ...notification,
    prompt: "private prompt",
  }));
});
