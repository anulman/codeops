import assert from "node:assert/strict";
import test from "node:test";
import {
  githubCheckLogsInputSchema,
  githubCheckLogsResultSchema,
  githubCheckRunSchema,
  githubProtectedBranchResultSchema,
  githubPullRequestDiffInputSchema,
  githubReadProviderRequestSchema,
  githubReadResultSchema,
  githubPullRequestSnapshotSchema,
  githubReviewThreadsInputSchema,
  githubSearchInputSchema,
  githubSearchItemSchema,
  githubSearchResultSchema,
  sessionRuntimeGitHubReadRequestSchema,
} from "../dist/github-reads.js";

const repository = "anulman/codeops";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

test("bounds every GitHub read input to one repository and exact identity", () => {
  assert.equal(githubPullRequestDiffInputSchema.parse({
    repository,
    pullRequestNumber: 19,
    expectedHeadSha: headSha,
  }).maxBytes, 200_000);
  assert.equal(githubReviewThreadsInputSchema.parse({
    repository,
    pullRequestNumber: 19,
    expectedHeadSha: headSha,
  }).limit, 100);
  assert.equal(githubCheckLogsInputSchema.parse({
    repository,
    headSha,
    checkRunId: 94672272638,
  }).maxBytes, 200_000);
  assert.equal(githubSearchInputSchema.parse({
    repository,
    kind: "pull_requests",
    query: "ACP session",
  }).limit, 20);

  assert.throws(() => githubPullRequestDiffInputSchema.parse({
    repository: "not admitted",
    pullRequestNumber: 19,
    expectedHeadSha: headSha,
  }));
  assert.throws(() => githubPullRequestDiffInputSchema.parse({
    repository,
    pullRequestNumber: 19,
    expectedHeadSha: "main",
  }));
  assert.throws(() => githubReviewThreadsInputSchema.parse({
    repository,
    pullRequestNumber: 19,
    expectedHeadSha: headSha,
    limit: 101,
  }));
  assert.throws(() => githubSearchInputSchema.parse({
    repository,
    kind: "pull_requests",
    query: "x".repeat(501),
  }));
});

test("binds pull-request metadata to exact base and head commits", () => {
  const snapshot = githubPullRequestSnapshotSchema.parse({
    version: "codeops.github-pull-request-snapshot/v1",
    repository,
    pullRequestNumber: 19,
    title: "Make ACP sessions useful from Plane",
    body: "Bounded work-item tools.",
    state: "open",
    merged: false,
    draft: false,
    authorLogin: "anulman",
    baseBranch: "main",
    baseSha,
    headBranch: "feat/acp-session-utility",
    headSha,
    updatedAt: "2026-08-14T04:20:00.000Z",
    url: "https://github.com/anulman/codeops/pull/19",
  });
  assert.equal(snapshot.headSha, headSha);
  assert.throws(() => githubPullRequestSnapshotSchema.parse({
    ...snapshot,
    state: "open",
    merged: true,
  }), /must be closed/);
  assert.throws(() => githubPullRequestSnapshotSchema.parse({
    ...snapshot,
    url: "https://github.com/anulman/codeops/pull/20",
  }), /identity is inconsistent/);
});

test("requires explicit and consistent truncation metadata", () => {
  const result = githubCheckLogsResultSchema.parse({
    version: "codeops.github-check-logs-result/v1",
    repository,
    headSha,
    checkRunId: 94672272638,
    content: "partial logs",
    contentBytes: 12,
    sourceBytes: 1_024,
    truncated: true,
  });
  assert.equal(result.truncated, true);
  assert.throws(() => githubCheckLogsResultSchema.parse({
    ...result,
    truncated: false,
  }), /truncation metadata/);
  assert.throws(() => githubCheckLogsResultSchema.parse({
    ...result,
    contentBytes: 2_000,
  }), /cannot exceed/);
  assert.throws(() => githubCheckLogsResultSchema.parse({
    ...result,
    contentBytes: 11,
  }), /byte count/);
});

test("rejects unprotected branch projections and invalid check conclusions", () => {
  assert.equal(githubProtectedBranchResultSchema.parse({
    version: "codeops.github-protected-branch-result/v1",
    repository,
    branch: "main",
    headSha,
    protected: true,
  }).protected, true);
  assert.throws(() => githubProtectedBranchResultSchema.parse({
    version: "codeops.github-protected-branch-result/v1",
    repository,
    branch: "main",
    headSha,
    protected: false,
  }));
  assert.throws(() => githubCheckRunSchema.parse({
    checkRunId: 1,
    name: "verify",
    status: "in_progress",
    conclusion: "success",
    startedAt: "2026-08-14T04:19:02.000Z",
    completedAt: null,
    detailsUrl: null,
  }), /must match/);
});

test("keeps issue and pull-request search result shapes distinct", () => {
  assert.equal(githubSearchItemSchema.parse({
    kind: "issue",
    number: 42,
    title: "Bound GitHub reads",
    excerpt: "Read-only capability.",
    state: "open",
    draft: null,
    authorLogin: "anulman",
    updatedAt: "2026-08-14T04:20:00.000Z",
    url: "https://github.com/anulman/codeops/issues/42",
  }).kind, "issue");
  assert.throws(() => githubSearchItemSchema.parse({
    kind: "issue",
    number: 42,
    title: "Bound GitHub reads",
    excerpt: "Read-only capability.",
    state: "open",
    draft: false,
    authorLogin: "anulman",
    updatedAt: "2026-08-14T04:20:00.000Z",
    url: "https://github.com/anulman/codeops/issues/42",
  }), /must match/);
  assert.throws(() => githubSearchItemSchema.parse({
    kind: "issue",
    number: 42,
    title: "Bound GitHub reads",
    excerpt: "Read-only capability.",
    state: "open",
    draft: null,
    authorLogin: "anulman",
    updatedAt: "2026-08-14T04:20:00.000Z",
    url: "https://evil.example/anulman/codeops/issues/42",
  }), /exact HTTPS origin/);
  assert.throws(() => githubSearchResultSchema.parse({
    version: "codeops.github-search-result/v1",
    repository,
    kind: "pull_requests",
    query: "bounded reads",
    items: [{
      kind: "issue",
      number: 42,
      title: "Bound GitHub reads",
      excerpt: "Read-only capability.",
      state: "open",
      draft: null,
      authorLogin: "anulman",
      updatedAt: "2026-08-14T04:20:00.000Z",
      url: "https://github.com/anulman/codeops/issues/42",
    }],
    truncated: false,
  }), /kind is inconsistent/);
});

test("separates live-claim runtime requests from credential-free provider provenance", () => {
  const input = {
    repository,
    kind: "issues",
    query: "runtime",
    limit: 5,
  };
  const operationId = `githubread-${"c".repeat(64)}`;
  const runtime = sessionRuntimeGitHubReadRequestSchema.parse({
    version: "codeops.session-runtime-github-read-request/v1",
    claimToken: "11111111-1111-4111-8111-111111111111",
    operation: "search",
    operationId,
    input,
  });
  assert.equal(runtime.claimToken, "11111111-1111-4111-8111-111111111111");

  const provider = githubReadProviderRequestSchema.parse({
    version: "codeops.github-read-provider-request/v1",
    operation: "search",
    operationId,
    input,
    payloadDigest: `sha256:${"d".repeat(64)}`,
    provenance: {
      sessionId: "session-1",
      dispatchId: "22222222-2222-4222-8222-222222222222",
      principalDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  assert.equal("claimToken" in provider, false);
  assert.throws(() => githubReadProviderRequestSchema.parse({
    ...provider,
    claimToken: runtime.claimToken,
  }));
  assert.throws(() => sessionRuntimeGitHubReadRequestSchema.parse({
    ...runtime,
    operation: "checks",
  }));
});

test("accepts only one declared bounded GitHub result shape", () => {
  assert.equal(githubReadResultSchema.parse({
    version: "codeops.github-search-result/v1",
    repository,
    kind: "issues",
    query: "runtime",
    items: [],
    truncated: false,
  }).version, "codeops.github-search-result/v1");
  assert.throws(() => githubReadResultSchema.parse({
    version: "codeops.github-raw-response/v1",
    repository,
    body: { token: "must-not-pass" },
  }));
});
