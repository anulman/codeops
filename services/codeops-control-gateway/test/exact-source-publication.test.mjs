import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { githubBranchPublishCandidateSchema, canonicalJsonText,
  sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { publishGitHubBranch } from "../dist/github-branch-publication.js";
import { createGitHubMutationReconciler } from "../dist/github-mutations-adapter.js";

const hashObject = (kind, bytes) => createHash("sha1")
  .update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
const blob = (text) => hashObject("blob", Buffer.from(text));
const tree = (entries) => hashObject("tree", Buffer.concat([...entries]
  .sort((a, b) => a.path.localeCompare(b.path)).map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, "hex"),
  ]))));
const baseSha = "a".repeat(40), headSha = "b".repeat(40);
const operationId = `githubmutation-${"c".repeat(64)}`;

function fixture() {
  const base = Array.from({ length: 11 }, (_, i) => ({ path: `existing-${i}.txt`,
    mode: i === 0 ? "100755" : "100644", type: "blob", sha: blob(`old ${i}`) }));
  const changes = [...base.map((entry, i) => ({ path: entry.path,
    oldText: "", newText: `new ${i}`, exact: {
      baseBlobSha: entry.sha, baseMode: entry.mode, mode: entry.mode,
    } })), ...Array.from({ length: 13 }, (_, i) => ({ path: `added-${i}.txt`,
    oldText: "", newText: i === 0 ? "" : `added ${i}`, exact: {
      baseBlobSha: null, baseMode: null, mode: "100644",
    } }))];
  const result = changes.map((change) => ({ path: change.path, mode: change.exact.mode,
    type: "blob", sha: blob(change.newText) }));
  const binding = { repository: "example/project", baseSha,
    baseTreeSha: tree(base), treeSha: tree(result) };
  const originalBaseTreeSha = binding.baseTreeSha;
  const candidate = githubBranchPublishCandidateSchema.parse({
    version: "codeops.github-branch-publish-candidate/v1", binding, changes,
  });
  const metadata = { repository: binding.repository, expectedHeadSha: baseSha,
    mode: "create", baseBranch: "main", branchName: "recovered-source",
    commitMessage: "Publish recovered source", candidate: {
      manifestId: `githubcandidate-${"d".repeat(64)}`,
      digest: sha256CanonicalJsonDigest(candidate),
      sizeBytes: Buffer.byteLength(canonicalJsonText(candidate)), chunkCount: 1,
    } };
  const request = { version: "codeops.github-mutation-provider-request/v1",
    operation: "branch_publish", operationId, input: metadata,
    payloadDigest: sha256CanonicalJsonDigest(metadata),
    permissionDigest: sha256CanonicalJsonDigest({ kind: "github_mutation",
      repository: binding.repository, operation: "branch_publish", pullRequestNumber: null,
      targetId: metadata.branchName, expectedHeadSha: baseSha, payloadJson: canonicalJsonText(metadata) }),
    provenance: { sessionId: "session-recovery", dispatchId: "11111111-1111-4111-8111-111111111111",
      admissionId: "22222222-2222-4222-8222-222222222222", sessionGeneration: 1,
      sessionLeaseId: "33333333-3333-4333-8333-333333333333", permissionRequestId: "recovery",
      authorizationExpiresAt: "2026-09-08T23:00:00.000Z", principalDigest: `sha256:${"e".repeat(64)}` },
  };
  let published = false, branchWrites = 0;
  const ref = (name, sha) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
  const provider = {
    readBranch: async (name) => name === "main" ? ref(name, baseSha) :
      published ? ref(name, headSha) : null,
    readCommit: async () => ({ sha: baseSha, tree: { sha: originalBaseTreeSha } }),
    readTree: async () => ({ sha: originalBaseTreeSha, tree: base }),
    readBlob: async () => { throw Error("Exact publication does not use substring replacement"); },
    createBlob: async (content) => blob(content),
    createTree: async (sha, updates) => {
      assert.equal(sha, binding.baseTreeSha);
      assert.deepEqual([...updates].sort((a, b) => a.path.localeCompare(b.path)),
        [...result].sort((a, b) => a.path.localeCompare(b.path)));
      return tree(updates);
    },
    createCommit: async (_message, sha, parent) => {
      assert.equal(sha, binding.treeSha); assert.equal(parent, baseSha); return headSha;
    },
    createBranch: async () => { published = true; branchWrites++; },
  };
  return { candidate, request, provider, base, result, branchWrites: () => branchWrites,
    publish: () => publishGitHubBranch({ request, provider, changes: candidate.changes,
      binding: candidate.binding, preflight: (fn) => fn(), effectText: (id) => `codeops-provider-effect:${id}` }) };
}

test("publishes exact modifications plus additions, preserving executable and empty-file modes", async () => {
  const f = fixture();
  assert.equal(await f.publish(), headSha);
  assert.equal(f.branchWrites(), 1);
  await assert.rejects(f.publish(), /already exists/);
  assert.equal(f.branchWrites(), 1);
});

test("source, base, mode and result-tree drift cannot create a branch", async () => {
  for (const mutate of [
    (f) => { f.candidate.binding.baseSha = "f".repeat(40); },
    (f) => { f.candidate.binding.repository = "foreign/project"; },
    (f) => { f.candidate.binding.baseTreeSha = "f".repeat(40); },
    (f) => { f.candidate.binding.treeSha = "f".repeat(40); },
    (f) => { f.base[0].mode = "120000"; },
    (f) => { f.base[0].sha = "f".repeat(40); },
    (f) => { f.base.push({ path: "added-0.txt", mode: "120000", type: "blob", sha: blob("target") }); },
    (f) => { f.candidate.changes.at(-1).path = "parent/child.txt";
      f.base.push({ path: "parent", mode: "120000", type: "blob", sha: blob("outside") }); },
    (f) => { let reads = 0; const read = f.provider.readBranch;
      f.provider.readBranch = (name) => name === "main" && ++reads > 1
        ? Promise.resolve({ ref: "refs/heads/main", object: { type: "commit", sha: headSha } }) : read(name); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.publish());
    assert.equal(f.branchWrites(), 0);
  }
});

test("exact candidate contracts deny traversal, duplicates, prefixes, special modes and mixed evidence", () => {
  for (const mutate of [
    (c) => { c.changes[0].path = "../outside"; },
    (c) => { c.changes[0].path = ".git/config"; },
    (c) => { c.changes[0].path = "bad\0path"; },
    (c) => { c.changes[1].path = c.changes[0].path; },
    (c) => { c.changes[1].path = `${c.changes[0].path}/child`; },
    (c) => { c.changes[0].exact.mode = "120000"; },
    (c) => { c.changes[0].exact.baseMode = null; },
    (c) => { delete c.changes[0].exact; },
    (c) => { delete c.binding; },
    (c) => { c.changes[0].oldText = "old"; },
    (c) => { c.approved = true; },
    (c) => { c.changes[0].delete = true; },
    (c) => { c.changes[0].newText = "invalid\ud800"; },
    (c) => { c.changes[0].newText = "binary\0bytes"; },
  ]) {
    const c = fixture().candidate; mutate(c);
    assert.equal(githubBranchPublishCandidateSchema.safeParse(c).success, false);
  }
});

test("unknown branch outcomes reconcile only the exact marker, parent and entire source tree", async () => {
  for (const drift of ["none", "tree", "parent", "marker", "mode", "missing"]) {
    const f = fixture();
    const baseTree = f.candidate.binding.baseTreeSha, resultTree = f.candidate.binding.treeSha;
    const observed = structuredClone(f.result);
    if (drift === "mode") observed[0].mode = "100644";
    const reconcile = createGitHubMutationReconciler({
      resolve: () => ({ repository: "example/project", repositoryUrl: "https://github.com/example/project.git",
        readToken: "test-read-token", writeToken: "test-write-token" }),
      loadBranchCandidate: async () => f.candidate,
      fetch: async (url, init) => {
        assert.ok(!init?.method || init.method === "GET");
        const p = new URL(url).pathname;
        let body;
        if (p.includes("/git/ref/")) {
          if (drift === "missing") return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
          body = { ref: "refs/heads/recovered-source", object: { sha: headSha, type: "commit" } };
        } else if (p.endsWith(`/commits/${baseSha}`)) body = { sha: baseSha,
          tree: { sha: baseTree }, parents: [], message: "Base" };
        else if (p.endsWith(`/commits/${headSha}`)) body = { sha: headSha,
          tree: { sha: drift === "tree" ? "f".repeat(40) : resultTree },
          parents: [{ sha: drift === "parent" ? headSha : baseSha }],
          message: `Publish recovered source\n\ncodeops-provider-effect:${drift === "marker" ? "foreign" : operationId}` };
        else if (p.endsWith(`/trees/${baseTree}`)) body = { sha: baseTree, tree: f.base, truncated: false };
        else if (p.endsWith(`/trees/${resultTree}`)) body = { sha: resultTree, tree: observed, truncated: false };
        else throw Error(`Unexpected provider read ${p}`);
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      },
    });
    const result = await reconcile(f.request, new Date("2026-09-08T01:00:00Z"), new Date("2026-09-08T02:00:00Z"));
    assert.equal(result.state, drift === "none" ? "reconciled_satisfied" :
      drift === "missing" ? "reconciled_not_observed" : "unknown");
  }
});
