import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ships one installable manifest and one notification click route", async () => {
  const [root, manifestSource, worker, component, data] = await Promise.all([
    readFile(new URL("../src/routes/__root.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/session-notifications-sw.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SessionNotifications.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/sessionBroker.data.ts", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.match(root, /manifest\.webmanifest/);
  assert.doesNotMatch(component, /Notification\.requestPermission/);
  assert.match(component, /display-mode: standalone/);
  assert.match(component, /Add to Home Screen/);
  assert.match(component, /7 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(component, /Notification\.permission === "denied"/);
  assert.match(component, /aria-label="Notification settings"/);
  assert.match(component, /Notifications blocked/);
  assert.match(component, /Settings → Notifications → Agent Sessions/);
  assert.match(component, /removeItem\(DISMISS_KEY\)/);
  assert.match(component, /pushManager\.subscribe/);
  assert.match(component, /return navigator\.serviceWorker\.ready/);
  assert.match(component, /Web Push \$\{failure\.stage\} failed \(\$\{failure\.name\}\): \$\{failure\.message\}/);
  assert.match(data, /agents_ui_web_push_enable_failed/);
  assert.match(data, /codeops\.web-push-failure-diagnostic\/v1/);
  assert.doesNotMatch(component, /subscribeFromUserGesture/);
  assert.match(
    component,
    /onClick=\{\(\) => \{[\s\S]*subscriptionPromise = registration\.pushManager\.subscribe\([\s\S]*\)\.then\([\s\S]*setState\("enabling"\)/,
  );
  const gestureHandler = component.match(/onClick=\{\(\) => \{[\s\S]*?setState\("enabling"\)/)?.[0] ?? "";
  assert.doesNotMatch(gestureHandler, /\basync\b|\bawait\b/);
  assert.equal(data.match(/sessionNotificationClient\(\)/g)?.length, 3);
  assert.doesNotMatch(
    data,
    /sessionBrokerClient\(\)\.(getWebPushConfiguration|registerWebPushSubscription|revokeWebPushSubscription)/,
  );
  assert.doesNotMatch(component, /setInterval/);
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /showNotification/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /openWindow/);
});
