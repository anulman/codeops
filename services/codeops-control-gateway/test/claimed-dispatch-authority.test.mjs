import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaimedDispatchAuthorityConflictError,
  loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource,
  validateClaimedDispatchAuthority,
} from "../dist/claimed-dispatch-authority.js";

const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const workerId = "acp-worker:primary";
const repository = "anulman/codeops";
const resolvedSha = "a".repeat(40);

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "session-authority",
    generation: 1,
    state: "running",
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: {
        version: "codeops.session-policy/v1",
        mode: "review",
        workspaceAccess: "read-only",
        modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      workspace: {
        version: "codeops.workspace/v1",
        sources: [{
          catalogKey: "codeops",
          repository,
          checkoutPath: "sources/codeops",
          requestedRef: "main",
          resolvedSha,
        }],
        scratchPath: "scratch",
      },
      workflowId: "workspace-launch",
      runId: "launch-authority",
      displayName: "Inspect CodeOps",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "runtime-worker",
      acquiredAt: "2026-08-15T10:00:00.000Z",
      expiresAt: "2026-08-15T12:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 2,
    capabilities: capabilities(),
    updatedAt: "2026-08-15T10:01:00.000Z",
    ...overrides,
  };
}

function dispatch(overrides = {}) {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "session-authority",
      generation: 1,
      leaseId,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      type: "prompt",
      prompt: "Inspect the exact source.",
    },
    snapshot: snapshot(),
    dispatchedAt: "2026-08-15T10:01:00.000Z",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    dispatch_json: dispatch(),
    status: "claimed",
    claim_token: claimToken,
    claimed_by: workerId,
    claim_expires_at: "2026-08-15T11:00:00.000Z",
    ...overrides,
  };
}

const input = {
  dispatchId,
  workerId,
  claimToken,
  now: new Date("2026-08-15T10:05:00.000Z"),
};

test("loads one immutable authority and selects the exact workspace source", async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [row()] };
    },
  };
  const authority = await loadClaimedDispatchAuthority(client, {
    dispatchId,
    workerId,
    claimToken,
    now: () => input.now,
  });
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.dispatch), true);
  assert.equal(Object.isFrozen(authority.snapshot.identity), true);
  assert.equal(authority.dispatch.command.sessionId, "session-authority");
  assert.equal(calls[0].values[0], dispatchId);
  assert.match(calls[0].text, /FROM codeops\.session_runtime_outbox/);
  const source = selectClaimedWorkspaceSource(authority, { repository, resolvedSha });
  assert.equal(Object.isFrozen(source), true);
  assert.equal(source.catalogKey, "codeops");
});

test("fails closed on claim and immutable authority drift", () => {
  const cases = [
    { workerId: "worker with spaces" },
    { claimToken: "55555555-5555-4555-8555-555555555555" },
    { row: { claimed_by: "acp-worker:other" } },
    { row: { claim_expires_at: "not-a-time" } },
    { row: { claim_expires_at: "2026-08-15T10:05:00.000Z" } },
    { dispatchId: "55555555-5555-4555-8555-555555555555" },
    { row: { dispatch_json: dispatch({
      command: { ...dispatch().command, type: "cancel", reason: "drift" },
    }) } },
    { row: { dispatch_json: dispatch({
      command: { ...dispatch().command, generation: 2 },
    }) } },
    { row: { dispatch_json: dispatch({
      command: {
        ...dispatch().command,
        leaseId: "55555555-5555-4555-8555-555555555555",
      },
    }) } },
    { sessionSnapshot: snapshot({ eventCursor: 3 }) },
  ];
  for (const mutation of cases) {
    const { row: rowOverride, ...inputOverride } = mutation;
    assert.throws(
      () => validateClaimedDispatchAuthority(
        row(rowOverride),
        { ...input, ...inputOverride },
      ),
      ClaimedDispatchAuthorityConflictError,
    );
  }
});

test("fails closed on repository and source SHA drift", () => {
  const authority = validateClaimedDispatchAuthority(row(), input);
  assert.throws(
    () => selectClaimedWorkspaceSource(authority, { repository: "anulman/other" }),
    ClaimedDispatchAuthorityConflictError,
  );
  assert.throws(
    () => selectClaimedWorkspaceSource(authority, { repository, resolvedSha: "b".repeat(40) }),
    ClaimedDispatchAuthorityConflictError,
  );
});
