import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJsonText, sessionPermissionOperationSchema, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { createGitHubMutationAdapter, createGitHubMutationReconciler } from "../dist/github-branch-fast-forward.js";

const repository = "anulman/codeops", base = "a".repeat(40), prior = "b".repeat(40), priorTree = "c".repeat(40);
const published = "d".repeat(40), publishedTree = "e".repeat(40), branchName = "codeops/bootstrap";
const priorEffect = `githubmutation-${"1".repeat(64)}`, operationId = `githubmutation-${"2".repeat(64)}`;
const authority = { repository, repositoryUrl: `https://github.com/${repository}.git`, readToken: "unused", writeToken: "safe-write-token!" };
const value = {
  repository, mode: "fast_forward", expectedHeadSha: base, expectedBranchHeadSha: prior, expectedBranchHeadEffectId: priorEffect,
  baseBranch: "main", branchName, commitMessage: "Continue bootstrap",
  changes: [{ path: "proof.txt", oldText: "", newText: "proved\n" }],
};
const exactMessage = `Continue bootstrap\n\ncodeops-provider-effect:${operationId}`;

function request() {
  const permission = sessionPermissionOperationSchema.parse({
    kind: "github_mutation", repository, operation: "branch_publish", pullRequestNumber: null,
    targetId: branchName, expectedHeadSha: base, payloadJson: canonicalJsonText(value),
  });
  return {
    version: "codeops.github-mutation-provider-request/v1", operation: "branch_publish", operationId, input: value,
    payloadDigest: sha256CanonicalJsonDigest(value), permissionDigest: sha256CanonicalJsonDigest(permission),
    provenance: {
      sessionId: "session-bootstrap", dispatchId: "11111111-1111-4111-8111-111111111111", principalDigest: `sha256:${"3".repeat(64)}`,
    },
  };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const commit = (sha, message, tree, parent) => ({ sha, message, tree: { sha: tree }, parents: parent === null ? [] : [{ sha: parent }] });
const priorCommit = commit(prior, `Initial\n\ncodeops-provider-effect:${priorEffect}`, priorTree, base);
const publishedCommit = commit(published, exactMessage, publishedTree, prior);
const blobSha = (() => {
  const bytes = Buffer.from("proved\n");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
})();

function fixture({ replay = false, race = false, bad = false, ref = "refs/heads/codeops/bootstrap", type = "commit" } = {}) {
  const calls = [];
  let wrote = false;
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, url: String(url), path: parsed.pathname, body: init.body });
    if (method === "GET" && parsed.pathname.endsWith("/git/ref/heads/main")) {
      return json({ ref: "refs/heads/main", object: { sha: base, type: "commit" } });
    }
    if (method === "GET" && (parsed.pathname.endsWith("/git/ref/heads/codeops/bootstrap") || parsed.pathname.endsWith("/git/ref/heads/codeops%2Fbootstrap"))) {
      const sha = replay || wrote ? published : prior;
      return json({ ref, object: { sha, type } });
    }
    if (method === "GET" && parsed.pathname.endsWith(`/git/commits/${base}`)) return json(commit(base, "base", "f".repeat(40), null));
    if (method === "GET" && parsed.pathname.endsWith(`/git/commits/${prior}`)) return json(priorCommit);
    if (method === "GET" && parsed.pathname.endsWith(`/git/commits/${published}`)) return json(publishedCommit);
    if (method === "GET" && parsed.pathname.endsWith(`/git/trees/${priorTree}`)) return json({ sha: priorTree, truncated: false, tree: [] });
    if (method === "GET" && parsed.pathname.endsWith(`/git/trees/${publishedTree}`)) return json({ sha: publishedTree, truncated: false, tree: [{ path: "proof.txt", mode: "100644", type: "blob", sha: bad ? "f".repeat(40) : blobSha }] });
    if (method === "POST" && parsed.pathname === "/graphql") {
      if (race) return json({ data: { createCommitOnBranch: null }, errors: [{ type: "STALE_DATA" }] });
      wrote = true;
      return json({ data: { createCommitOnBranch: { commit: { oid: published, message: exactMessage, tree: { oid: publishedTree }, parents: { nodes: [{ oid: prior }] } } } } });
    }
    throw new Error(`Unexpected GitHub call: ${method} ${String(url)}`);
  };
  return { calls, fetch, mutate: createGitHubMutationAdapter({ resolve: () => authority, fetch }) };
}

async function reconcile(options, observedAt = 60_000) {
  const { fetch } = fixture(options);
  return createGitHubMutationReconciler({ resolve: () => authority, fetch })(request(), new Date(0), new Date(observedAt));
}

test("composes bounded preflight with one atomic expected-head fast-forward write", async () => {
  const { calls, mutate } = fixture();
  assert.equal((await mutate(request())).headSha, published);
  const write = calls.find(({ method }) => method === "POST");
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(write.url, "https://api.github.com/graphql");
  const input = JSON.parse(write.body).variables.input;
  assert.equal(input.expectedHeadOid, prior);
  assert.equal(JSON.stringify(input).includes(base), false);
  assert.equal(Buffer.from(input.fileChanges.additions[0].contents, "base64").toString(), "proved\n");
  assert.deepEqual(calls.slice(-3).map(({ method, path }) => [method, path]), [
    ["POST", "/graphql"],
    ["GET", `/repos/anulman/codeops/git/trees/${publishedTree}`],
    ["GET", "/repos/anulman/codeops/git/ref/heads/codeops/bootstrap"],
  ]);
});

test("rejects a wrong tree", async () => {
  await assert.rejects(fixture({ bad: true }).mutate(request()), /tree mismatch/);
});

test("replays only the exact single-parent message and complete requested tree", async () => {
  const { calls, mutate } = fixture({ replay: true });
  assert.equal((await mutate(request())).headSha, published);
  assert.equal(calls.some(({ method }) => method === "POST"), false);
  assert.equal(calls.filter(({ url }) => url.includes("recursive=1")).length, 2);
});

test("fails closed when GitHub loses the atomic expected-head compare-and-swap", async () => {
  const { calls, mutate } = fixture({ race: true });
  await assert.rejects(mutate(request()), /atomic target-branch publication failed/);
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(calls.filter(({ path }) => path.endsWith("/git/ref/heads/codeops/bootstrap")).length, 1);
});

test("reconciles only the exact fast-forward parent, message, and complete tree", async () => {
  const result = await reconcile({ replay: true }, 61_000);
  assert.equal(result.state, "reconciled_satisfied");
  assert.equal(result.result.headSha, published);
  assert.match(result.summary, /complete tree/);
});

test("reconciles the exact unchanged target as not observed only after the consistency window", async () => {
  assert.equal((await reconcile({}, 59_000)).state, "unknown");
  assert.equal((await reconcile({})).state, "reconciled_not_observed");
});

test("keeps wrong-ref unchanged evidence unknown", async () => {
  assert.equal((await reconcile({ ref: "refs/heads/other" })).state, "unknown");
});

test("keeps tag unchanged-head evidence unknown", async () => {
  assert.equal((await reconcile({ type: "tag" })).state, "unknown");
});
