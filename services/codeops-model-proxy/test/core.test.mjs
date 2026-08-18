import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createModelProxyRequestListener as createRawModelProxyRequestListener,
  MODEL_PROXY_UPSTREAM_TIMEOUT_MS,
  validateModelProxyToken,
} from "../src/core.mjs";
import { ModelBudgetExhaustedError } from "../src/model-budget-ledger.mjs";

const signingKey = "m".repeat(64);
const now = Date.parse("2026-08-09T17:00:00.000Z");

test("allows one high-reasoning provider request to use the Agent Job window", () => {
  assert.equal(MODEL_PROXY_UPSTREAM_TIMEOUT_MS, 60 * 60 * 1_000);
});

function testLedger() {
  const calls = [];
  return {
    calls,
    async reserve(input) {
      calls.push({ operation: "reserve", input });
      return {
        reservationId: input.reservationId,
        reservedOutputTokens: input.reservedOutputTokens,
        remainingProviderRequests: 199,
        remainingOutputTokens: 1_000_000 - input.reservedOutputTokens,
        budgetRevision: 2,
      };
    },
    async settle(input) {
      calls.push({ operation: "settle", input });
      return {
        reservationId: input.reservationId,
        state: input.state,
        chargedOutputTokens:
          input.state === "settled" ? input.provedOutputTokens : 0,
        remainingOutputTokens: 999_000,
        budgetRevision: 3,
      };
    },
  };
}

function createModelProxyRequestListener(input) {
  return createRawModelProxyRequestListener({
    modelBudgetLedger: input.modelBudgetLedger ?? testLedger(),
    ...input,
  });
}

function token(overrides = {}) {
  const issuedAt = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({
    aud: "codeops-model-proxy",
    sub: "run-159",
    budgetId: "run-159",
    generation: 1,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumRequests: 200,
    maximumOutputTokens: 32768,
    iat: issuedAt,
    exp: issuedAt + 75 * 60,
    ...overrides,
  })).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", signingKey)
    .update(`v1.${payload}`)
    .digest("base64url")}`;
}

function legacyToken(overrides = {}) {
  const issuedAt = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({
    aud: "codeops-model-proxy",
    sub: "legacy-run-159",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumRequests: 200,
    maximumOutputTokens: 32768,
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
    budgetId: "run-159",
    generation: 1,
    modelTokenId: `sha256:${createHash("sha256").update(token()).digest("hex")}`,
    expiresAt: Math.floor(now / 1_000) + 75 * 60,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumRequests: 200,
    maximumOutputTokens: 32768,
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

test("preserves bounded non-session authority without inventing a ledger owner", () => {
  assert.deepEqual(
    validateModelProxyToken({ token: legacyToken(), signingKey, now }),
    {
      runId: "legacy-run-159",
      budgetId: null,
      generation: null,
      modelTokenId: null,
      expiresAt: Math.floor(now / 1_000) + 75 * 60,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maximumRequests: 200,
      maximumOutputTokens: 32768,
    },
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
    parallel_tool_calls: false,
    store: false,
  });
  assert.equal((await new Response(calls[0].init.body).text()).includes(token()), false);
});

test("commits a reservation before fetch and settles proved JSON usage", async () => {
  const ledger = testLedger();
  const order = [];
  const reserve = ledger.reserve.bind(ledger);
  ledger.reserve = async (input) => {
    order.push("reserve");
    return reserve(input);
  };
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: ledger,
      fetch: async () => {
        order.push("fetch");
        return new Response(
          JSON.stringify({
            id: "resp_ledger_1",
            usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token({ maximumOutputTokens: 2_048 })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          max_output_tokens: 1_500,
        }),
      });
      assert.equal(response.status, 200);
      await response.json();
    },
  );
  assert.deepEqual(order, ["reserve", "fetch"]);
  assert.equal(ledger.calls[0].operation, "reserve");
  assert.equal(ledger.calls[0].input.sessionId, "run-159");
  assert.equal(ledger.calls[0].input.budgetId, "run-159");
  assert.equal(ledger.calls[0].input.generation, 1);
  assert.equal(ledger.calls[0].input.reservedOutputTokens, 1_500);
  assert.deepEqual(ledger.calls[1].input, {
    reservationId: ledger.calls[0].input.reservationId,
    state: "settled",
    providerRequestId: "resp_ledger_1",
    provedInputTokens: 120,
    provedOutputTokens: 80,
    provedTotalTokens: 200,
    failureClass: null,
  });
});

test("forwards SSE progress and commits usage before the terminal event", async () => {
  const ledger = testLedger();
  const progress = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n';
  const terminal = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream_1","usage":{"input_tokens":30,"output_tokens":20,"total_tokens":50}}}\n\n';
  const done = "data: [DONE]\n\n";
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: ledger,
      fetch: async () => new Response(`${progress}${terminal}${done}`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `${progress}${terminal}${done}`);
    },
  );
  assert.deepEqual(ledger.calls[1].input, {
    reservationId: ledger.calls[0].input.reservationId,
    state: "settled",
    providerRequestId: "resp_stream_1",
    provedInputTokens: 30,
    provedOutputTokens: 20,
    provedTotalTokens: 50,
    failureClass: null,
  });
});

test("charges the full stream reservation when terminal usage is missing", async () => {
  const ledger = testLedger();
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: ledger,
      fetch: async () => new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token({ maximumOutputTokens: 4_096 })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
    },
  );
  assert.equal(ledger.calls[0].input.reservedOutputTokens, 4_096);
  assert.equal(ledger.calls[1].input.state, "charged_unknown");
  assert.equal(ledger.calls[1].input.failureClass, "missing_terminal_usage");
});

test("charges the full reservation when a provider request times out", async () => {
  const ledger = testLedger();
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: ledger,
      fetch: async () => {
        throw new DOMException("provider request timed out", "TimeoutError");
      },
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token({ maximumOutputTokens: 4_096 })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          max_output_tokens: 4_096,
        }),
      });
      assert.equal(response.status, 502);
      await response.text();
    },
  );
  assert.equal(ledger.calls[0].input.reservedOutputTokens, 4_096);
  assert.equal(ledger.calls[1].input.state, "charged_unknown");
  assert.equal(ledger.calls[1].input.failureClass, "timeout");
});

test("charges the full reservation when a provider stream truncates", async () => {
  const ledger = testLedger();
  const progress = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: ledger,
      fetch: async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(progress));
            controller.error(new Error("provider stream reset"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token({ maximumOutputTokens: 4_096 })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
          stream: true,
          max_output_tokens: 4_096,
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
    },
  );
  assert.equal(ledger.calls[0].input.reservedOutputTokens, 4_096);
  assert.equal(ledger.calls[1].input.state, "charged_unknown");
  assert.equal(ledger.calls[1].input.failureClass, "truncated_stream");
});

test("releases output capacity only for a proved provider rejection", async () => {
  const rejectedLedger = testLedger();
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: rejectedLedger,
      fetch: async () => new Response('{"error":{"type":"invalid_request_error"}}', {
        status: 400,
        headers: { "Content-Type": "application/json", "request-id": "req_rejected_1" },
      }),
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "high" } }),
      });
      assert.equal(response.status, 400);
      await response.text();
    },
  );
  assert.equal(rejectedLedger.calls[1].input.state, "provider_rejected");
  assert.equal(rejectedLedger.calls[1].input.providerRequestId, "req_rejected_1");

  const failedLedger = testLedger();
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: failedLedger,
      fetch: async () => {
        throw new Error("connection reset");
      },
    }),
    async (origin) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "high" } }),
      });
      assert.equal(response.status, 502);
      await response.text();
    },
  );
  assert.equal(failedLedger.calls[1].input.state, "charged_unknown");
  assert.equal(failedLedger.calls[1].input.failureClass, "transport");
});

test("returns a stable budget error and makes zero provider calls", async () => {
  let providerCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      modelBudgetLedger: {
        async reserve() {
          throw new ModelBudgetExhaustedError("output_tokens");
        },
        async settle() {
          assert.fail("must not settle an uncommitted reservation");
        },
      },
      fetch: async () => {
        providerCalls += 1;
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
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
        }),
      });
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), {
        error: "model budget exhausted",
        limit: "output_tokens",
      });
    },
  );
  assert.equal(providerCalls, 0);
});

test("keeps non-session callers on the bounded legacy stop-loss path", async () => {
  let providerCalls = 0;
  const noLedger = {
    async reserve() {
      assert.fail("non-session authority must not reserve a session budget");
    },
    async settle() {
      assert.fail("non-session authority must not settle a session budget");
    },
  };
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      maxRequestsPerRun: 2,
      modelBudgetLedger: noLedger,
      fetch: async () => {
        providerCalls += 1;
        return new Response('{"id":"resp_legacy"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    async (origin) => {
      const request = () => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${legacyToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: "hello",
          reasoning: { effort: "high" },
        }),
      });
      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 429);
    },
  );
  assert.equal(providerCalls, 2);
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
        reasoning: { effort: "high", context: "all_turns" },
        stream: true,
        parallel_tool_calls: true,
        include: ["reasoning.encrypted_content"],
        client_metadata: {
          session_id: "session-runtime-local-only",
          turn_id: "turn-runtime-local-only",
        },
        prompt_cache_key: "session-runtime-local-only",
        tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
      });
      assert.equal(safe.status, 200);
      await safe.text();

      const rejected = [
        { previous_response_id: "resp_prior" },
        { conversation: "conv_1" },
        { background: false },
        { store: true },
        { tools: [{ type: "web_search" }] },
        { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] },
        { input: [{ type: "input_file", file_id: "file_1" }] },
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
  assert.equal(admitted[0].parallel_tool_calls, false);
  assert.equal(admitted[0].background, true);
  assert.equal("client_metadata" in admitted[0], false);
  assert.equal("prompt_cache_key" in admitted[0], false);
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

test("rejects model, output-token, and reasoning drift before reservation", async () => {
  let upstreamCalls = 0;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      fetch: async () => {
        upstreamCalls += 1;
        return new Response('{"id":"resp_budget"}\n', { status: 200 });
      },
    }),
    async (origin) => {
      const request = (body) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token({ maximumRequests: 2, maximumOutputTokens: 2048 })}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal((await request({ model: "foreign-model", input: "x", reasoning: { effort: "high" } })).status, 400);
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "high" }, max_output_tokens: 2049 })).status,
        400,
      );
      assert.equal(
        (await request({ model: "gpt-5.6-sol", input: "x", reasoning: { effort: "medium" } })).status,
        400,
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

test("cancels abandoned upstream work and promptly releases concurrency", async () => {
  const releases = [];
  const logs = [];
  let upstreamCalls = 0;
  let firstUpstreamAborted = false;
  await withProxy(
    createModelProxyRequestListener({
      openAiApiKey: "test-openai-key-never-exposed",
      signingKey,
      now: () => now,
      log: (entry) => logs.push(entry),
      fetch: async (_url, init) => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          await new Promise((resolve, reject) => {
            const abort = () => {
              firstUpstreamAborted = true;
              reject(init.signal.reason);
            };
            if (init.signal.aborted) abort();
            else init.signal.addEventListener("abort", abort, { once: true });
          });
        } else {
          await new Promise((resolve) => releases.push(resolve));
        }
        return new Response('{"id":"resp_after_cancel"}\n', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    async (origin) => {
      const request = (signal) => fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: '{"model":"gpt-5.6-sol","input":"cancel","reasoning":{"effort":"high"}}',
        signal,
      });
      const clientAbort = new AbortController();
      const abandoned = request(clientAbort.signal);
      while (upstreamCalls < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      clientAbort.abort();
      await assert.rejects(abandoned, { name: "AbortError" });
      while (!firstUpstreamAborted) await new Promise((resolve) => setTimeout(resolve, 5));

      const active = Array.from({ length: 8 }, () => request());
      await Promise.race([
        (async () => {
          while (upstreamCalls < 9) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("abandoned request did not release concurrency")),
          1_000,
        )),
      ]);
      for (const release of releases) release();
      const completed = await Promise.all(active);
      assert.deepEqual(completed.map((response) => response.status), Array(8).fill(200));
      for (const response of completed) await response.text();
    },
  );
  assert.equal(
    logs.some((entry) => entry.event === "model_proxy_downstream_cancel"),
    true,
  );
});
