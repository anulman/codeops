import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionForkComparison,
  renderForkSynthesisPrompt,
  submitSessionForkSynthesis,
} from "../src/lib/sessionForkComparison.server.ts";

const leaseId = "11111111-1111-4111-8111-111111111111";
const actions = ["prompt", "respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"];

function snapshot(sessionId, eventCursor, overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId,
    generation: 2,
    state: "running",
    identity: {
      repository: "example/repository",
      branch: `feat/${sessionId}`,
      baseSha: "a".repeat(40),
      workflowId: "workflow-forks",
      runId: `run-${sessionId}`,
      parentSessionId: "session-parent",
      forkedAtCursor: 4,
    },
    lease: {
      leaseId,
      generation: 2,
      status: "active",
      holderId: `worker-${sessionId}`,
      acquiredAt: "2026-08-14T18:00:00.000Z",
      expiresAt: "2026-08-14T19:00:00.000Z",
    },
    checkpoint: {
      version: "codeops.session-checkpoint/v1",
      checkpointId: sessionId === "session-a"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
      sessionId,
      generation: 2,
      baseSha: "a".repeat(40),
      patchDigest: `sha256:${sessionId === "session-a" ? "b" : "c"}`.padEnd(71, sessionId === "session-a" ? "b" : "c"),
      acpSessionId: `acp-${sessionId}`,
      eventCursor,
      evidenceReferences: [`evidence-${sessionId}`],
      createdAt: "2026-08-14T18:10:00.000Z",
    },
    pendingPermission: null,
    eventCursor,
    capabilities: actions.map((action) => action === "prompt"
      ? { action, availability: "enabled" }
      : { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-08-14T18:10:00.000Z",
    ...overrides,
  };
}

function event(sessionId, cursor, text) {
  return {
    version: "codeops.session-event/v1",
    eventId: `sha256:${(sessionId === "session-a" ? "d" : "e").repeat(64)}`,
    sessionId,
    generation: 2,
    cursor,
    type: "acp_update",
    message: { role: "assistant", text, stopReason: "end_turn" },
    occurredAt: "2026-08-14T18:10:00.000Z",
  };
}

function toolEvent(sessionId, cursor, overrides = {}) {
  return {
    version: "codeops.session-event/v1",
    eventId: `sha256:${"f".repeat(64)}`,
    sessionId,
    generation: 2,
    cursor,
    type: "acp_update",
    update: {
      kind: "tool_call_update",
      toolCallId: `tool-${sessionId}`,
      title: "Run focused tests",
      status: "completed",
      content: [{ type: "diff", path: "src/example.ts", oldText: "old", newText: "new text" }],
      ...overrides,
    },
    occurredAt: "2026-08-14T18:10:00.000Z",
  };
}

test("builds one stable canonical comparison from exact fork evidence", () => {
  const target = snapshot("session-target", 0, { checkpoint: null });
  const aSnapshot = snapshot("session-a", 2, { identity: { ...snapshot("session-a", 2).identity, workflowId: "workflow-a" } });
  const bSnapshot = snapshot("session-b", 1, { identity: { ...snapshot("session-b", 1).identity, workflowId: "workflow-b" } });
  const a = { snapshot: aSnapshot, afterCursor: 0, events: [event("session-a", 1, "Choose A because its proof is stronger."), toolEvent("session-a", 2)] };
  const b = { snapshot: bSnapshot, afterCursor: 0, events: [event("session-b", 1, "Choose B because it is smaller.")] };
  const comparison = buildSessionForkComparison({ target, candidates: [b, a] });
  assert.deepEqual(comparison.candidates.map(({ sessionId }) => sessionId), ["session-a", "session-b"]);
  assert.equal(comparison.candidates[0].latestConclusion, "Choose A because its proof is stronger.");
  assert.deepEqual(comparison.candidates[0].observedDiff, { fileCount: 1, byteCount: 11 });
  assert.deepEqual(comparison.candidates[0].eventWindow, { afterCursor: 0, eventCount: 2, truncated: false });
  assert.deepEqual(comparison.candidates[0].testEvidence, [{ label: "Run focused tests", status: "completed" }]);
  assert.deepEqual(comparison.candidates[0].riskSignals, []);
  assert.match(comparison.comparisonDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    buildSessionForkComparison({ target, candidates: [a, b] }).comparisonDigest,
    comparison.comparisonDigest,
  );
  const prompt = renderForkSynthesisPrompt(comparison);
  assert.match(prompt, new RegExp(comparison.comparisonDigest));
  assert.match(prompt, /recommendation.*trade-offs.*retained evidence.*rejected alternatives.*next action/s);
  assert.match(prompt, /behavior, observed diff size, test evidence, and risk signals/);
  assert.equal(comparison.candidates[0].workflowId, "workflow-a");
  assert.match(prompt, /Do not merge, release, deploy, or mutate GitHub/);
  assert.throws(() => renderForkSynthesisPrompt({ ...comparison, target: { ...comparison.target, eventCursor: 99 } }), /digest does not match/);
});

test("rejects lineage, cursor, target, count, and prompt-capability drift", () => {
  const target = snapshot("session-target", 0, { checkpoint: null });
  const exact = { snapshot: snapshot("session-a", 1), afterCursor: 0, events: [event("session-a", 1, "A")] };
  const second = { snapshot: snapshot("session-b", 1), afterCursor: 0, events: [event("session-b", 1, "B")] };
  assert.throws(() => buildSessionForkComparison({ target, candidates: [exact] }), /two to four/);
  assert.throws(() => buildSessionForkComparison({ target, candidates: [exact, { ...second, snapshot: snapshot("session-b", 1, { identity: { ...second.snapshot.identity, parentSessionId: "other-parent" } }) }] }), /lineage drifted/);
  assert.throws(() => buildSessionForkComparison({ target, candidates: [exact, { ...second, events: [] }] }), /cursor drifted/);
  assert.throws(() => buildSessionForkComparison({ target, candidates: [exact, { snapshot: target, afterCursor: 0, events: [] }] }), /cannot be the target/);
  assert.throws(() => buildSessionForkComparison({ target: snapshot("session-target", 0, { capabilities: actions.map((action) => ({ action, availability: "disabled", reason: "Unavailable." })) }), candidates: [exact, second] }), /prompt capability/);
  assert.throws(() => buildSessionForkComparison({ target: snapshot("session-target", 0, { identity: { ...target.identity, parentSessionId: null, forkedAtCursor: null } }), candidates: [exact, second] }), /explicit child/);
});

test("loads exact candidate evidence and submits one identity-bound synthesis prompt", async () => {
  const target = snapshot("session-target", 0, { checkpoint: null });
  const a = snapshot("session-a", 501);
  const b = snapshot("session-b", 1);
  const calls = [];
  const broker = {
    async listSessions() { return []; },
    async getSession(sessionId) {
      return [target, a, b].find((item) => item.sessionId === sessionId) ?? null;
    },
    async getEvents(input) {
      calls.push({ kind: "events", input });
      const events = input.sessionId === "session-a"
        ? Array.from({ length: 500 }, (_, index) => event(input.sessionId, index + 2, `Conclusion ${index + 2}.`))
        : [event(input.sessionId, 1, `Conclusion for ${input.sessionId}.`)];
      return {
        sessionId: input.sessionId,
        afterCursor: input.afterCursor,
        nextCursor: input.sessionId === "session-a" ? 501 : 1,
        events,
      };
    },
    async executeCommand(input) {
      calls.push({ kind: "command", input });
      return {
        version: "codeops.session-command-accepted/v1",
        disposition: "accepted",
        dispatchId: "44444444-4444-4444-8444-444444444444",
        sessionId: input.command.sessionId,
        generation: input.command.generation,
        leaseId: input.command.leaseId,
        idempotencyKey: input.command.idempotencyKey,
        type: input.command.type,
      };
    },
  };
  const result = await submitSessionForkSynthesis({
    broker,
    principalId: "operator@example.com",
    targetSessionId: target.sessionId,
    candidateSessionIds: [b.sessionId, a.sessionId],
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
  });
  assert.deepEqual(calls.filter(({ kind }) => kind === "events").map(({ input }) => input), [
    { sessionId: "session-b", afterCursor: 0, limit: 500 },
    { sessionId: "session-a", afterCursor: 1, limit: 500 },
  ]);
  const command = calls.find(({ kind }) => kind === "command").input;
  assert.equal(command.principalId, "operator@example.com");
  assert.equal(command.command.sessionId, target.sessionId);
  assert.equal(command.command.idempotencyKey, "55555555-5555-4555-8555-555555555555");
  assert.match(command.command.prompt, new RegExp(result.comparison.comparisonDigest));
  assert.deepEqual(result.comparison.candidates.map(({ sessionId }) => sessionId), ["session-a", "session-b"]);
  assert.deepEqual(result.comparison.candidates[0].eventWindow, { afterCursor: 1, eventCount: 500, truncated: true });
});
