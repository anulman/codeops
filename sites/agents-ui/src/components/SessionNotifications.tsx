import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@codeops/codeops-contracts/session-broker";
import { getSessionFleet } from "@/lib/sessionBroker.data";
import {
  sessionNotificationForTransition,
  type SessionNotification,
} from "@/lib/sessionNotifications";

type PermissionState = NotificationPermission | "unsupported";

export function SessionNotifications({
  initialSessions,
}: Readonly<{ initialSessions: readonly SessionSnapshot[] }>) {
  const [permission, setPermission] = useState<PermissionState>("unsupported");

  useEffect(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    setPermission(Notification.permission);
    void navigator.serviceWorker.register("/session-notifications-sw.js", {
      scope: "/",
    });
  }, []);

  useEffect(() => {
    if (permission !== "granted") return;
    let cancelled = false;
    let previous = new Map(
      initialSessions.map((session) => [session.sessionId, session]),
    );
    const poll = async () => {
      try {
        const current = await getSessionFleet();
        if (cancelled) return;
        const next = new Map(current.map((session) => [session.sessionId, session]));
        if (document.visibilityState !== "visible") {
          for (const session of current) {
            const item = sessionNotificationForTransition(
              previous.get(session.sessionId) ?? null,
              session,
            );
            if (item) await showSessionNotification(item);
          }
        }
        previous = next;
      } catch {
        // The live broker indicator owns connectivity status. Notification polling
        // must never interrupt the operator surface.
      }
    };
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [initialSessions, permission]);

  if (permission === "unsupported" || permission === "granted") return null;
  return (
    <button
      type="button"
      disabled={permission === "denied"}
      onClick={async () => {
        const result = await Notification.requestPermission();
        setPermission(result);
      }}
      className="fixed bottom-3 right-3 z-20 rounded-md border border-white/[0.1] bg-[#171719] px-2 py-1 text-[10px] text-white/48 shadow-lg transition hover:border-white/[0.18] hover:text-white/75 disabled:cursor-not-allowed disabled:text-white/28 lg:bottom-2.5 lg:left-32 lg:right-auto lg:z-3 lg:shadow-none"
    >
      {permission === "denied" ? "Notifications blocked" : "Enable notifications"}
    </button>
  );
}

async function showSessionNotification(
  notification: SessionNotification,
): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(notification.title, {
    body: notification.body,
    icon: "/codeops-session-icon.svg",
    badge: "/codeops-session-icon.svg",
    tag: notification.key,
    data: { url: notification.url },
  });
}
