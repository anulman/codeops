#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CREDENTIAL_BYTES = 4_096;

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

async function readCredential(path, purpose) {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) {
    throw new Error(`${purpose} credential size is invalid`);
  }
  const value = bytes.toString("utf8").trim();
  if (value === "" || value.includes("\n")) {
    throw new Error(`${purpose} credential format is invalid`);
  }
  return value;
}

export async function cloudflareAccessHeaders(input = process.env) {
  const idPath = input.CODEOPS_ACCESS_CLIENT_ID_FILE?.trim();
  const secretPath = input.CODEOPS_ACCESS_CLIENT_SECRET_FILE?.trim();
  if (!idPath && !secretPath) return {};
  if (!idPath || !secretPath) {
    throw new Error("Cloudflare Access service-token configuration is incomplete");
  }
  const [id, secret] = await Promise.all([
    readCredential(idPath, "Cloudflare Access client ID"),
    readCredential(secretPath, "Cloudflare Access client secret"),
  ]);
  if (id === secret) {
    throw new Error("Cloudflare Access credentials must be distinct");
  }
  return {
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
  };
}

export async function runAgentsUiSmoke(input = {}) {
  const baseUrl = parseAgentsUiBaseUrl(
    input.baseUrl ?? process.env.CODEOPS_AGENTS_UI_BASE_URL ?? "",
  );
  const extraHTTPHeaders =
    input.extraHTTPHeaders ?? (await cloudflareAccessHeaders());
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
        extraHTTPHeaders,
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
