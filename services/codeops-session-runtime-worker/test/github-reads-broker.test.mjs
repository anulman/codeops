import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadsBroker } from "../dist/github-reads-broker.js";

const dispatch = {
  dispatchId: "11111111-1111-4111-8111-111111111111",
  command: { type: "prompt" },
};

test("binds one repository-scoped read to the active prompt without permission", async () => {
  const broker = new GitHubReadsBroker();
  const port = await broker.listen(0);
  const calls = [];
  try {
    await broker.run(dispatch, {
      async requestPermission() { throw new Error("unexpected permission"); },
      async readGitHub(input) {
        calls.push(input);
        return {
          version: "codeops.github-search-result/v1",
          repository: "anulman/codeops",
          kind: "issues",
          query: "runtime",
          items: [],
          truncated: false,
        };
      },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/github/search`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          repository: "anulman/codeops",
          kind: "issues",
          query: "runtime",
          limit: 5,
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).version, "codeops.github-search-result/v1");
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, {
      repository: "anulman/codeops",
      kind: "issues",
      query: "runtime",
      limit: 5,
    });
    assert.equal(calls[0].operation, "search");
    assert.match(calls[0].operationId, /^githubread-[0-9a-f]{64}$/);
  } finally {
    await broker.close();
  }
});

test("fails closed without an active prompt or for invalid read input", async () => {
  const broker = new GitHubReadsBroker();
  const port = await broker.listen(0);
  try {
    const inactive = await fetch(`http://127.0.0.1:${port}/v1/github/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "anulman/codeops", headSha: "a".repeat(40) }),
    });
    assert.equal(inactive.status, 409);

    let readCalls = 0;
    await broker.run(dispatch, {
      async readGitHub() { readCalls += 1; throw new Error("unexpected"); },
    }, async () => {
      const invalid = await fetch(`http://127.0.0.1:${port}/v1/github/checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository: "other/repository", headSha: "not-a-sha" }),
      });
      assert.equal(invalid.status, 503);
    });
    assert.equal(readCalls, 0);
  } finally {
    await broker.close();
  }
});

test("rejects non-JSON and unknown routes before invoking the provider", async () => {
  const broker = new GitHubReadsBroker();
  const port = await broker.listen(0);
  try {
    await broker.run(dispatch, {
      async readGitHub() { throw new Error("unexpected"); },
    }, async () => {
      const media = await fetch(`http://127.0.0.1:${port}/v1/github/search`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(media.status, 415);
      const unknown = await fetch(`http://127.0.0.1:${port}/v1/github/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(unknown.status, 404);
    });
  } finally {
    await broker.close();
  }
});
