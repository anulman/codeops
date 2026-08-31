import assert from "node:assert/strict";
import test from "node:test";
import { GitHubMutationsBroker } from "../dist/github-mutations-broker.js";

const dispatch = {
  dispatchId: "11111111-1111-4111-8111-111111111111",
  principalId: "operator@example.com",
  command: { type: "prompt", sessionId: "session-github" },
};
const repository = "anulman/codeops";
const expectedHeadSha = "a".repeat(40);

test("links the trusted Plane reference before permission and provider identity", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  const trustedDispatch = {
    ...dispatch,
    snapshot: {
      identity: {
        version: "codeops.temporal-session-identity/v2",
        planeWorkItem: {
          version: "codeops.trusted-plane-work-item-reference/v1",
          apiOrigin: "https://plane.example.com/",
          workspaceSlug: "engineering",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          projectIdentifier: "COAUTO",
          workItemId: "33333333-3333-4333-8333-333333333333",
          sequenceId: 19,
          reference: "COAUTO-19",
        },
      },
    },
  };
  const observed = [];
  try {
    await broker.run(trustedDispatch, {
      async requestPermission(input) {
        observed.push(JSON.parse(input.request.operation.payloadJson));
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async mutateGitHub(input) {
        observed.push(input.input);
        return {
          version: "codeops.github-pull-request-create-result/v1",
          repository,
          operationId: input.operationId,
          pullRequestNumber: 94,
          headSha: input.input.expectedHeadSha,
          baseSha: input.input.expectedBaseSha,
          headBranch: input.input.headBranch,
          baseBranch: input.input.baseBranch,
          title: input.input.title,
          body: input.input.body,
          draft: input.input.draft,
          url: "https://github.com/anulman/codeops/pull/94",
        };
      },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/pull-request/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository,
          expectedHeadSha,
          expectedBaseSha: "b".repeat(40),
          headBranch: "codeops/trusted-plane-link",
          baseBranch: "main",
          title: "Link COAUTO-19",
          body: "Fixes COAUTO-19 and `COAUTO-19`.",
          draft: true,
        }),
      });
      assert.equal(response.status, 200);
    });
    const expected = "Fixes [COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19) and `COAUTO-19`.";
    assert.equal(observed[0].body, expected);
    assert.equal(observed[1].body, expected);
  } finally {
    await broker.close();
  }
});

test("gates each bounded mutation on one exact allow-once decision", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  const permissions = [];
  const mutations = [];
  try {
    await broker.run(dispatch, {
      async requestPermission(input) {
        permissions.push(input.request);
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async mutateGitHub(input) {
        mutations.push(input);
        return {
          version: "codeops.github-check-rerun-result/v1",
          repository,
          operationId: input.operationId,
          headSha: expectedHeadSha,
          checkRunId: input.input.checkRunId,
          accepted: true,
        };
      },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/check/rerun`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, expectedHeadSha, checkRunId: 1234 }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).accepted, true);
    });
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].operation.kind, "github_mutation");
    assert.equal(permissions[0].operation.operation, "check_rerun");
    assert.equal(permissions[0].operation.expectedHeadSha, expectedHeadSha);
    assert.equal(permissions[0].operation.targetId, "1234");
    assert.match(permissions[0].operationDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(mutations[0].operationId, /^githubmutation-[0-9a-f]{64}$/);
  } finally {
    await broker.close();
  }
});

test("binds branch publication permission to the target and stores the immutable candidate", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  const permissions = [];
  const candidates = [];
  const publishedHead = "b".repeat(40);
  try {
    await broker.run(dispatch, {
      async storeGitHubBranchCandidate(input) { candidates.push(input); },
      async requestPermission(input) {
        permissions.push(input.request);
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async mutateGitHub(input) {
        return {
          version: "codeops.github-branch-publish-result/v1",
          repository,
          operationId: input.operationId,
          baseBranch: input.input.baseBranch,
          branchName: input.input.branchName,
          baseSha: input.input.expectedHeadSha,
          headSha: publishedHead,
          url: "https://github.com/anulman/codeops/tree/codeops%2Falpha34-consumer",
        };
      },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/branch/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository,
          expectedHeadSha,
          baseBranch: "main",
          branchName: "codeops/alpha34-consumer",
          commitMessage: "Repin CodeOps alpha.34",
          changes: [{ path: "package.json", oldText: "alpha.33", newText: "alpha.34" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).headSha, publishedHead);
    });
    assert.equal(permissions[0].operation.operation, "branch_publish");
    assert.equal(permissions[0].operation.targetId, "codeops/alpha34-consumer");
    assert.doesNotMatch(permissions[0].operation.payloadJson, /alpha\.33/);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].chunks.length, 1);
    assert.equal(
      JSON.parse(permissions[0].operation.payloadJson).candidate.manifestId,
      candidates[0].manifest.candidate.manifestId,
    );
    assert.match(Buffer.from(candidates[0].chunks[0].bytesBase64, "base64").toString(), /alpha\.33/);
  } finally {
    await broker.close();
  }
});

test("normalizes inline publication before every candidate and effect identity", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  const candidates = [];
  const permissions = [];
  const mutations = [];
  const normalizedMessage = "Publish  the exact candidate";
  const publication = (commitMessage) => ({
    repository,
    expectedHeadSha,
    baseBranch: "main",
    branchName: "codeops/normalized-candidate",
    commitMessage,
    changes: [{ path: "proof.txt", oldText: "before\n", newText: "after\n" }],
  });
  try {
    await broker.run(dispatch, {
      async storeGitHubBranchCandidate(input) { candidates.push(input); },
      async requestPermission(input) {
        permissions.push(input.request);
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async mutateGitHub(input) {
        mutations.push(input);
        return {
          version: "codeops.github-branch-publish-result/v1",
          repository,
          operationId: input.operationId,
          baseBranch: input.input.baseBranch,
          branchName: input.input.branchName,
          baseSha: input.input.expectedHeadSha,
          headSha: "b".repeat(40),
          url: "https://github.com/anulman/codeops/tree/codeops%2Fnormalized-candidate",
        };
      },
    }, async () => {
      for (const commitMessage of [` \t${normalizedMessage}\n`, normalizedMessage]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/github-mutations/branch/publish`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(publication(commitMessage)),
          },
        );
        assert.equal(response.status, 200);
      }
    });
    assert.equal(candidates.length, 2);
    assert.equal(mutations.length, 2);
    assert.equal(permissions.length, 2);
    assert.equal(mutations[0].operationId, mutations[1].operationId);
    assert.deepEqual(mutations[0].input, mutations[1].input);
    assert.equal(mutations[0].input.commitMessage, normalizedMessage);
    assert.deepEqual(candidates[0], candidates[1]);
    assert.equal(candidates[0].manifest.effectDigest,
      candidates[1].manifest.effectDigest);
    assert.equal(candidates[0].manifest.candidate.manifestId,
      candidates[1].manifest.candidate.manifestId);
    assert.equal(permissions[0].operation.payloadJson,
      permissions[1].operation.payloadJson);
    assert.equal(JSON.parse(permissions[0].operation.payloadJson).commitMessage,
      normalizedMessage);
  } finally {
    await broker.close();
  }
});

test("relays a large branch candidate as bounded chunks", async () => {
  const branchPublicationInputAtBytes = (targetBytes) => {
    const input = {
      repository,
      expectedHeadSha,
      baseBranch: "main",
      branchName: "codeops/capacity-boundary",
      commitMessage: "Exercise branch publication capacity",
      changes: Array.from({ length: 3 }, (_, index) => ({
        path: `capacity-${index}.txt`,
        oldText: "",
        newText: "x",
      })),
    };
    let remaining = targetBytes - Buffer.byteLength(JSON.stringify(input));
    for (const change of input.changes) {
      const added = Math.min(remaining, 100_000 - change.newText.length);
      change.newText += "x".repeat(added);
      remaining -= added;
    }
    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(input)), targetBytes);
    return input;
  };
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  const mutations = [];
  const candidates = [];
  try {
    await broker.run(dispatch, {
      async storeGitHubBranchCandidate(input) { candidates.push(input); },
      async requestPermission() {
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async mutateGitHub(input) {
        mutations.push(input);
        return {
          version: "codeops.github-branch-publish-result/v1",
          repository,
          operationId: input.operationId,
          baseBranch: input.input.baseBranch,
          branchName: input.input.branchName,
          baseSha: input.input.expectedHeadSha,
          headSha: "b".repeat(40),
          url: "https://github.com/anulman/codeops/tree/codeops%2Fcapacity-boundary",
        };
      },
    }, async () => {
      const atLimit = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/branch/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(branchPublicationInputAtBytes(300_000)),
      });
      assert.equal(atLimit.status, 200);
    });
    assert.equal(mutations.length, 1);
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0].chunks.length > 1);
    assert.ok(candidates[0].chunks.every((chunk) =>
      Buffer.from(chunk.bytesBase64, "base64").length <= 65_536));
  } finally {
    await broker.close();
  }
});

test("denial stops before the GitHub provider boundary", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  let mutationCalls = 0;
  try {
    await broker.run(dispatch, {
      async requestPermission() { return { outcome: "denied" }; },
      async mutateGitHub() { mutationCalls += 1; throw new Error("unexpected"); },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/pull-request/update-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, pullRequestNumber: 27, expectedHeadSha }),
      });
      assert.equal(response.status, 403);
    });
    assert.equal(mutationCalls, 0);
  } finally {
    await broker.close();
  }
});

test("rejects inactive, unknown, and unbounded mutation requests", async () => {
  const broker = new GitHubMutationsBroker();
  const port = await broker.listen(0);
  try {
    const inactive = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/check/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository, expectedHeadSha, checkRunId: 1 }),
    });
    assert.equal(inactive.status, 409);
    await broker.run(dispatch, {
      async requestPermission() { throw new Error("unexpected"); },
      async mutateGitHub() { throw new Error("unexpected"); },
    }, async () => {
      const invalid = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/pull-request/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, pullRequestNumber: 27, expectedHeadSha }),
      });
      assert.equal(invalid.status, 503);
      const unknown = await fetch(`http://127.0.0.1:${port}/v1/github-mutations/pull-request/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(unknown.status, 404);
    });
  } finally {
    await broker.close();
  }
});
