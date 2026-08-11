import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createModelProxyRequestListener,
  validateModelProxyToken,
} from "../src/core.mjs";

const signingKey = "m".repeat(64);
const now = Date.parse("2026-08-09T17:00:00.000Z");

function token(overrides = {}) {
  const issuedAt = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({
    aud: "codeops-model-proxy",
    sub: "run-159",
    iat: issuedAt,
    exp: issuedAt + 75 * 60,
    ...overrides,
  })).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", signingKey)
    .update(`v1.${payload}`)
    .digest("base64url")}`;
}

test("accepts only an exact signed, bounded, unexpired run token", () => {
  assert.deepEqual(validateModelProxyToken({ token: token(), signingKey, now }), {
    runId: "run-159",
    expiresAt: Math.floor(now / 1_000) + 75 * 60,
  });
  assert.equal(
    validateModelProxyToken({ token: `${token()}x`, signingKey, now }),
    null,
  );
  assert.equal(
    validateModelProxyToken({ token: token({ exp: Math.floor(now / 1_000) }), signingKey, now }),
    null,
  );
  assert.equal(
    validateModelProxyToken({
      token: token({ exp: Math.floor(now / 1_000) + 75 * 60 + 1 }),
      signingKey,
      now,
    }),
    null,
  );
});

test("accepts a signed Agent Session identifier as the short-lived subject", () => {
  assert.equal(
    validateModelProxyToken({
      token: token({ sub: "ses_agents_control_plane_1" }),
      signingKey,
      now,
    })?.runId,
    "ses_agents_control_plane_1",
  );
});

async function withProxy(listener, run) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("replaces the run token with the real key only for the Responses API", async () => {
  const calls = [];
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response('{"id":"resp_1"}\n', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: '{"model":"gpt-5.6-sol","input":"hello"}',
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, "resp_1");
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(
    calls[0].init.headers.get("Authorization"),
    "Bearer test-openai-key-never-exposed",
  );
  assert.equal((await new Response(calls[0].init.body).text()).includes(token()), false);
});

test("does not contact OpenAI for invalid authority or unsupported paths", async () => {
  let calls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      fetch: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    }),
    async (origin) => {
      const unauthorized = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(unauthorized.status, 401);
      const unsupported = await fetch(`${origin}/v1/models`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      assert.equal(unsupported.status, 404);
    },
  );
  assert.equal(calls, 0);
});

test("warns on large permitted requests without logging request bodies", async () => {
  const logs = [];
  const body = JSON.stringify({ input: "x".repeat(4 * 1024 * 1024) });
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      log: (entry) => logs.push(entry),
      fetch: async () => new Response('{"id":"resp_large"}\n', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body,
      });
      assert.equal(response.status, 200);
      await response.text();
    },
  );
  assert.equal(logs.some((entry) => entry.event === "model_proxy_body_warning"), true);
  assert.equal(logs.some((entry) => entry.event === "model_proxy_request" && entry.status === 200), true);
  assert.equal(JSON.stringify(logs).includes("xxxxxxxx"), false);
});

test("rejects a request above the 20 MiB stop-loss before OpenAI", async () => {
  const logs = [];
  let upstreamCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      log: (entry) => logs.push(entry),
      fetch: async () => {
        upstreamCalls += 1;
        throw new Error("must not contact OpenAI");
      },
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20),
      });
      assert.equal(response.status, 413);
    },
  );
  assert.equal(upstreamCalls, 0);
  assert.equal(logs.some((entry) => entry.event === "model_proxy_request" && entry.status === 413), true);
});

test("uses a high per-token concurrency stop-loss and releases capacity", async () => {
  const releases = [];
  const logs = [];
  let upstreamCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      log: (entry) => logs.push(entry),
      fetch: async () => {
        upstreamCalls += 1;
        await new Promise((resolve) => releases.push(resolve));
        return new Response('{"id":"resp_concurrent"}\n', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    async (origin) => {
      const request = () => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: '{"input":"concurrent"}',
      });
      const active = Array.from({ length: 8 }, () => request());
      while (upstreamCalls < 8) await new Promise((resolve) => setTimeout(resolve, 5));
      const rejected = await request();
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get("retry-after"), "5");
      for (const release of releases) release();
      const completed = await Promise.all(active);
      assert.deepEqual(completed.map((response) => response.status), Array(8).fill(200));
      for (const response of completed) await response.text();
      const afterRelease = request();
      while (upstreamCalls < 9) await new Promise((resolve) => setTimeout(resolve, 5));
      releases.at(-1)();
      assert.equal((await afterRelease).status, 200);
    },
  );
  assert.equal(logs.some((entry) => entry.event === "model_proxy_limit_warning"), true);
  assert.equal(logs.some((entry) => entry.event === "model_proxy_stop_loss"), true);
});
