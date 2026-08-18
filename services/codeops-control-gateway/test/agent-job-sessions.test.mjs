import assert from "node:assert/strict";
import test from "node:test";
import {
  agentJobSessionId,
  describeAgentJobSession,
} from "../dist/agent-job-sessions.js";

const adoptedPullRequest = {
  version: "codeops.adopted-pull-request/v1",
  repository: "example-org/example-repository",
  pullRequestNumber: 158,
  headSha: "b".repeat(40),
  headRef: "feat/existing-pr",
  baseSha: "a".repeat(40),
  baseRef: "main",
  title: "Review the exact existing PR",
  url: "https://github.com/example-org/example-repository/pull/158",
  adoptedAt: "2026-08-18T07:00:00.000Z",
  sessionOwnerPrincipalId: "access:aidan@example.com",
  rationale: "Run the exact PR head through the existing critic loop.",
};

function request(role, round) {
  return {
    role,
    workItemId: "22222222-2222-4222-8222-222222222222",
    workflowId: "adopt-pr-158",
    baseSha: adoptedPullRequest.headSha,
    codingRound: round,
    codingRequest: { adoptedPullRequest },
  };
}

test("describes visible deterministic work-item and reviewer sessions for adopted PR jobs", () => {
  const worker = describeAgentJobSession(request("coding-agent", 1), "worker-run");
  const reviewer = describeAgentJobSession(request("critic-agent", 1), "critic-run");
  assert.equal(worker.sessionId, agentJobSessionId("worker-run"));
  assert.equal(worker.ownerPrincipalId, "access:aidan@example.com");
  assert.equal(worker.identity.agentRole, "coding");
  assert.equal(worker.identity.pullRequestHeadSha, adoptedPullRequest.headSha);
  assert.match(worker.identity.displayName, /PR #158 · Work Item Session/);
  assert.equal(reviewer.identity.agentRole, "critic");
  assert.match(reviewer.identity.displayName, /PR #158 · Reviewer Session/);
  assert.notEqual(worker.sessionId, reviewer.sessionId);
});

test("does not project unrelated Agent Jobs", () => {
  assert.equal(
    describeAgentJobSession(
      { role: "qa-contract-researcher", codingRequest: {} },
      "research-run",
    ),
    null,
  );
  assert.equal(
    describeAgentJobSession(
      { role: "coding-agent", codingRequest: {} },
      "new-ticket-run",
    ),
    null,
  );
});
