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
  const browser = await (input.chromium ?? chromium).launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    for (const target of [
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
        viewport: { width: 390, height: 844 },
        locators: [
          { role: "heading", name: "Sessions" },
          { role: "group", name: "Session filters" },
        ],
      },
    ]) {
      const context = await browser.newContext({
        viewport: target.viewport,
        extraHTTPHeaders: input.extraHTTPHeaders,
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(baseUrl.href, {
          waitUntil: "networkidle",
          timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
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
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        if (overflow) {
          throw new Error(`${target.name} agents UI has horizontal overflow`);
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
