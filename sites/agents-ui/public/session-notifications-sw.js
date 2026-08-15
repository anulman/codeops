self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const notificationKinds = new Set([
  "permission-needed",
  "validation-failed",
  "draft-pr-ready",
  "budget-exhausted",
  "session-failed",
  "session-idle",
  "session-complete",
]);

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    if (!event.data) return;
    const item = event.data.json();
    if (
      item?.version !== "codeops.session-push-notification/v1" ||
      typeof item.key !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.key) ||
      !notificationKinds.has(item.kind) ||
      typeof item.title !== "string" || item.title.length < 1 || item.title.length > 80 ||
      typeof item.body !== "string" || item.body.length < 1 || item.body.length > 160 ||
      typeof item.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.sessionId) ||
      !Number.isSafeInteger(item.generation) || item.generation < 1 ||
      !Number.isSafeInteger(item.eventCursor) || item.eventCursor < 1 ||
      item.url !== `/sessions/${encodeURIComponent(item.sessionId)}`
    ) return;
    await self.registration.showNotification(item.title, {
      body: item.body,
      icon: "/codeops-session-icon.svg",
      badge: "/codeops-session-icon.svg",
      tag: item.key,
      data: { url: item.url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = event.notification.data?.url;
  const destination = typeof route === "string" && /^\/sessions\/[A-Za-z0-9._~%:-]+$/.test(route)
    ? new URL(route, self.location.origin).href
    : self.location.origin;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.navigate(destination);
        return client.focus();
      }
    }
    return self.clients.openWindow(destination);
  })());
});
