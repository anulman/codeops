import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("../src/lib/sessionNotifications.ts", import.meta.url);

test("limits browser notifications to actionable session transitions", async () => {
  const source = await readFile(moduleUrl, "utf8");
  for (const state of ["waiting_permission", "failed", "completed", "hibernated"]) {
    assert.match(source, new RegExp(`current\\.state === \\\"${state}\\\"`));
  }
  assert.match(source, /budget\.exhaustedLimit/);
  assert.match(source, /previous\?\.state === current\.state/);
  assert.doesNotMatch(source, /current\.state === "running"/);
  assert.doesNotMatch(source, /current\.state === "queued"/);
  assert.doesNotMatch(source, /current\.state === "checkpointing"/);
});

test("ships one installable manifest and one notification click route", async () => {
  const [root, manifestSource, worker, component] = await Promise.all([
    readFile(new URL("../src/routes/__root.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/session-notifications-sw.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SessionNotifications.tsx", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.match(root, /manifest\.webmanifest/);
  assert.match(component, /Notification\.requestPermission/);
  assert.match(component, /document\.visibilityState !== "visible"/);
  assert.match(component, /15_000/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /openWindow/);
});
