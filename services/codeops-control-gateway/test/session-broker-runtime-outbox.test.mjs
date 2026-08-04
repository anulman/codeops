import assert from "node:assert/strict";
import test from "node:test";
import {
  ImmutableSessionRuntimeDispatchConflictError,
  claimSessionRuntimeDispatch,
  enqueueSessionRuntimeDispatch,
} from "../dist/session-broker-runtime-outbox.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";

function snapshot() {
  const enabled = new Set(["prompt", "cancel", "checkpoint", "hibernate"]);
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
    generation: 3,
    state: "running",
    identity: {
      repository: "anulman/renoconcierge",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "workflow-155",
      runId: "run-155",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 3,
      status: "active",
      holderId: "worker-3",
      acquiredAt: "2026-08-04T17:30:00.000Z",
      expiresAt: "2026-08-04T18:30:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: [
      "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
      "resume", "fork", "archive", "delete",
    ].map((action) => enabled.has(action)
      ? { action, availability: "enabled" }
      : { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-08-04T17:40:00.000Z",
  };
}

function command(overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "prompt",
    prompt: "Continue the focused implementation.",
    ...overrides,
  };
}

class EnqueueClient {
  constructor(existing = null, committed = null) {
    this.existing = existing;
    this.committed = committed;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: snapshot() }] };
    }
    if (text.includes("FROM codeops.session_commands")) {
      return {
        rowCount: this.committed ? 1 : 0,
        rows: this.committed ? [{ command_json: this.committed }] : [],
      };
    }
    if (text.includes("FROM codeops.session_runtime_outbox")) {
      return {
        rowCount: this.existing ? 1 : 0,
        rows: this.existing ? [{ dispatch_json: this.existing }] : [],
      };
    }
    return { rowCount: 1, rows: [] };
  }
}

const enqueue = (client, overrides = {}) => enqueueSessionRuntimeDispatch(client, {
  command: command(),
  principalId: "access:aidan@example.com",
  now: () => new Date("2026-08-04T18:00:00.000Z"),
  dispatchId: () => dispatchId,
  ...overrides,
});

test("atomically enqueues one exact immutable runtime dispatch", async () => {
  const client = new EnqueueClient();
  const dispatch = await enqueue(client);
  assert.equal(dispatch.dispatchId, dispatchId);
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[2].text, /session_commands[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /session_runtime_outbox[\s\S]*FOR UPDATE/);
  const insert = client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_runtime_outbox"));
  assert.deepEqual(insert.values.slice(0, 4), [
    dispatchId,
    "ses_91a4",
    idempotencyKey,
    "access:aidan@example.com",
  ]);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("shares one immutable idempotency namespace with committed commands", async () => {
  const client = new EnqueueClient(null, command());
  await assert.rejects(enqueue(client), ImmutableSessionRuntimeDispatchConflictError);
  assert.equal(
    client.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
    false,
  );
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("replays an exact outbox identity and rejects immutable conflicts", async () => {
  const original = await enqueue(new EnqueueClient());
  const replayClient = new EnqueueClient(original);
  assert.equal((await enqueue(replayClient)).dispatchId, original.dispatchId);
  assert.equal(
    replayClient.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
    false,
  );

  const conflictClient = new EnqueueClient(original);
  await assert.rejects(
    enqueue(conflictClient, { command: command({ prompt: "Different." }) }),
    ImmutableSessionRuntimeDispatchConflictError,
  );
  assert.equal(conflictClient.calls.at(-1).text, "ROLLBACK");
});

test("fails before enqueue when the exact generation, lease, or capability drifted", async () => {
  for (const drift of [
    { generation: 2 },
    { leaseId: "99999999-9999-4999-8999-999999999999" },
    { type: "resume", checkpointId: "22222222-2222-4222-8222-222222222222", prompt: undefined },
  ]) {
    const client = new EnqueueClient();
    await assert.rejects(enqueue(client, { command: command(drift) }));
    assert.equal(
      client.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
      false,
    );
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});

class ClaimClient {
  constructor(row) {
    this.row = row;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    return { rowCount: this.row ? 1 : 0, rows: this.row ? [this.row] : [] };
  }
}

test("claims one pending or expired dispatch with a bounded renewable lease", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 2,
  });
  const claim = await claimSessionRuntimeDispatch(client, {
    workerId: "acp-worker:7",
    leaseMs: 5 * 60_000,
    now: () => new Date("2026-08-04T18:00:00.000Z"),
    claimToken: () => claimToken,
  });
  assert.equal(claim.dispatch.dispatchId, dispatchId);
  assert.equal(claim.claimToken, claimToken);
  assert.equal(claim.claimCount, 2);
  assert.match(client.calls[0].text, /FOR UPDATE SKIP LOCKED/);
  assert.match(client.calls[0].text, /status = 'pending'/);
  assert.match(client.calls[0].text, /claim_expires_at <= \$1/);
  assert.match(client.calls[0].text, /claim_count = outbox\.claim_count \+ 1/);
  assert.deepEqual(client.calls[0].values, [
    "2026-08-04T18:00:00.000Z",
    claimToken,
    "acp-worker:7",
    "2026-08-04T18:05:00.000Z",
  ]);
});

test("returns null when no dispatch is claimable and validates claim bounds", async () => {
  assert.equal(await claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "acp-worker:7",
    leaseMs: 1_000,
  }), null);
  await assert.rejects(claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "bad worker",
    leaseMs: 1_000,
  }), /audit identity/);
  await assert.rejects(claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "acp-worker:7",
    leaseMs: 999,
  }), /between 1 second and 15 minutes/);
});
