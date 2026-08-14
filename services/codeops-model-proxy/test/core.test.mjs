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
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
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
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
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
          Authorization: `Bearer ${token({ model: "gpt-5.4-nano-2026-03-17", reasoningEffort: "none" })}`,
          "Content-Type": "application/json",
        },
        body: '{"model":"gpt-5.4-nano-2026-03-17","input":"hello","reasoning":{"effort":"none"}}',
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
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-5.4-nano-2026-03-17",
    input: "hello",
    reasoning: { effort: "none" },
    max_output_tokens: 32768,
    store: false,
  });
  assert.equal((await new Response(calls[0].init.body).text()).includes(token()), false);
});

test("enforces stateless Responses requests and rejects provider-hosted state", async () => {
  const admitted = [];
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      maxRequestsPerRun: 20,
      fetch: async (_url, init) => {
        admitted.push(JSON.parse(init.body));
        return new Response('{"id":"resp_private"}\n', { status: 200 });
      },
    }),
    async (origin) => {
      const request = (body) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const safe = await request({
        model: "gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: "Inspect this." }],
        reasoning: { effort: "high" },
        stream: true,
        include: ["reasoning.encrypted_content"],
        tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
      });
      assert.equal(safe.status, 200);
      await safe.text();

      const rejected = [
        { previous_response_id: "resp_prior" },
        { conversation: "conv_1" },
        { store: true },
        { tools: [{ type: "web_search" }] },
        { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] },
        { input: [{ type: "input_file", file_id: "file_1" }] },
        { prompt_cache_key: "stable-provider-state" },
        { metadata: { workItemBody: "private" } },
      ];
      for (const drift of rejected) {
        const response = await request({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          ...drift,
        });
        assert.equal(response.status, 400);
      }
    },
  );
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].store, false);
  assert.equal("previous_response_id" in admitted[0], false);
});

test("bounds admitted text and structured Responses inputs", async () => {
  let upstreamCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      maxRequestsPerRun: 5,
      fetch: async () => {
        upstreamCalls += 1;
        return new Response('{"id":"unexpected"}\n', { status: 200 });
      },
    }),
    async (origin) => {
      const request = (input) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input, reasoning: { effort: "high" } }),
      });
      assert.equal((await request("x".repeat(8 * 1024 * 1024 + 1))).status, 400);
      let nested = "leaf";
      for (let index = 0; index < 21; index += 1) nested = { nested };
      assert.equal((await request(nested)).status, 400);
    },
  );
  assert.equal(upstreamCalls, 0);
});

test("rejects model, output-token, and per-run request budget drift", async () => {
  let upstreamCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      maxRequestsPerRun: 2,
      fetch: async () => {
        upstreamCalls += 1;
        return new Response('{"id":"resp_budget"}\n', { status: 200 });
      },
    }),
    async (origin) => {
      const request = (body) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal((await request({ model: "foreign-model", input: "x", reasoning: { effort: "high" } })).status, 400);
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "high" }, max_output_tokens: 32769 })).status,
        400,
      );
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "medium" } })).status,
        429,
      );
    },
  );
  assert.equal(upstreamCalls, 0);
});

test("admits only the exact model and reasoning effort bound into the run token", async () => {
  const admitted = [];
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      maxRequestsPerRun: 10,
      fetch: async (_url, init) => {
        admitted.push(JSON.parse(init.body));
        return new Response('{"id":"resp_policy"}\n', { status: 200 });
      },
    }),
    async (origin) => {
      const request = (body) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "medium" } })).status,
        400,
      );
      assert.equal(
        (await request({ model: "gpt-5.4-nano-2026-03-17", input: "x", reasoning: { effort: "none" } })).status,
        400,
      );
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "high" } })).status,
        200,
      );
    },
  );
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].model, "gpt-5.6-sol");
  assert.equal(admitted[0].reasoning.effort, "high");
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
  const body = JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(4 * 1024 * 1024), reasoning: { effort: "high" } });
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
        body: '{"model":"gpt-5.6-sol","input":"concurrent","reasoning":{"effort":"high"}}',
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
