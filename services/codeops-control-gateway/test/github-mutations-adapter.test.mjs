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
