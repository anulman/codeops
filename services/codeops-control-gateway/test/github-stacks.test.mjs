import assert from "node:assert/strict";
import { test } from "node:test";
import { contractVersions } from "../../../packages/codeops-contracts/dist/index.js";
import {
  linkGitHubPullRequestStack,
  loadGitHubPullRequestStack,
} from "../dist/github-stacks.js";

const repositoryUrl = "https://github.com/anulman/renoconcierge.git";
const repositoryWriteToken = "w".repeat(32);
const mainSha = "0".repeat(40);
const parentSha = "a".repeat(40);
const childSha = "b".repeat(40);

function pullRequest({
  number,
  headRef,
  headSha,
  baseRef,
  baseSha,
  stack = null,
  mergedAt = null,
}) {
  return {
    number,
    state: mergedAt === null ? "open" : "closed",
    draft: false,
    merged_at: mergedAt,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    stack,
  };
}

const parent = pullRequest({
  number: 155,
  headRef: "feat/base",
  headSha: parentSha,
  baseRef: "main",
  baseSha: mainSha,
});
const child = pullRequest({
  number: 158,
  headRef: "feat/child",
  headSha: childSha,
  baseRef: "feat/base",
  baseSha: parentSha,
});
const link = {
  version: contractVersions.githubPullRequestStackLink,
  repository: { owner: "anulman", name: "renoconcierge" },
  parent: {
    number: parent.number,
    headSha: parentSha,
    headRef: "feat/base",
    baseRef: "main",
  },
  child: {
    number: child.number,
    headSha: childSha,
    headRef: "feat/child",
    baseRef: "feat/base",
  },
};

function stackResponse(pullRequests = [parent, child]) {
  return {
    number: 42,
    base: { ref: "main" },
    open: true,
    pull_requests: pullRequests,
  };
}

test("loads one bounded native GitHub stack snapshot", async () => {
  const snapshot = await loadGitHubPullRequestStack({
    repositoryUrl,
    repositoryToken: repositoryWriteToken,
    stackNumber: 42,
    fetch: async (url, options) => {
      assert.equal(
        url,
        "https://api.github.com/repos/anulman/renoconcierge/stacks/42",
      );
      assert.equal(options.method, "GET");
      return Response.json(stackResponse());
    },
  });
  assert.equal(snapshot.version, contractVersions.githubPullRequestStackSnapshot);
  assert.deepEqual(
    snapshot.pullRequests.map((entry) => entry.number),
    [155, 158],
  );
});

test("creates a native stack only after both pull requests match exact refs and heads", async () => {
  const calls = [];
  const responses = [
    Response.json(parent),
    Response.json(child),
    Response.json([]),
    Response.json([]),
    Response.json(stackResponse(), { status: 201 }),
  ];
  const snapshot = await linkGitHubPullRequestStack({
    link,
    repositoryUrl,
    repositoryWriteToken,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });
  assert.equal(snapshot.number, 42);
  assert.equal(calls.at(-1).options.method, "POST");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    pull_requests: [155, 158],
  });
  assert.match(calls.at(-1).url, /\/stacks$/);
});

test("extends only from the exact current stack top and rejects sibling fan-out", async () => {
  const upper = pullRequest({
    number: 159,
    headRef: "feat/upper",
    headSha: "c".repeat(40),
    baseRef: "feat/base",
    baseSha: parentSha,
  });
  const responses = [
    Response.json(parent),
    Response.json(child),
    Response.json([{ number: 42 }]),
    Response.json([]),
    Response.json(stackResponse([parent, upper])),
  ];
  await assert.rejects(
    linkGitHubPullRequestStack({
      link,
      repositoryUrl,
      repositoryWriteToken,
      fetch: async () => responses.shift(),
    }),
    /sibling fan-out must remain branch-only/,
  );
});

test("treats an exact existing adjacent stack link as idempotent", async () => {
  const responses = [
    Response.json({ ...parent, stack: { number: 42 } }),
    Response.json({ ...child, stack: { number: 42 } }),
    Response.json([{ number: 42 }]),
    Response.json([{ number: 42 }]),
    Response.json(stackResponse()),
  ];
  const snapshot = await linkGitHubPullRequestStack({
    link,
    repositoryUrl,
    repositoryWriteToken,
    fetch: async () => responses.shift(),
  });
  assert.equal(snapshot.number, 42);
});
