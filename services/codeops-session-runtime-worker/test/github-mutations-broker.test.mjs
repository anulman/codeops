import assert from "node:assert/strict";
import test from "node:test";
import { GitHubMutationsBroker } from "../dist/github-mutations-broker.js";

const dispatch = {
  dispatchId: "11111111-1111-4111-8111-111111111111",
  command: { type: "prompt" },
};
const repository = "anulman/codeops";
const expectedHeadSha = "a".repeat(40);

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
