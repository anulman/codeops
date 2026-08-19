#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const DEFAULT_TIMEOUT_MS = 30_000;

export function parseAgentsUiBaseUrl(value) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ((url.hostname === "codeops-agents-ui" && url.port === "3000") ||
      ((url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        url.port !== ""));
  const externalHttps = url.protocol === "https:" && url.port === "";
  if (
    (!localHttp && !externalHttps) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "agents UI smoke target must be one exact HTTPS origin or the bounded local Service origin",
    );
  }
  return url;
}

export async function runAgentsUiSmoke(input = {}) {
  const baseUrl = parseAgentsUiBaseUrl(
    input.baseUrl ?? process.env.CODEOPS_AGENTS_UI_BASE_URL ?? "",
  );
  const fetcher = input.fetch ?? fetch;
  for (const asset of [
    { path: "/manifest.webmanifest", pattern: /"display"\s*:\s*"standalone"/ },
    { path: "/session-notifications-sw.js", pattern: /addEventListener\("push"/ },
  ]) {
    const response = await fetcher(new URL(asset.path, baseUrl), {
      headers: input.extraHTTPHeaders,
      redirect: "error",
    });
    const body = await response.text();
    if (response.status !== 200 || !asset.pattern.test(body)) {
      throw new Error(
        `agents UI static asset ${asset.path} is unavailable or invalid`,
      );
    }
  }
  const browser = await (input.chromium ?? chromium).launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    const targets = [
      {
        name: "desktop",
        viewport: { width: 1440, height: 1000 },
        locators: [
          { role: "heading", name: "Agent Sessions" },
          { role: "navigation", name: "Agent sessions" },
        ],
      },
      {
        name: "mobile",
        path: "/",
        viewport: { width: 390, height: 844 },
        locators: [
          { role: "heading", name: "Sessions" },
          { role: "group", name: "Session filters" },
        ],
      },
      {
        name: "new-session",
        path: "/new",
        viewport: { width: 1440, height: 1000 },
        locators: [
          { role: "heading", name: "New session" },
          { role: "button", name: "Create session" },
        ],
        typography: [
          {
            selector: '[data-codeops-typography="launch-policy-description"]',
            fontSize: 11,
            lineHeight: 16,
          },
        ],
      },
    ];
    if (input.sessionId) {
      targets.push({
        name: "session-cockpit",
        path: `/sessions/${encodeURIComponent(input.sessionId)}`,
        viewport: { width: 1440, height: 1000 },
        locators: [
          { role: "heading", name: "Legacy workspace" },
          { role: "group", name: "Session actions" },
          { role: "button", name: "Cancel" },
        ],
        typography: [
          {
            selector: '[data-codeops-typography="protocol-diagnostics"]',
            fontSize: 9,
            lineHeight: 12,
          },
        ],
      });
    }
    for (const target of targets) {
      const context = await browser.newContext({
        viewport: target.viewport,
        extraHTTPHeaders: input.extraHTTPHeaders,
      });
      try {
        const page = await context.newPage();
        if (target.name === "desktop" && input.verifyNotificationGesture) {
          await page.addInitScript(() => {
            const subscription = {
              endpoint: "https://fcm.googleapis.com/fcm/send/codeops-browser-proof",
              expirationTime: null,
              options: { applicationServerKey: null },
              toJSON: () => ({
                endpoint: "https://fcm.googleapis.com/fcm/send/codeops-browser-proof",
                expirationTime: null,
                keys: {
                  auth: "abcdefghijklmnop",
                  p256dh: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
                },
              }),
            };
            class ProofPushManager {
              async getSubscription() { return null; }
              subscribe() {
                globalThis.__codeopsPushSubscriptionGesture = {
                  active: navigator.userActivation.isActive,
                  hasBeenActive: navigator.userActivation.hasBeenActive,
                };
                return Promise.resolve(subscription);
              }
            }
            const pushManager = new ProofPushManager();
            Object.defineProperty(globalThis, "PushManager", {
              configurable: true,
              value: ProofPushManager,
            });
            Object.defineProperty(globalThis, "Notification", {
              configurable: true,
              value: { permission: "default" },
            });
            Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
              configurable: true,
              get: () => pushManager,
            });
          });
        }
        const response = await page.goto(
          new URL(target.path ?? "/", baseUrl).href,
          {
            waitUntil: "networkidle",
            timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
        );
        if (response?.status() !== 200) {
          throw new Error(
            `${target.name} agents UI returned ${response?.status() ?? "no response"}`,
          );
        }
        for (const locator of target.locators) {
          await page
            .getByRole(locator.role, { name: locator.name })
            .waitFor({ state: "visible", timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        }
        if (target.name === "desktop" && input.verifyNotificationGesture) {
          const enable = page.getByRole("button", { name: "Enable notifications" });
          await enable.waitFor({
            state: "visible",
            timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          });
          await enable.click();
          await page.getByText("Notifications are enabled", { exact: true }).waitFor({
            state: "visible",
            timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          });
          const gesture = await page.evaluate(
            () => globalThis.__codeopsPushSubscriptionGesture ?? null,
          );
          if (gesture?.active !== true || gesture.hasBeenActive !== true) {
            throw new Error(
              `desktop Web Push subscription lost user activation: ${JSON.stringify(gesture)}`,
            );
          }
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        if (overflow) {
          throw new Error(`${target.name} agents UI has horizontal overflow`);
        }
        for (const sample of target.typography ?? []) {
          const computed = await page.evaluate(({ selector }) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return null;
            const style = window.getComputedStyle(element);
            return {
              fontSize: Number.parseFloat(style.fontSize),
              lineHeight: Number.parseFloat(style.lineHeight),
            };
          }, sample);
          if (
            computed === null ||
            computed.fontSize !== sample.fontSize ||
            computed.lineHeight !== sample.lineHeight
          ) {
            throw new Error(
              `${target.name} agents UI typography drift at ${sample.selector}: expected ${sample.fontSize}/${sample.lineHeight}px, received ${computed === null ? "missing" : `${computed.fontSize}/${computed.lineHeight}px`}`,
            );
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runAgentsUiSmoke();
  process.stdout.write(
    `${JSON.stringify({ status: "passed", target: parseAgentsUiBaseUrl(process.env.CODEOPS_AGENTS_UI_BASE_URL ?? "").origin })}\n`,
  );
}
