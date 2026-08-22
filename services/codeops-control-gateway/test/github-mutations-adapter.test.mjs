import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createGitHubMutationAdapter,
  createGitHubMutationReconciler,
  githubEffectMarker,
} from "../dist/github-mutations-adapter.js";

const repository = "anulman/codeops";
const head = "a".repeat(40);
const base = "b".repeat(40);
const operationId = `githubmutation-${"c".repeat(64)}`;
const authority = {
  repository,
  repositoryUrl: "https://github.com/anulman/codeops.git",
  readToken: "read-token-not-used-by-mutations",
  writeToken: "write-token-used-only-by-bounded-mutations",
};

function canonical(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function permissionOperation(operation, input) {
  const target = operation === "check_rerun"
    ? { pullRequestNumber: null, targetId: String(input.checkRunId) }
    : operation === "review_thread_reply"
      ? { pullRequestNumber: input.pullRequestNumber, targetId: input.threadId }
      : operation === "branch_publish"
        ? { pullRequestNumber: null, targetId: input.branchName }
        : operation === "pull_request_create"
          ? { pullRequestNumber: null, targetId: input.headBranch }
      : { pullRequestNumber: input.pullRequestNumber, targetId: null };
  return {
    kind: "github_mutation",
    repository,
    operation,
    ...target,
    expectedHeadSha: input.expectedHeadSha,
    payloadJson: canonical(input),
  };
}

function request(operation, input) {
  return {
    version: "codeops.github-mutation-provider-request/v1",
    operation,
    operationId,
    input,
    payloadDigest: digest(canonical(input)),
    permissionDigest: digest(canonical(permissionOperation(operation, input))),
    provenance: {
      sessionId: "session-github-mutation",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      principalDigest: `sha256:${"d".repeat(64)}`,
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pull(overrides = {}) {
  return {
    number: 27,
    title: "Original title",
    body: "Original body",
    base: { ref: "main", sha: base },
    head: { sha: head },
    html_url: "https://github.com/anulman/codeops/pull/27",
    ...overrides,
  };
}

test("executes only four bounded routes with preflight and postflight identity proof", async () => {
  const cases = [
    {
      operation: "pull_request_update_branch",
      input: { repository, pullRequestNumber: 27, expectedHeadSha: head },
      responses: [
        json(pull()),
        json({ message: "Updating pull request branch." }, 202),
        json(pull({ head: { sha: "e".repeat(40) } })),
      ],
      methods: ["GET", "PUT", "GET"],
      version: "codeops.github-pull-request-update-branch-result/v1",
    },
    {
      operation: "pull_request_update",
      input: {
        repository,
        pullRequestNumber: 27,
        expectedHeadSha: head,
        expectedBaseSha: base,
        title: "Bounded title",
        body: "Bounded body",
      },
      responses: [
        json(pull()),
        json(pull({ title: "Bounded title", body: "Bounded body" })),
        json(pull({ title: "Bounded title", body: "Bounded body" })),
      ],
      methods: ["GET", "PATCH", "GET"],
      version: "codeops.github-pull-request-update-result/v1",
    },
    {
      operation: "review_thread_reply",
      input: {
        repository,
        pullRequestNumber: 27,
        expectedHeadSha: head,
        threadId: "PRRT_thread_1",
        body: "Addressed in the exact head.",
      },
      responses: [
        json({ data: { node: {
          id: "PRRT_thread_1",
          pullRequest: {
            number: 27,
            headRefOid: head,
            repository: { nameWithOwner: repository },
          },
        } } }),
        json({ data: { addPullRequestReviewThreadReply: { comment: {
          databaseId: 9876,
          url: "https://github.com/anulman/codeops/pull/27#discussion_r9876",
          pullRequest: {
            number: 27,
            headRefOid: head,
            repository: { nameWithOwner: repository },
          },
        } } } }),
      ],
      methods: ["POST", "POST"],
      version: "codeops.github-review-thread-reply-result/v1",
    },
    {
      operation: "check_rerun",
      input: { repository, expectedHeadSha: head, checkRunId: 1234 },
      responses: [
        json({ id: 1234, head_sha: head }),
        json({ accepted: true }, 201),
        json({ id: 1234, head_sha: head }),
      ],
      methods: ["GET", "POST", "GET"],
      version: "codeops.github-check-rerun-result/v1",
    },
  ];

  for (const item of cases) {
    const calls = [];
    const responses = [...item.responses];
    const mutate = createGitHubMutationAdapter({
      resolve: () => authority,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return responses.shift();
      },
    });
    const result = await mutate(request(item.operation, item.input));
    assert.equal(result.version, item.version);
    assert.equal(result.repository, repository);
    assert.equal(result.operationId, operationId);
    assert.deepEqual(calls.map(({ init }) => init.method ?? "GET"), item.methods);
    assert.equal(responses.length, 0);
    if (item.operation === "review_thread_reply") {
      const mutationBody = JSON.parse(calls[1].init.body);
      assert.equal(
        mutationBody.variables.body,
        `${item.input.body}\n\n${githubEffectMarker(operationId)}`,
      );
    }
    for (const call of calls) {
      assert.equal(
        call.init.headers.Authorization,
        `Bearer ${authority.writeToken}`,
      );
      assert.doesNotMatch(JSON.stringify(call), /read-token-not-used/);
    }
  }
});

test("publishes one exact branch from bounded text replacements", async () => {
  const branchName = "codeops/alpha34-consumer";
  const published = "e".repeat(40);
  const responses = [
    json({ ref: "refs/heads/main", object: { sha: head, type: "commit" } }),
    json({ message: "Not Found" }, 404),
    json({ sha: head, message: "base", tree: { sha: "1".repeat(40) }, parents: [] }),
    json({ sha: "1".repeat(40), tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "2".repeat(40) }] }),
    json({ sha: "2".repeat(40), encoding: "base64", content: Buffer.from('{"version":"alpha.33"}\n').toString("base64") }),
    json({ sha: "3".repeat(40) }, 201),
    json({ sha: "4".repeat(40) }, 201),
    json({ sha: published }, 201),
    json({ ref: `refs/heads/${branchName}`, object: { sha: published, type: "commit" } }, 201),
    json({ ref: `refs/heads/${branchName}`, object: { sha: published, type: "commit" } }),
  ];
  const calls = [];
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift();
    },
  });
  const result = await mutate(request("branch_publish", {
    repository,
    expectedHeadSha: head,
    baseBranch: "main",
    branchName,
    commitMessage: "Repin CodeOps alpha.34",
    changes: [{ path: "package.json", oldText: "alpha.33", newText: "alpha.34" }],
  }));
  assert.equal(result.version, "codeops.github-branch-publish-result/v1");
  assert.equal(result.baseSha, head);
  assert.equal(result.headSha, published);
  assert.equal(result.url, `https://github.com/${repository}/tree/${branchName}`);
  assert.deepEqual(calls.map(({ init }) => init.method ?? "GET"), [
    "GET", "GET", "GET", "GET", "GET", "POST", "POST", "POST", "POST", "GET",
  ]);
  const commitBody = JSON.parse(calls[7].init.body);
  assert.deepEqual(commitBody.parents, [head]);
  assert.match(commitBody.message, new RegExp(operationId));
  assert.equal(responses.length, 0);
});

test("completes every branch publication read before the first provider write", async () => {
  const responses = [
    json({ ref: "refs/heads/main", object: { sha: head, type: "commit" } }),
    json({ message: "Not Found" }, 404),
    json({ sha: head, message: "base", tree: { sha: "1".repeat(40) }, parents: [] }),
    json({ sha: "1".repeat(40), tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "2".repeat(40) }] }),
    json({ sha: "2".repeat(40), encoding: "base64", content: Buffer.from("alpha.33\n").toString("base64") }),
    json({ sha: "1".repeat(40), tree: [] }),
  ];
  const methods = [];
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (_url, init) => {
      methods.push(init.method ?? "GET");
      return responses.shift();
    },
  });
  await assert.rejects(mutate(request("branch_publish", {
    repository,
    expectedHeadSha: head,
    baseBranch: "main",
    branchName: "codeops/alpha34-consumer",
    commitMessage: "Repin CodeOps alpha.34",
    changes: [
      { path: "package.json", oldText: "alpha.33", newText: "alpha.34" },
      { path: "missing.json", oldText: "alpha.33", newText: "alpha.34" },
    ],
  })), /no remote effect occurred/);
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "GET", "GET"]);
  assert.equal(responses.length, 0);
});

test("creates one pull request after exact head and base ref proof", async () => {
  const branchName = "codeops/alpha34-consumer";
  const pr = pull({
    title: "Repin CodeOps alpha.34",
    body: `Qualified consumer update.\n\n<!-- codeops-provider-effect:${operationId} -->`,
    draft: false,
    head: { ref: branchName, sha: head },
    base: { ref: "main", sha: base },
  });
  const responses = [
    json({ ref: `refs/heads/${branchName}`, object: { sha: head, type: "commit" } }),
    json({ ref: "refs/heads/main", object: { sha: base, type: "commit" } }),
    json([]),
    json(pr, 201),
    json(pr),
  ];
  const calls = [];
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift();
    },
  });
  const result = await mutate(request("pull_request_create", {
    repository,
    expectedHeadSha: head,
    expectedBaseSha: base,
    headBranch: branchName,
    baseBranch: "main",
    title: "Repin CodeOps alpha.34",
    body: "Qualified consumer update.",
    draft: false,
  }));
  assert.equal(result.version, "codeops.github-pull-request-create-result/v1");
  assert.equal(result.pullRequestNumber, 27);
  assert.equal(result.body, "Qualified consumer update.");
  assert.deepEqual(calls.map(({ init }) => init.method ?? "GET"), ["GET", "GET", "GET", "POST", "GET"]);
  assert.equal(responses.length, 0);
});

test("rejects pull-request ref-name drift before the provider write", async () => {
  const responses = [
    json({ ref: "refs/heads/foreign", object: { sha: head, type: "commit" } }),
    json({ ref: "refs/heads/main", object: { sha: base, type: "commit" } }),
  ];
  const methods = [];
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (_url, init) => {
      methods.push(init.method ?? "GET");
      return responses.shift();
    },
  });
  await assert.rejects(mutate(request("pull_request_create", {
    repository,
    expectedHeadSha: head,
    expectedBaseSha: base,
    headBranch: "codeops/alpha34-consumer",
    baseBranch: "main",
    title: "Repin CodeOps alpha.34",
    body: "Qualified consumer update.",
    draft: false,
  })), /no remote effect occurred/);
  assert.deepEqual(methods, ["GET", "GET"]);
  assert.equal(responses.length, 0);
});

test("builds one exact hidden review marker from the provider effect identity", () => {
  assert.equal(
    githubEffectMarker(operationId),
    `<!-- codeops-provider-effect:${operationId} -->`,
  );
  assert.throws(() => githubEffectMarker("githubmutation-not-a-digest"));
});

test("rejects stale heads and forged permission digests before a provider effect", async () => {
  const calls = [];
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return json(pull({ head: { sha: "f".repeat(40) } }));
    },
  });
  await assert.rejects(
    mutate(request("pull_request_update", {
      repository,
      pullRequestNumber: 27,
      expectedHeadSha: head,
      expectedBaseSha: base,
      title: "Must not write",
    })),
    /identity changed before update/,
  );
  assert.deepEqual(calls.map(({ init }) => init.method ?? "GET"), ["GET"]);

  const forged = request("check_rerun", {
    repository,
    expectedHeadSha: head,
    checkRunId: 1234,
  });
  forged.permissionDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(mutate(forged), /digests do not match/);
  assert.equal(calls.length, 1);
});

test("reconciles each mutation only from operation-specific attributable evidence", async () => {
  const attemptedAt = new Date("2026-08-16T00:00:00.000Z");
  const observedAt = new Date("2026-08-16T00:02:00.000Z");

  const branchInput = {
    repository,
    expectedHeadSha: head,
    baseBranch: "main",
    branchName: "codeops/alpha34-consumer",
    commitMessage: "Repin CodeOps alpha.34",
    changes: [{ path: "package.json", oldText: "alpha.33", newText: "alpha.34" }],
  };
  const branchResponses = [
    json({ ref: `refs/heads/${branchInput.branchName}`, object: { sha: "e".repeat(40), type: "commit" } }),
    json({
      sha: "e".repeat(40),
      message: `${branchInput.commitMessage}\n\ncodeops-provider-effect:${operationId}`,
      tree: { sha: "f".repeat(40) },
      parents: [{ sha: head }],
    }),
  ];
  const reconcilePublishedBranch = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => branchResponses.shift(),
  });
  assert.equal(
    (await reconcilePublishedBranch(request("branch_publish", branchInput), attemptedAt, observedAt)).state,
    "reconciled_satisfied",
  );

  const createInput = {
    repository,
    expectedHeadSha: head,
    expectedBaseSha: base,
    headBranch: branchInput.branchName,
    baseBranch: "main",
    title: "Repin CodeOps alpha.34",
    body: "Qualified consumer update.",
    draft: false,
  };
  const reconcileCreatedPull = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json([pull({
      title: createInput.title,
      body: `${createInput.body}\n\n<!-- codeops-provider-effect:${operationId} -->`,
      draft: false,
      head: { ref: createInput.headBranch, sha: head },
      base: { ref: createInput.baseBranch, sha: base },
    })]),
  });
  assert.equal(
    (await reconcileCreatedPull(request("pull_request_create", createInput), attemptedAt, observedAt)).state,
    "reconciled_satisfied",
  );

  const updateInput = {
    repository,
    pullRequestNumber: 27,
    expectedHeadSha: head,
    expectedBaseSha: base,
    title: "Reconciled title",
  };
  const reconcileUpdate = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json(pull({ title: "Reconciled title" })),
  });
  assert.equal(
    (await reconcileUpdate(request("pull_request_update", updateInput), attemptedAt, observedAt)).state,
    "reconciled_satisfied",
  );

  const replyInput = {
    repository,
    pullRequestNumber: 27,
    expectedHeadSha: head,
    threadId: "PRRT_thread_1",
    body: "Addressed.",
  };
  const replyRequest = request("review_thread_reply", replyInput);
  const reconcileReply = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json({ data: { node: {
      id: replyInput.threadId,
      pullRequest: {
        number: 27,
        headRefOid: head,
        repository: { nameWithOwner: repository },
      },
      comments: { nodes: [{
        databaseId: 9876,
        url: "https://github.com/anulman/codeops/pull/27#discussion_r9876",
        body: `Addressed.\n\n${githubEffectMarker(operationId)}`,
      }], pageInfo: { hasPreviousPage: false } },
    } } }),
  });
  const reply = await reconcileReply(replyRequest, attemptedAt, observedAt);
  assert.equal(reply.state, "reconciled_satisfied");
  assert.equal(reply.result.commentId, 9876);

  const reconcileAbsentReply = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json({ data: { node: {
      id: replyInput.threadId,
      pullRequest: {
        number: 27,
        headRefOid: head,
        repository: { nameWithOwner: repository },
      },
      comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
    } } }),
  });
  assert.equal(
    (await reconcileAbsentReply(replyRequest, attemptedAt, observedAt)).state,
    "reconciled_not_observed",
  );

  const reconcileBranch = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json(pull()),
  });
  assert.equal((await reconcileBranch(request("pull_request_update_branch", {
    repository,
    pullRequestNumber: 27,
    expectedHeadSha: head,
  }), attemptedAt, observedAt)).state, "reconciled_not_observed");

  const reconcileCheck = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json({ id: 1234, head_sha: head }),
  });
  assert.equal((await reconcileCheck(request("check_rerun", {
    repository,
    expectedHeadSha: head,
    checkRunId: 1234,
  }), attemptedAt, observedAt)).state, "unknown");
});

test("reconciles an absent publication branch after the consistency window", async () => {
  const reconcile = createGitHubMutationReconciler({
    resolve: () => authority,
    fetch: async () => json({ message: "Not Found" }, 404),
  });
  const input = {
    repository,
    expectedHeadSha: head,
    baseBranch: "main",
    branchName: "codeops/missing-publication",
    commitMessage: "Publish candidate",
    changes: [{ path: "package.json", oldText: "old", newText: "new" }],
  };
  const attemptedAt = new Date("2026-08-14T15:07:00.000Z");
  assert.equal((await reconcile(
    request("branch_publish", input),
    attemptedAt,
    new Date("2026-08-14T15:08:01.000Z"),
  )).state, "reconciled_not_observed");
});
