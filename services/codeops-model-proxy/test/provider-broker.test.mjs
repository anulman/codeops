import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProviderBroker,
  providerBrokerConstants,
} from "../src/provider-broker.mjs";

const now = Date.parse("2026-08-19T17:00:00.000Z");

function jwt(claims) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

async function authFile({ expired = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codeops-provider-broker-"));
  const file = join(directory, "auth.json");
  await writeFile(file, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "must-not-survive-refresh",
    tokens: {
      access_token: jwt({ exp: Math.floor(now / 1_000) + (expired ? -1 : 3_600) }),
      refresh_token: "refresh-one",
      account_id: "account-one",
      id_token: jwt({ chatgpt_account_id: "account-one" }),
    },
  }));
  return file;
}

function requestInit() {
  return {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      background: true,
      max_output_tokens: 32_768,
    })),
  };
}

test("uses ChatGPT without exposing OAuth material to the caller", async () => {
  const file = await authFile();
  const calls = [];
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: file,
    apiKey: "api-fallback",
    allowApiKeyFallback: true,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal((await broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, providerBrokerConstants.CHATGPT_RESPONSES_URL);
  assert.equal(calls[0].init.headers.get("Authorization").startsWith("Bearer "), true);
  assert.equal(calls[0].init.headers.get("ChatGPT-Account-ID"), "account-one");
  assert.equal(calls[0].init.headers.get("originator"), "codex_cli_rs");
  assert.notEqual(calls[0].init.headers.get("Authorization"), "Bearer api-fallback");
  assert.equal(JSON.parse(calls[0].init.body).background, undefined);
  assert.equal(JSON.parse(calls[0].init.body).max_output_tokens, undefined);
  assert.equal(JSON.stringify(calls).includes("refresh-one"), false);
  assert.equal(JSON.stringify(calls).includes("api-fallback"), false);
});

test("refreshes once, rotates the cache, and removes an API key", async () => {
  const file = await authFile({ expired: true });
  const refreshedAccess = jwt({ exp: Math.floor(now / 1_000) + 3_600 });
  const urls = [];
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: file,
    allowApiKeyFallback: false,
    now: () => now,
    fetch: async (url) => {
      urls.push(url);
      if (url === providerBrokerConstants.TOKEN_REFRESH_URL) {
        return new Response(JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: "refresh-two",
          id_token: jwt({ chatgpt_account_id: "account-one" }),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("ok", { status: 200 });
    },
  });
  await Promise.all([
    broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit()),
    broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit()),
  ]);
  assert.equal(urls.filter((url) => url === providerBrokerConstants.TOKEN_REFRESH_URL).length, 1);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.OPENAI_API_KEY, undefined);
  assert.equal(saved.tokens.access_token, refreshedAccess);
  assert.equal(saved.tokens.refresh_token, "refresh-two");
});

test("falls back only for explicit subscription rejection", async () => {
  const file = await authFile();
  const calls = [];
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: file,
    apiKey: "api-fallback",
    allowApiKeyFallback: true,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response("result", { status: calls.length === 1 ? 429 : 200 });
    },
  });
  assert.equal((await broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit())).status, 200);
  assert.deepEqual(calls.map(({ url }) => url), [
    providerBrokerConstants.CHATGPT_RESPONSES_URL,
    providerBrokerConstants.OPENAI_RESPONSES_URL,
  ]);
  assert.equal(calls[0].body.max_output_tokens, undefined);
  assert.equal(calls[1].body.max_output_tokens, 32_768);
});

test("keeps OAuth and API-key credentials on their respective routes", async () => {
  const file = await authFile();
  const calls = [];
  const logs = [];
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: file,
    apiKey: "api-fallback",
    allowApiKeyFallback: true,
    now: () => now,
    log: (event) => logs.push(event),
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.get("Authorization") });
      return new Response("result", { status: calls.length === 1 ? 403 : 200 });
    },
  });
  assert.equal((await broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit())).status, 200);
  assert.match(calls[0].authorization, /^Bearer (?!api-fallback$)/);
  assert.equal(calls[1].authorization, "Bearer api-fallback");
  assert.equal(JSON.stringify(logs).includes("api-fallback"), false);
  assert.equal(JSON.stringify(logs).includes("refresh-one"), false);
});

test("uses API fallback when subscription auth cannot be loaded before inference", async () => {
  const urls = [];
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: "/missing/auth.json",
    apiKey: "api-fallback",
    allowApiKeyFallback: true,
    now: () => now,
    fetch: async (url) => {
      urls.push(url);
      return new Response("result", { status: 200 });
    },
  });
  assert.equal((await broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit())).status, 200);
  assert.deepEqual(urls, [providerBrokerConstants.OPENAI_RESPONSES_URL]);
});

test("does not duplicate an ambiguous transport failure or server failure", async () => {
  for (const outcome of ["transport", "server"]) {
    const file = await authFile();
    const urls = [];
    const broker = createProviderBroker({
      primaryMode: "chatgpt-primary",
      chatGptAuthFile: file,
      apiKey: "api-fallback",
      allowApiKeyFallback: true,
      now: () => now,
      fetch: async (url) => {
        urls.push(url);
        if (outcome === "transport") throw new Error("connection reset");
        return new Response("server", { status: 503 });
      },
    });
    if (outcome === "transport") {
      await assert.rejects(
        broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit()),
      );
    } else {
      assert.equal(
        (await broker(providerBrokerConstants.OPENAI_RESPONSES_URL, requestInit())).status,
        503,
      );
    }
    assert.deepEqual(urls, [providerBrokerConstants.CHATGPT_RESPONSES_URL]);
  }
});

test("fails closed on invalid cross-field configuration", () => {
  assert.throws(
    () => createProviderBroker({ primaryMode: "chatgpt-primary" }),
    /requires an auth file/,
  );
  assert.throws(
    () => createProviderBroker({
      primaryMode: "chatgpt-primary",
      chatGptAuthFile: "/auth.json",
      allowApiKeyFallback: true,
    }),
    /fallback requires OPENAI_API_KEY/,
  );
});

test("rejects upstream URL drift before contacting either provider", async () => {
  const file = await authFile();
  let calls = 0;
  const broker = createProviderBroker({
    primaryMode: "chatgpt-primary",
    chatGptAuthFile: file,
    fetch: async () => {
      calls += 1;
      return new Response("unexpected", { status: 200 });
    },
  });
  await assert.rejects(
    broker("https://example.com/v1/responses", requestInit()),
    /unsupported upstream URL/,
  );
  assert.equal(calls, 0);
});
