import assert from "node:assert/strict";
import test from "node:test";
import {
  githubCheckRerunResultSchema,
  githubMutationProviderRequestSchema,
  githubMutationResultSchema,
  githubPullRequestUpdateBranchResultSchema,
  providerEffectReceiptSchema,
  sessionRuntimeGitHubMutationRequestSchema,
  sessionPermissionOperationSchema,
} from "../dist/index.js";

const repository = "anulman/codeops";
const expectedHeadSha = "a".repeat(40);
const operationId = `githubmutation-${"b".repeat(64)}`;
const claimToken = "11111111-1111-4111-8111-111111111111";

const operations = [
  {
    operation: "pull_request_update_branch",
    input: { repository, pullRequestNumber: 27, expectedHeadSha },
  },
  {
    operation: "pull_request_update",
    input: {
      repository,
      pullRequestNumber: 27,
      expectedHeadSha,
      expectedBaseSha: "c".repeat(40),
      title: "Bounded title",
    },
  },
  {
    operation: "review_thread_reply",
    input: {
      repository,
      pullRequestNumber: 27,
      expectedHeadSha,
      threadId: "PRRT_kwDO-thread",
      body: "Addressed in the exact candidate.",
    },
  },
  {
    operation: "check_rerun",
    input: { repository, expectedHeadSha, checkRunId: 94886543084 },
  },
];

test("accepts only the four bounded exact-head GitHub mutations", () => {
  for (const mutation of operations) {
    const parsed = sessionRuntimeGitHubMutationRequestSchema.parse({
      version: "codeops.session-runtime-github-mutation-request/v1",
      claimToken,
      operationId,
      ...mutation,
    });
    assert.equal(parsed.operation, mutation.operation);
    assert.equal(parsed.input.repository, repository);
  }

  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operationId,
    operation: "pull_request_merge",
    input: { repository, pullRequestNumber: 27, expectedHeadSha },
  }));
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operationId,
    operation: "check_rerun",
    input: { repository, expectedHeadSha, checkRunId: 1, token: "secret" },
  }));
});

test("requires optimistic concurrency and bounded pull-request fields", () => {
  const base = {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operationId,
    operation: "pull_request_update",
    input: {
      repository,
      pullRequestNumber: 27,
      expectedHeadSha,
      expectedBaseSha: "c".repeat(40),
    },
  };
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse(base));
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    ...base,
    input: { ...base.input, title: "New title", expectedHeadSha: undefined },
  }));
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    ...base,
    input: { ...base.input, title: "New title", baseBranch: "refs/heads/main..bad" },
  }));
});

test("separates the live claim from permission-bound provider provenance", () => {
  const mutation = operations[2];
  const provider = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operationId,
    payloadDigest: `sha256:${"d".repeat(64)}`,
    permissionDigest: `sha256:${"e".repeat(64)}`,
    provenance: {
      sessionId: "session-1",
      dispatchId: "22222222-2222-4222-8222-222222222222",
      principalDigest: `sha256:${"f".repeat(64)}`,
    },
    ...mutation,
  });
  assert.equal("claimToken" in provider, false);
  assert.throws(() => githubMutationProviderRequestSchema.parse({
    ...provider,
    claimToken,
  }));
  assert.throws(() => githubMutationProviderRequestSchema.parse({
    ...provider,
    permissionDigest: undefined,
  }));
});

test("retains one operation-specific allow-once permission representation", () => {
  const operation = sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository,
    operation: "review_thread_reply",
    pullRequestNumber: 27,
    expectedHeadSha,
    targetId: "PRRT_kwDO-thread",
    payloadJson: JSON.stringify(operations[2].input),
  });
  assert.equal(operation.kind, "github_mutation");
  assert.equal(operation.targetId, "PRRT_kwDO-thread");
  assert.throws(() => sessionPermissionOperationSchema.parse({
    ...operation,
    operation: "pull_request_merge",
  }));
});

test("rejects result identity drift and undeclared mutation responses", () => {
  const advanced = githubPullRequestUpdateBranchResultSchema.parse({
    version: "codeops.github-pull-request-update-branch-result/v1",
    repository,
    operationId,
    pullRequestNumber: 27,
    previousHeadSha: expectedHeadSha,
    headSha: "9".repeat(40),
    url: "https://github.com/anulman/codeops/pull/27",
  });
  assert.equal(advanced.headSha, "9".repeat(40));
  assert.throws(() => githubPullRequestUpdateBranchResultSchema.parse({
    ...advanced,
    headSha: expectedHeadSha,
  }));
  assert.throws(() => githubPullRequestUpdateBranchResultSchema.parse({
    ...advanced,
    url: "https://github.com/other/repository/pull/27",
  }));
  assert.equal(githubCheckRerunResultSchema.parse({
    version: "codeops.github-check-rerun-result/v1",
    repository,
    operationId,
    headSha: expectedHeadSha,
    checkRunId: 94886543084,
    accepted: true,
  }).accepted, true);
  assert.throws(() => githubMutationResultSchema.parse({
    version: "codeops.github-raw-mutation-result/v1",
    repository,
    operationId,
    body: { token: "must-not-pass" },
  }));
});

test("models authorization separately from every provider effect outcome", () => {
  const authorized = {
    version: "codeops.provider-effect-receipt/v1",
    effectId: operationId,
    provider: "github",
    repository,
    operation: "review_thread_reply",
    pullRequestNumber: 27,
    targetId: "PRRT_kwDO-thread",
    expectedHeadSha,
    payloadDigest: `sha256:${"d".repeat(64)}`,
    permissionDigest: `sha256:${"e".repeat(64)}`,
    sessionId: "session-1",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    state: "authorized",
    authorizedAt: "2026-08-16T00:00:00.000Z",
    attemptedAt: null,
    resolvedAt: null,
    reconciliationAction: "none",
    resolutionSummary: null,
  };
  assert.equal(providerEffectReceiptSchema.parse(authorized).state, "authorized");
  assert.equal(providerEffectReceiptSchema.parse({
    ...authorized,
    state: "unknown",
    attemptedAt: "2026-08-16T00:00:01.000Z",
    reconciliationAction: "search_review_thread_marker",
  }).state, "unknown");
  assert.equal(providerEffectReceiptSchema.parse({
    ...authorized,
    state: "reconciled_satisfied",
    attemptedAt: "2026-08-16T00:00:01.000Z",
    resolvedAt: "2026-08-16T00:01:00.000Z",
    reconciliationAction: "none",
    resolutionSummary: "The exact operation marker is present in the review thread.",
  }).state, "reconciled_satisfied");
  assert.throws(() => providerEffectReceiptSchema.parse({
    ...authorized,
    state: "unknown",
  }));
  assert.throws(() => providerEffectReceiptSchema.parse({
    ...authorized,
    state: "succeeded",
    attemptedAt: "2026-08-16T00:00:01.000Z",
  }));
  assert.throws(() => providerEffectReceiptSchema.parse({
    ...authorized,
    rawProviderBody: "must-not-pass",
  }));
});
