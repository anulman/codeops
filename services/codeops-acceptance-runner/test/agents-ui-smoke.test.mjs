import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cloudflareAccessHeaders,
  parseAgentsUiBaseUrl,
  runAgentsUiSmoke,
} from "../src/agents-ui-smoke.mjs";

function fakeChromium({ overflow = false } = {}) {
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
                evaluate: async () => overflow,
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

test("reads a complete Cloudflare Access service token from files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codeops-access-"));
  try {
    const idPath = path.join(directory, "id");
    const secretPath = path.join(directory, "secret");
    await writeFile(idPath, "client-id\n");
    await writeFile(secretPath, "client-secret\n");
    assert.deepEqual(
      await cloudflareAccessHeaders({
        CODEOPS_ACCESS_CLIENT_ID_FILE: idPath,
        CODEOPS_ACCESS_CLIENT_SECRET_FILE: secretPath,
      }),
      {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
    );
    await assert.rejects(
      cloudflareAccessHeaders({ CODEOPS_ACCESS_CLIENT_ID_FILE: idPath }),
      /incomplete/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checks desktop and mobile fleet surfaces", async () => {
  const chromium = fakeChromium();
  const headers = { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" };
  await runAgentsUiSmoke({
    baseUrl: "http://codeops-agents-ui:3000",
    chromium,
    extraHTTPHeaders: headers,
  });
  assert.deepEqual(
    chromium.contexts.map(({ options }) => options.viewport),
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
  );
  for (const [index, context] of chromium.contexts.entries()) {
    assert.deepEqual(context.options.extraHTTPHeaders, headers);
    assert.equal(context.url, "http://codeops-agents-ui:3000/");
    assert.deepEqual(
      context.locators,
      index === 0
        ? [
            { role: "heading", name: "Agent Sessions" },
            { role: "navigation", name: "Agent sessions" },
          ]
        : [
            { role: "heading", name: "Sessions" },
            { role: "group", name: "Session filters" },
          ],
    );
    assert.equal(context.closed, true);
  }
  assert.equal(chromium.contexts.browserClosed, true);
});

test("fails closed on horizontal overflow", async () => {
  await assert.rejects(
    runAgentsUiSmoke({
      baseUrl: "http://codeops-agents-ui:3000",
      chromium: fakeChromium({ overflow: true }),
      extraHTTPHeaders: {},
    }),
    /horizontal overflow/,
  );
});
