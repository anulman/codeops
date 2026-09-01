import assert from "node:assert/strict";
import test from "node:test";
import {
  githubCheckRerunResultSchema,
  githubBranchPublishCandidateSchema,
  githubBranchPublishCandidateManifestRequestSchema,
  githubBranchPublishCandidateChunkRequestSchema,
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
const candidate = {
  manifestId: `githubcandidate-${"c".repeat(64)}`,
  digest: `sha256:${"d".repeat(64)}`,
  sizeBytes: 128,
  chunkCount: 1,
};

const operations = [
  {
    operation: "branch_publish",
    input: {
      repository,
      expectedHeadSha,
      baseBranch: "main",
      branchName: "codeops/alpha34-consumer",
      commitMessage: "Repin CodeOps alpha.34",
      candidate,
    },
  },
  {
    operation: "pull_request_create",
    input: {
      repository,
      expectedHeadSha,
      expectedBaseSha: "c".repeat(40),
      headBranch: "codeops/alpha34-consumer",
      baseBranch: "main",
      title: "Repin CodeOps alpha.34",
      body: "Qualified consumer update.",
      draft: false,
    },
  },
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

test("accepts only the six bounded exact-head GitHub mutations", () => {
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

test("accepts bounded non-empty candidate changes", () => {
  const parsed = githubBranchPublishCandidateSchema.parse({
    version: "codeops.github-branch-publish-candidate/v1",
    changes: [{ path: "docs/evidence.md", oldText: "", newText: "proof\n" }],
  });
  assert.equal(parsed.changes[0].oldText, "");
  assert.throws(() => githubBranchPublishCandidateSchema.parse({
    ...parsed,
    changes: [{ path: "docs/evidence.md", oldText: "", newText: "" }],
  }));
});

test("accepts exactly 100 unique publication paths and rejects 101", () => {
  const changes = Array.from({ length: 100 }, (_, index) => ({
    path: `proof-${index}.txt`, oldText: "before\n", newText: "after\n",
  }));
  assert.equal(githubBranchPublishCandidateSchema.parse({
    version: "codeops.github-branch-publish-candidate/v1", changes,
  }).changes.length, 100);
  const inlineInput = {
    repository, expectedHeadSha, baseBranch: "main",
    branchName: "codeops/path-cap-proof", commitMessage: "Prove path cap",
    changes,
  };
  assert.equal(sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken, operationId, operation: "branch_publish", input: inlineInput,
  }).input.changes.length, 100);
  const changesOverLimit = [
    ...changes,
    { path: "proof-100.txt", oldText: "before\n", newText: "after\n" },
  ];
  assert.throws(() => githubBranchPublishCandidateSchema.parse({
    version: "codeops.github-branch-publish-candidate/v1",
    changes: changesOverLimit,
  }));
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken, operationId, operation: "branch_publish",
    input: { ...inlineInput, changes: changesOverLimit },
  }));
});

test("keeps the control-plane publication input bounded to a candidate reference", () => {
  const input = operations[0].input;
  assert.equal(sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1", claimToken,
    operationId, operation: "branch_publish", input,
  }).input.candidate.chunkCount, 1);
  assert.equal(sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository,
    operation: "branch_publish",
    pullRequestNumber: null,
    expectedHeadSha,
    targetId: input.branchName,
    payloadJson: JSON.stringify(input),
  }).payloadJson.length < 2_000, true);
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1", claimToken,
    operationId, operation: "branch_publish",
    input: { ...input, candidate: { ...candidate, chunkCount: 65 } },
  }));
});

test("keeps the bounded v1 inline publication compatible only at the runtime boundary", () => {
  const inlineInput = {
    repository, expectedHeadSha, baseBranch: "main",
    branchName: "codeops/legacy-inline", commitMessage: "Legacy publication",
    changes: [{ path: "proof.txt", oldText: "before\n", newText: "after\n" }],
  };
  const runtime = sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken, operationId, operation: "branch_publish", input: inlineInput,
  });
  assert.deepEqual(runtime.input, inlineInput);
  assert.equal(sessionPermissionOperationSchema.parse({
    kind: "github_mutation", repository, operation: "branch_publish",
    pullRequestNumber: null, targetId: inlineInput.branchName,
    expectedHeadSha, payloadJson: JSON.stringify(inlineInput),
  }).payloadJson, JSON.stringify(inlineInput));
  assert.throws(() => githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operationId, operation: "branch_publish", input: inlineInput,
    payloadDigest: `sha256:${"e".repeat(64)}`,
    permissionDigest: `sha256:${"f".repeat(64)}`,
    provenance: { sessionId: "session-legacy", dispatchId: claimToken,
      principalDigest: `sha256:${"1".repeat(64)}` },
  }));
});

test("normalizes only surrounding inline publication commit-message whitespace", () => {
  const input = {
    repository, expectedHeadSha, baseBranch: "main",
    branchName: "codeops/normalized-inline",
    commitMessage: "Publish  adjacent words",
    changes: [{ path: "proof.txt", oldText: "before\n", newText: "after\n" }],
  };
  const parse = (commitMessage) => sessionRuntimeGitHubMutationRequestSchema.parse({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken, operationId, operation: "branch_publish",
    input: { ...input, commitMessage },
  }).input;
  assert.deepEqual(parse(` \t${input.commitMessage}\n`), input);
  assert.deepEqual(parse(input.commitMessage), input);
});

test("bounds one immutable candidate manifest to 4 MiB in at most 64 chunks", () => {
  const chunks = Array.from({ length: 64 }, (_, ordinal) => ({
    ordinal, digest: `sha256:${ordinal.toString(16).padStart(64, "0")}`,
    sizeBytes: 65_536,
  }));
  const manifest = githubBranchPublishCandidateManifestRequestSchema.parse({
    version: "codeops.github-branch-publish-candidate-manifest-request/v1",
    claimToken, operationId, effectDigest: `sha256:${"e".repeat(64)}`,
    repository,
    candidate: { manifestId: `githubcandidate-${"f".repeat(64)}`,
      digest: `sha256:${"d".repeat(64)}`, sizeBytes: 4_194_304,
      chunkCount: 64 },
    chunks,
  });
  assert.equal(manifest.chunks.at(-1).ordinal, 63);
  assert.throws(() => githubBranchPublishCandidateManifestRequestSchema.parse({
    ...manifest, candidate: { ...manifest.candidate, sizeBytes: 4_194_305 },
  }));
  assert.throws(() => githubBranchPublishCandidateManifestRequestSchema.parse({
    ...manifest, chunks: [...chunks, { ...chunks[0], ordinal: 64 }],
  }));
  assert.equal(githubBranchPublishCandidateChunkRequestSchema.parse({
    version: "codeops.github-branch-publish-candidate-chunk-request/v1",
    claimToken, operationId, manifestId: manifest.candidate.manifestId,
    ordinal: 0, digest: chunks[0].digest,
    bytesBase64: Buffer.alloc(65_536).toString("base64"),
  }).ordinal, 0);
});

test("separates strict create and fast-forward branch publication modes", () => {
  const create = operations[0];
  const wrap = (input) => ({
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operationId,
    ...create,
    input,
  });
  const fastForward = {
    ...create.input,
    mode: "fast_forward",
    expectedBranchHeadSha: "c".repeat(40),
    expectedBranchHeadEffectId: `githubmutation-${"d".repeat(64)}`,
  };
  assert.equal(sessionRuntimeGitHubMutationRequestSchema.parse(wrap(fastForward)).input.mode, "fast_forward");
  for (const key of ["expectedBranchHeadSha", "expectedBranchHeadEffectId"]) {
    assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse(wrap({ ...fastForward, [key]: undefined })));
  }
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse(wrap({ ...fastForward, mode: "create" })));
  assert.throws(() => sessionRuntimeGitHubMutationRequestSchema.parse(wrap({ ...fastForward, force: true })));
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
