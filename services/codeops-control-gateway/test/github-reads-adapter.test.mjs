import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReadAdapter } from "../dist/github-reads-adapter.js";

const headSha = "a".repeat(40);
const changedHeadSha = "b".repeat(40);
const authority = {
  repository: "anulman/codeops",
  repositoryUrl: "https://github.com/anulman/codeops",
  readToken: "github-read-token-with-sufficient-length",
};

function providerRequest(operation, input) {
  return {
    version: "codeops.github-read-provider-request/v1",
    operation,
    operationId: `githubread-${"c".repeat(64)}`,
    input,
    payloadDigest: `sha256:${"d".repeat(64)}`,
    provenance: {
      sessionId: "session-1",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      principalDigest: `sha256:${"e".repeat(64)}`,
    },
  };
}

function pullRequestResponse(sha = headSha) {
  return new Response(JSON.stringify({
    number: 20,
    title: "Bounded reads",
    body: "Read-only GitHub context.",
    state: "open",
    merged: false,
    draft: false,
    user: { login: "anulman" },
    base: { ref: "main", sha: "f".repeat(40) },
    head: { ref: "feat/acp-github-reads", sha },
    updated_at: "2026-08-14T15:00:00Z",
    html_url: "https://github.com/anulman/codeops/pull/20",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("fails closed when a pull-request head changes during the diff read", async () => {
  const responses = [
    pullRequestResponse(),
    new Response("diff --git a/a b/a\n", {
      status: 200,
      headers: { "content-type": "application/vnd.github.diff" },
    }),
    pullRequestResponse(changedHeadSha),
  ];
  const adapter = createGitHubReadAdapter({
    resolve: () => authority,
    fetch: async () => responses.shift(),
  });

  await assert.rejects(
    adapter(providerRequest("pull_request_diff", {
      repository: authority.repository,
      pullRequestNumber: 20,
      expectedHeadSha: headSha,
      maxBytes: 200_000,
    })),
    /head changed during diff read/,
  );
  assert.equal(responses.length, 0);
});

test("returns only the byte-bounded diff for a stable exact head", async () => {
  const responses = [
    pullRequestResponse(),
    new Response("123456789", {
      status: 200,
      headers: { "content-type": "application/vnd.github.diff" },
    }),
    pullRequestResponse(),
  ];
  const adapter = createGitHubReadAdapter({
    resolve: () => authority,
    fetch: async () => responses.shift(),
  });

  const result = await adapter(providerRequest("pull_request_diff", {
    repository: authority.repository,
    pullRequestNumber: 20,
    expectedHeadSha: headSha,
    maxBytes: 5,
  }));
  assert.deepEqual(result, {
    version: "codeops.github-pull-request-diff-result/v1",
    repository: authority.repository,
    pullRequestNumber: 20,
    headSha,
    content: "12345",
    contentBytes: 5,
    sourceBytes: 9,
    truncated: true,
  });
});

test("does not forward the repository credential to a check-log redirect", async () => {
  const calls = [];
  const adapter = createGitHubReadAdapter({
    resolve: () => authority,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: 99, head_sha: headSha }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (calls.length === 2) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://results.example.test/logs/99" },
        });
      }
      return new Response("check output", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });

  const result = await adapter(providerRequest("check_logs", {
    repository: authority.repository,
    headSha,
    checkRunId: 99,
    maxBytes: 200_000,
  }));
  assert.equal(result.content, "check output");
  assert.match(String(calls[1].headers.Authorization), /^Bearer /);
  assert.equal("Authorization" in calls[2].headers, false);
  assert.equal("Cookie" in calls[2].headers, false);
  assert.equal("Accept" in calls[2].headers, false);
  assert.equal("X-GitHub-Api-Version" in calls[2].headers, false);
  assert.equal(calls[2].url, "https://results.example.test/logs/99");
});

test("maps the remaining bounded GitHub read operations without exposing raw responses", async () => {
  const calls = [];
  const adapter = createGitHubReadAdapter({
    resolve: () => authority,
    fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, init });
      if (parsed.pathname === "/repos/anulman/codeops/pulls/20") {
        return pullRequestResponse();
      }
      if (parsed.pathname === "/graphql") {
        return new Response(JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: headSha,
                reviewThreads: {
                  nodes: [{
                    id: "thread-1",
                    isResolved: false,
                    path: "src/index.ts",
                    line: 12,
                    originalLine: 10,
                    comments: {
                      nodes: [{
                        databaseId: 123,
                        author: { login: "reviewer" },
                        body: "Please keep this bounded.",
                        createdAt: "2026-08-14T15:00:00Z",
                        url: "https://github.com/anulman/codeops/pull/20#discussion_r123",
                      }],
                      pageInfo: { hasNextPage: false },
                    },
                  }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === `/repos/anulman/codeops/commits/${headSha}/check-runs`) {
        return new Response(JSON.stringify({
          total_count: 1,
          check_runs: [{
            id: 99,
            name: "verify",
            status: "completed",
            conclusion: "success",
            head_sha: headSha,
            started_at: "2026-08-14T15:00:00Z",
            completed_at: "2026-08-14T15:01:00Z",
            details_url: "https://github.com/anulman/codeops/actions/runs/1",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/repos/anulman/codeops/branches/main") {
        return new Response(JSON.stringify({
          name: "main",
          protected: true,
          commit: { sha: headSha },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/search/issues") {
        return new Response(JSON.stringify({
          total_count: 1,
          incomplete_results: false,
          items: [{
            number: 42,
            title: "Bound GitHub reads",
            body: "Keep repository reads scoped.",
            state: "open",
            user: { login: "anulman" },
            updated_at: "2026-08-14T15:00:00Z",
            html_url: "https://github.com/anulman/codeops/issues/42",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected GitHub URL ${parsed}`);
    },
  });

  const pull = await adapter(providerRequest("pull_request_get", {
    repository: authority.repository,
    pullRequestNumber: 20,
  }));
  assert.equal(pull.version, "codeops.github-pull-request-snapshot/v1");

  const threads = await adapter(providerRequest("review_threads", {
    repository: authority.repository,
    pullRequestNumber: 20,
    expectedHeadSha: headSha,
    limit: 10,
  }));
  assert.equal(threads.threads[0].comments[0].commentId, 123);

  const checks = await adapter(providerRequest("checks", {
    repository: authority.repository,
    headSha,
  }));
  assert.equal(checks.checks[0].conclusion, "success");

  const branch = await adapter(providerRequest("protected_branch", {
    repository: authority.repository,
    branch: "main",
  }));
  assert.equal(branch.protected, true);

  const search = await adapter(providerRequest("search", {
    repository: authority.repository,
    kind: "issues",
    query: "bounded reads",
    limit: 5,
  }));
  assert.equal(search.items[0].kind, "issue");
  assert.ok(calls.every(({ init }) => String(init.headers.Authorization).startsWith("Bearer ")));
  assert.match(calls.at(-1).url.searchParams.get("q"), /repo:anulman\/codeops is:issue/);
});
