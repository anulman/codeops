import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentsUiBaseUrl,
  runAgentsUiSmoke,
} from "../src/agents-ui-smoke.mjs";

function fakeChromium({ overflow = false, typographyDrift = false } = {}) {
  const contexts = [];
  return {
    contexts,
    async launch(options) {
      assert.equal(options.headless, true);
      return {
        async newContext(contextOptions) {
          const record = { options: contextOptions, closed: false };
          contexts.push(record);
          return {
            async newPage() {
              return {
                async goto(url, options) {
                  record.url = url;
                  record.gotoOptions = options;
                  return { status: () => 200 };
                },
                getByRole(role, locatorOptions) {
                  record.locators ??= [];
                  record.locators.push({ role, ...locatorOptions });
                  return { waitFor: async () => undefined };
                },
                evaluate: async (_callback, sample) => {
                  if (sample === undefined) return overflow;
                  record.typography ??= [];
                  record.typography.push(sample);
                  return {
                    fontSize: sample.fontSize,
                    lineHeight: typographyDrift ? sample.lineHeight + 8 : sample.lineHeight,
                  };
                },
              };
            },
            async close() {
              record.closed = true;
            },
          };
        },
        async close() {
          contexts.browserClosed = true;
        },
      };
    },
  };
}

function fakeStaticAssets({ missingPath } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed.href, options });
    if (parsed.pathname === missingPath) {
      return { status: 404, text: async () => "not found" };
    }
    const body = parsed.pathname === "/manifest.webmanifest"
      ? '{"display":"standalone"}'
      : 'self.addEventListener("push", () => undefined);';
    return { status: 200, text: async () => body };
  };
  return { fetch, requests };
}

test("accepts only an exact external HTTPS or bounded local origin", () => {
  for (const valid of [
    "https://agents.codeops.example",
    "http://codeops-agents-ui:3000",
    "http://127.0.0.1:4176",
  ]) {
    assert.equal(parseAgentsUiBaseUrl(valid).pathname, "/");
  }
  for (const invalid of [
    "http://agents.codeops.example",
    "https://agents.codeops.example/path",
    "http://codeops-agents-ui",
    "http://example.com:3000",
    "https://user@agents.codeops.example",
  ]) {
    assert.throws(() => parseAgentsUiBaseUrl(invalid));
  }
});

test("checks fleet and new-session surfaces", async () => {
  const chromium = fakeChromium();
  const assets = fakeStaticAssets();
  await runAgentsUiSmoke({
    baseUrl: "http://codeops-agents-ui:3000",
    chromium,
    fetch: assets.fetch,
    sessionId: "ses_legacy_workspace_042",
  });
  assert.deepEqual(
    assets.requests.map(({ url }) => url),
    [
      "http://codeops-agents-ui:3000/manifest.webmanifest",
      "http://codeops-agents-ui:3000/session-notifications-sw.js",
    ],
  );
  assert.deepEqual(
    chromium.contexts.map(({ options }) => options.viewport),
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
      { width: 1440, height: 1000 },
      { width: 1440, height: 1000 },
    ],
  );
  for (const [index, context] of chromium.contexts.entries()) {
    assert.equal(context.options.extraHTTPHeaders, undefined);
    assert.equal(
      String(context.url),
      index === 2
        ? "http://codeops-agents-ui:3000/new"
        : index === 3
          ? "http://codeops-agents-ui:3000/sessions/ses_legacy_workspace_042"
          : "http://codeops-agents-ui:3000/",
    );
    assert.deepEqual(
      context.locators,
      index === 0
        ? [
            { role: "heading", name: "Agent Sessions" },
            { role: "navigation", name: "Agent sessions" },
          ]
        : index === 1
          ? [
              { role: "heading", name: "Sessions" },
              { role: "group", name: "Session filters" },
            ]
          : index === 2
            ? [
              { role: "heading", name: "New session" },
              { role: "button", name: "Create session" },
            ]
            : [
              { role: "heading", name: "Legacy workspace" },
              { role: "group", name: "Session actions" },
              { role: "button", name: "Cancel" },
            ],
    );
    assert.equal(context.closed, true);
    assert.deepEqual(
      context.typography ?? [],
      index === 2
        ? [{
          selector: '[data-codeops-typography="launch-policy-description"]',
          fontSize: 11,
          lineHeight: 16,
        }]
        : index === 3
        ? [{
          selector: '[data-codeops-typography="protocol-diagnostics"]',
          fontSize: 9,
          lineHeight: 12,
        }]
        : [],
    );
  }
  assert.equal(chromium.contexts.browserClosed, true);
});

test("fails closed on horizontal overflow", async () => {
  await assert.rejects(
    runAgentsUiSmoke({
      baseUrl: "http://codeops-agents-ui:3000",
      chromium: fakeChromium({ overflow: true }),
      fetch: fakeStaticAssets().fetch,
      extraHTTPHeaders: {},
    }),
    /horizontal overflow/,
  );
});

test("fails closed on dense typography drift", async () => {
  await assert.rejects(
    runAgentsUiSmoke({
      baseUrl: "http://codeops-agents-ui:3000",
      chromium: fakeChromium({ typographyDrift: true }),
      fetch: fakeStaticAssets().fetch,
      sessionId: "ses_legacy_workspace_042",
    }),
    /typography drift.*expected 11\/16px, received 11\/24px/,
  );
});

test("fails closed when the notification worker is missing", async () => {
  await assert.rejects(
    runAgentsUiSmoke({
      baseUrl: "http://codeops-agents-ui:3000",
      chromium: fakeChromium(),
      fetch: fakeStaticAssets({ missingPath: "/session-notifications-sw.js" }).fetch,
    }),
    /static asset \/session-notifications-sw\.js is unavailable or invalid/,
  );
});
