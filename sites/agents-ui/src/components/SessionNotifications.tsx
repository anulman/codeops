import { sx } from "@/styles/sx";
import { useEffect, useState } from "react";
import type {
  WebPushConfiguration,
  WebPushSubscription,
} from "@codeops/codeops-contracts/session-notification";
import {
  getWebPushConfiguration,
  registerWebPushSubscription,
  revokeWebPushSubscription,
} from "@/lib/sessionBroker.data";

const DISMISS_KEY = "codeops:web-push-dismissed-at";
const DEVICE_KEY = "codeops:web-push-device-id";
const DISMISS_MS = 7 * 24 * 60 * 60 * 1_000;

type PromptState = "hidden" | "install" | "enable" | "enabling";

function isInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { readonly standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function deviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return existing;
  }
  const created = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const decoded = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function wireSubscription(
  subscription: PushSubscription,
): WebPushSubscription {
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.auth || !serialized.keys.p256dh) {
    throw new Error("Push subscription is incomplete");
  }
  return {
    version: "codeops.web-push-subscription/v1",
    deviceId: deviceId(),
    endpoint: serialized.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      auth: serialized.keys.auth,
      p256dh: serialized.keys.p256dh,
    },
  };
}

async function ensureSubscription(
  registration: ServiceWorkerRegistration,
  configuration: WebPushConfiguration,
): Promise<void> {
  if (!configuration.enabled || configuration.publicKey === null) return;
  const expectedKey = applicationServerKey(configuration.publicKey);
  let existing = await registration.pushManager.getSubscription();
  if (existing !== null) {
    const currentKey = existing.options.applicationServerKey === null
      ? null
      : new Uint8Array(existing.options.applicationServerKey);
    if (
      currentKey === null ||
      currentKey.length !== expectedKey.length ||
      currentKey.some((value, index) => value !== expectedKey[index])
    ) {
      await revokeWebPushSubscription({ data: wireSubscription(existing) }).catch(() => undefined);
      await existing.unsubscribe();
      existing = null;
    }
  }
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: expectedKey,
  });
  await registerWebPushSubscription({ data: wireSubscription(subscription) });
}

export function SessionNotifications() {
  const [state, setState] = useState<PromptState>("hidden");
  const [configuration, setConfiguration] = useState<WebPushConfiguration | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (
        !("Notification" in window) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      ) return;
      const [nextRegistration, nextConfiguration] = await Promise.all([
        navigator.serviceWorker.register("/session-notifications-sw.js", { scope: "/" }),
        getWebPushConfiguration(),
      ]);
      if (cancelled || !nextConfiguration.enabled) return;
      setConfiguration(nextConfiguration);
      setRegistration(nextRegistration);
      if (Notification.permission === "denied") return;
      if (Notification.permission === "granted") {
        await ensureSubscription(nextRegistration, nextConfiguration);
        return;
      }
      const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? "0");
      if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_MS) return;
      setState(isIOS() && !isInstalled() ? "install" : "enable");
    })().catch(() => {
      // Notifications are optional. Broker connectivity remains visible in the app.
    });
    return () => { cancelled = true; };
  }, []);

  if (state === "hidden") return null;
  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setState("hidden");
  };
  return (
    <aside {...sx("fixed bottom-3 right-3 z-20 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-white/[0.1] bg-[#171719] p-3 shadow-xl lg:bottom-3 lg:left-32 lg:right-auto")}>
      <p {...sx("text-[11px] font-semibold text-white/78")}>
        {state === "install" ? "Install CodeOps for notifications" : "Get session notifications"}
      </p>
      <p {...sx("mt-1 text-[10px] leading-4 text-white/42")}>
        {state === "install"
          ? "On iPhone or iPad, use Share → Add to Home Screen. Then open the installed app to enable notifications."
          : "Get permission requests, failures, completed work, idle checkpoints, and budget limits while this app is suspended."}
      </p>
      <div {...sx("mt-2 flex justify-end gap-2")}>
        <button type="button" onClick={dismiss} {...sx("rounded-md px-2 py-1 text-[10px] text-white/38 hover:text-white/68")}>
          Not now
        </button>
        {state !== "install" ? (
          <button
            type="button"
            disabled={state === "enabling"}
            onClick={async () => {
              if (registration === null || configuration === null) return;
              setState("enabling");
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") return;
                await ensureSubscription(registration, configuration);
              } finally {
                setState("hidden");
              }
            }}
            {...sx("rounded-md bg-[#6d6af7] px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-[#7c79ff] disabled:opacity-45")}
          >
            {state === "enabling" ? "Enabling…" : "Enable notifications"}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
