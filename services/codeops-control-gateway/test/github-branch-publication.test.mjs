import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalJsonText,
  sha256CanonicalJsonDigest,
} from "@codeops/codeops-contracts";
import { GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS } from "../dist/github-mutations-adapter.js";
import { createGitHubMutationAdapter } from "../dist/github-branch-fast-forward.js";

const repository = "anulman/codeops";
const head = "a".repeat(40);
const operationId = `githubmutation-${"c".repeat(64)}`;
const authority = {
  repository,
  repositoryUrl: "https://github.com/anulman/codeops.git",
  readToken: "read-token-not-used-by-mutations",
  writeToken: "write-token-used-only-by-bounded-mutations",
};

function request(input) {
  const permission = {
    kind: "github_mutation",
    repository,
    operation: "branch_publish",
    pullRequestNumber: null,
    targetId: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    payloadJson: canonicalJsonText(input),
  };
  return {
    version: "codeops.github-mutation-provider-request/v1",
    operation: "branch_publish",
    operationId,
    input,
    payloadDigest: sha256CanonicalJsonDigest(input),
    permissionDigest: sha256CanonicalJsonDigest(permission),
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

function fixture({ branchName, publicationTimeoutMs, writeBlob }) {
  const rootTree = "1".repeat(40);
  const published = "e".repeat(40);
  const directories = Array.from({ length: 8 }, (_, index) =>
    createHash("sha1").update(`tree-${index}`).digest("hex"));
  const changes = directories.map((_sha, index) => ({
    path: `dir-${index}/evidence.txt`,
    oldText: "",
    newText: `proof-${index}\n`,
  }));
  const calls = [];
  let rootReads = 0;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      return json({ ref: "refs/heads/main", object: { sha: head, type: "commit" } });
    }
    if (method === "GET" && path.endsWith(`/git/ref/heads/${branchName}`)) {
      return calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs"))
        ? json({ ref: `refs/heads/${branchName}`, object: { sha: published, type: "commit" } })
        : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && path.endsWith(`/git/commits/${head}`)) {
      return json({ sha: head, message: "base", tree: { sha: rootTree }, parents: [] });
    }
    if (method === "GET" && path.endsWith(`/git/trees/${rootTree}`)) {
      rootReads += 1;
      return json({
        sha: rootTree,
        tree: directories.map((sha, index) => ({
          path: `dir-${index}`,
          mode: "040000",
          type: "tree",
          sha,
        })),
      });
    }
    const directory = directories.findIndex((sha) => path.endsWith(`/git/trees/${sha}`));
    if (method === "GET" && directory >= 0) {
      return json({ sha: directories[directory], tree: [] });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) {
      return writeBlob({
        index: Number(JSON.parse(init.body).content.match(/\d+/)[0]),
        signal: init.signal,
      });
    }
    if (method === "POST" && path.endsWith("/git/trees")) return json({ sha: "b".repeat(40) }, 201);
    if (method === "POST" && path.endsWith("/git/commits")) return json({ sha: published }, 201);
    if (method === "POST" && path.endsWith("/git/refs")) return json({ accepted: true }, 201);
    throw new Error(`Unexpected GitHub call: ${method} ${path}`);
  };
  return {
    calls,
    changes,
    fetch,
    published,
    rootReads: () => rootReads,
    mutate: createGitHubMutationAdapter({
      resolve: () => authority,
      fetch,
      ...(publicationTimeoutMs === undefined ? {} : { branchPublicationTimeoutMs: publicationTimeoutMs }),
    }),
    request: request({
      repository,
      expectedHeadSha: head,
      baseBranch: "main",
      branchName,
      commitMessage: "Add bounded evidence",
      changes,
    }),
  };
}

test("bounds cached publication reads and writes before ordered visibility", async () => {
  assert.equal(GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS, 230_000);
  assert.ok(GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS < 240_000);
  let releaseReads;
  const readsMayFinish = new Promise((resolve) => { releaseReads = resolve; });
  let fourReadsStarted;
  const fourReads = new Promise((resolve) => { fourReadsStarted = resolve; });
  let releaseWrites;
  const writesMayFinish = new Promise((resolve) => { releaseWrites = resolve; });
  let fourWritesStarted;
  const fourWrites = new Promise((resolve) => { fourWritesStarted = resolve; });
  let activeReads = 0;
  let completedReads = 0;
  let maxReads = 0;
  let activeWrites = 0;
  let maxWrites = 0;
  const base = fixture({
    branchName: "codeops/bounded-publication",
    writeBlob: async ({ index }) => {
      assert.equal(completedReads, base.changes.length);
      activeWrites += 1;
      maxWrites = Math.max(maxWrites, activeWrites);
      if (activeWrites === 4) fourWritesStarted();
      await writesMayFinish;
      activeWrites -= 1;
      return json({ sha: createHash("sha1").update(`blob-${index}`).digest("hex") }, 201);
    },
  });
  const directoryPaths = new Set(Array.from({ length: 8 }, (_, index) =>
    `/repos/anulman/codeops/git/trees/${createHash("sha1").update(`tree-${index}`).digest("hex")}`));
  const mutate = createGitHubMutationAdapter({
    resolve: () => authority,
    fetch: async (url, init) => {
      if ((init.method ?? "GET") === "GET" && directoryPaths.has(new URL(url).pathname)) {
        activeReads += 1;
        maxReads = Math.max(maxReads, activeReads);
        if (activeReads === 4) fourReadsStarted();
        await readsMayFinish;
        activeReads -= 1;
        completedReads += 1;
      }
      return base.fetch(url, init);
    },
  });
  const publication = mutate(base.request);
  await fourReads;
  assert.equal(maxReads, 4);
  assert.equal(base.calls.some(({ method }) => method === "POST"), false);
  releaseReads();
  await fourWrites;
  assert.equal(maxWrites, 4);
  releaseWrites();
  assert.equal((await publication).headSha, base.published);
  assert.equal(base.rootReads(), 1);
  assert.equal(completedReads, base.changes.length);
  assert.deepEqual(base.calls.slice(-4).map(({ method, path }) => [method, path.split("/").at(-1)]), [
    ["POST", "trees"], ["POST", "commits"], ["POST", "refs"], ["GET", "bounded-publication"],
  ]);
});

test("stops dequeuing on the first failure and drains started writes", async () => {
  let fail;
  const mayFail = new Promise((resolve) => { fail = resolve; });
  let drain;
  const mayDrain = new Promise((resolve) => { drain = resolve; });
  let fourStarted;
  const fourWrites = new Promise((resolve) => { fourStarted = resolve; });
  const started = [];
  const drained = [];
  const base = fixture({
    branchName: "codeops/rejected-publication",
    writeBlob: async ({ index }) => {
      started.push(index);
      if (started.length === 4) fourStarted();
      if (index === 0) {
        await mayFail;
        return json({ message: "rejected" }, 503);
      }
      await mayDrain;
      drained.push(index);
      if (index === 1) return json({ message: "later rejection" }, 502);
      return json({ sha: createHash("sha1").update(`blob-${index}`).digest("hex") }, 201);
    },
  });
  let settled = false;
  const publication = base.mutate(base.request).finally(() => { settled = true; });
  await fourWrites;
  assert.deepEqual(started, [0, 1, 2, 3]);
  fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(settled, false);
  drain();
  await assert.rejects(publication, /HTTP 503/);
  assert.deepEqual(drained.sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(base.calls.some(({ path }) => path.endsWith("/git/trees")), false);
  assert.equal(base.calls.some(({ path }) => path.endsWith("/git/refs")), false);
});

test("uses one deadline across delayed blob writes", async () => {
  const started = [];
  const base = fixture({
    branchName: "codeops/deadline-publication",
    publicationTimeoutMs: 40,
    writeBlob: ({ index, signal }) => new Promise((resolve, reject) => {
      started.push(index);
      const timer = setTimeout(() => {
        resolve(json({ sha: createHash("sha1").update(`blob-${index}`).digest("hex") }, 201));
      }, 50);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const startedAt = Date.now();
  await assert.rejects(base.mutate(base.request), /deadline exceeded/);
  assert.ok(Date.now() - startedAt < 400);
  assert.ok(started.length >= 4 && started.length < base.changes.length);
  assert.equal(base.calls.some(({ path }) => path.endsWith("/git/refs")), false);
});
