import assert from "node:assert/strict";
import test from "node:test";
import {
  agentJobSessionId,
  describeAgentJobSession,
  projectAgentJobSessionStarted,
  projectAgentJobSessionTerminal,
} from "../dist/agent-job-sessions.js";
import { agentJobModelBudgetAuthority } from "../dist/agent-job-identity.js";

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
    summary: "Review the exact existing PR",
    codingRequest: {
      adoptedPullRequest,
      projectContext: { digest: `sha256:${"c".repeat(64)}` },
      researchDisposition: {
        mode: "skipped",
        rationale: "The ticket is bounded.",
      },
      workItem: { acceptanceCriteria: ["Review the exact existing PR."] },
    },
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
  assert.deepEqual(
    agentJobModelBudgetAuthority(request("critic-agent", 1), "critic-run"),
    { budgetId: reviewer.sessionId, generation: 1 },
  );
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

test("persists the projected Job prompt as one command-bound event", async () => {
  const calls = [];
  let snapshot;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO codeops.sessions")) {
        snapshot = JSON.parse(values[3]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT snapshot_json FROM codeops.sessions")) {
        return { rowCount: 1, rows: [{ snapshot_json: snapshot }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const sessionId = await projectAgentJobSessionStarted({
    client,
    request: request("coding-agent", 1),
    runId: "worker-run",
    now: () => new Date("2026-08-18T08:30:00.000Z"),
  });

  assert.equal(sessionId, agentJobSessionId("worker-run"));
  const command = calls.find(({ sql }) =>
    sql.includes("INSERT INTO codeops.session_commands"),
  );
  const promptEvent = calls.find(
    ({ sql, values }) =>
      sql.includes("INSERT INTO codeops.session_events") &&
      values[2] === "command_committed",
  );
  assert.ok(command);
  assert.ok(promptEvent);
  assert.equal(promptEvent.values[4], command.values[0]);
  assert.equal(JSON.parse(command.values[3]).type, "prompt");
  assert.equal(JSON.parse(command.values[4]).disposition, "committed");
});

test("persists adopted Agent terminal output as bounded commandless progress", async () => {
  const calls = [];
  let snapshot;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO codeops.sessions")) {
        snapshot = JSON.parse(values[3]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT snapshot_json FROM codeops.sessions")) {
        return { rowCount: 1, rows: [{ snapshot_json: snapshot }] };
      }
      if (sql.includes("UPDATE codeops.sessions")) {
        snapshot = JSON.parse(values[1]);
      }
      return { rowCount: 1, rows: [] };
    },
  };

  await projectAgentJobSessionStarted({
    client,
    request: request("coding-agent", 1),
    runId: "worker-terminal-run",
    now: () => new Date("2026-08-18T08:30:00.000Z"),
  });
  await projectAgentJobSessionTerminal({
    client,
    request: request("coding-agent", 1),
    runId: "worker-terminal-run",
    response: "Focused and complete verification passed.",
    state: "completed",
    now: () => new Date("2026-08-18T08:45:00.000Z"),
  });

  const terminalEvents = calls.filter(
    ({ sql, values }) =>
      sql.includes("INSERT INTO codeops.session_events") &&
      ["acp_update", "state_changed"].includes(values[4]),
  );
  assert.equal(terminalEvents.length, 2);
  assert.ok(terminalEvents.every(({ sql }) => /NULL/.test(sql)));
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.eventCursor, 4);
});
