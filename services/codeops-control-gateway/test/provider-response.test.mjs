import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "../dist/provider-response.js";

test("rejects an oversized Content-Length before reading and cancels the body", async () => {
  let pulled = false;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readProviderResponse({
      fetch: async () => new Response(body, {
        status: 200,
        headers: {
          "content-length": "6",
          "content-type": "application/json",
        },
      }),
      url: "https://api.github.com/example",
      maxBytes: 5,
      statuses: [200],
      mediaTypes: ["json"],
    }),
    /exceeds 5 bytes/,
  );
  assert.equal(pulled, false);
  assert.equal(cancelled, true);
});

test("cancels a chunked response immediately after the byte bound is crossed", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readProviderResponse({
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.github.com/example",
      maxBytes: 5,
      statuses: [200],
      mediaTypes: ["json"],
    }),
    /exceeds 5 bytes/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test("enforces timeout, status, media type, and UTF-8 boundaries", async () => {
  await assert.rejects(
    readProviderResponse({
      fetch: async (_url, init) => await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
      url: "https://api.github.com/example",
      maxBytes: 10,
      statuses: [200],
      mediaTypes: ["json"],
      timeoutMs: 5,
    }),
    /aborted|abort|timeout/i,
  );
  let nonCooperativeSignal;
  await assert.rejects(
    readProviderResponse({
      fetch: async (_url, init) => {
        nonCooperativeSignal = init.signal;
        return await new Promise(() => {});
      },
      url: "https://api.github.com/example",
      maxBytes: 10,
      statuses: [200],
      mediaTypes: ["json"],
      timeoutMs: 5,
    }),
    (error) => error?.name === "TimeoutError",
  );
  assert.equal(nonCooperativeSignal.aborted, true);
  await assert.rejects(
    readProviderResponse({
      fetch: async () => new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
      url: "https://api.github.com/example",
      maxBytes: 10,
      statuses: [200],
      mediaTypes: ["json"],
    }),
    /HTTP 404/,
  );
  await assert.rejects(
    readProviderResponse({
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      url: "https://api.github.com/example",
      maxBytes: 10,
      statuses: [200],
      mediaTypes: ["json"],
    }),
    /media type/,
  );
  assert.throws(
    () => decodeProviderResponseText(Uint8Array.from([0xc3, 0x28])),
    /valid UTF-8/,
  );
});

test("allows exactly one credential-free safe check-log redirect", async () => {
  const calls = [];
  const result = await readProviderResponse({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? new Response(null, {
          status: 302,
          headers: { location: "https://results.example.test/check.log" },
        })
        : new Response("complete", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
    },
    url: "https://api.github.com/check/logs",
    init: {
      headers: {
        Authorization: "Bearer provider-token",
        Cookie: "provider-cookie",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    maxBytes: 100,
    statuses: [200],
    mediaTypes: ["text"],
    allowGitHubCheckLogRedirect: true,
  });
  assert.equal(decodeProviderResponseText(result.bytes), "complete");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.headers, undefined);

  for (const location of [
    "http://results.example.test/log",
    "https://user:pass@results.example.test/log",
    "https://results.example.test/log#fragment",
  ]) {
    await assert.rejects(
      readProviderResponse({
        fetch: async () => new Response(null, {
          status: 302,
          headers: { location },
        }),
        url: "https://api.github.com/check/logs",
        maxBytes: 100,
        statuses: [200],
        mediaTypes: ["text"],
        allowGitHubCheckLogRedirect: true,
      }),
      /unsafe/,
    );
  }
});
