import assert from "node:assert/strict";
import test from "node:test";
import {
  ImmutableSessionCommandConflictError,
  SessionForkConflictError,
  executeSessionCommandTransaction,
  listSessionSnapshots,
  loadSessionEvents,
  loadSessionSnapshot,
} from "../dist/session-broker-repository.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const dispatchId = "44444444-4444-4444-8444-444444444444";

function capabilities(enabled = ["prompt", "cancel", "checkpoint", "hibernate"]) {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
    generation: 3,
    state: "running",
    identity: {
      repository: "example-org/example-repository",
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
      acquiredAt: "2026-08-04T03:00:00.000Z",
      expiresAt: "2026-08-04T03:05:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(),
    updatedAt: "2026-08-04T03:04:00.000Z",
    ...overrides,
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
    prompt: "Continue.",
    ...overrides,
  };
}

function committed(current = snapshot()) {
  return {
    version: "codeops.session-command-result/v1",
    commandId: "55555555-5555-4555-8555-555555555555",
    sessionId: current.sessionId,
    generation: current.generation,
    leaseId,
    idempotencyKey,
    type: "prompt",
    eventCursor: 185,
    snapshot: { ...current, eventCursor: 185 },
    committedAt: "2026-08-04T03:04:01.000Z",
    disposition: "committed",
  };
}

function event(overrides = {}) {
  return {
    version: "codeops.session-event/v1",
    eventId: `sha256:${"c".repeat(64)}`,
    sessionId: "ses_91a4",
    generation: 3,
    cursor: 185,
    type: "command_committed",
    occurredAt: "2026-08-04T03:04:01.000Z",
    ...overrides,
  };
}

const mutation = (result = committed(), events = [event()]) => ({ result, events });

class FakeReadClient {
  constructor(rows) {
    this.rows = rows;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    return { rowCount: this.rows.length, rows: this.rows };
  }
}

test("loads one strict session snapshot without locking", async () => {
  const client = new FakeReadClient([{ snapshot_json: snapshot() }]);
  assert.equal((await loadSessionSnapshot(client, "ses_91a4")).sessionId, "ses_91a4");
  assert.deepEqual(client.calls[0].values, ["ses_91a4"]);
  assert.doesNotMatch(client.calls[0].text, /FOR UPDATE/);
  assert.equal(await loadSessionSnapshot(new FakeReadClient([]), "ses_missing"), null);
  await assert.rejects(loadSessionSnapshot(client, "../unsafe"), /identifier/);
  await assert.rejects(
    loadSessionSnapshot(
      new FakeReadClient([
        { snapshot_json: snapshot({ sessionId: "ses_foreign" }) },
      ]),
      "ses_91a4",
    ),
    /requested session/,
  );
});

test("projects current elapsed time and active children on every snapshot read", async () => {
  const stored = snapshot({
    budget: {
      version: "codeops.session-budget/v1",
      startedAt: "2026-08-04T03:00:00.000Z",
      observedAt: "2026-08-04T03:01:00.000Z",
      limits: {
        elapsedSeconds: 3600,
        totalTokens: 10_000,
        modelRequests: 10,
        activeChildren: 4,
      },
      usage: {
        elapsedSeconds: 60,
        totalTokens: 1_000,
        modelRequests: 2,
        activeChildren: 0,
      },
      remaining: {
        elapsedSeconds: 3540,
        totalTokens: 9_000,
        modelRequests: 8,
        activeChildren: 4,
      },
      exhaustedLimit: null,
    },
  });
  const row = {
    snapshot_json: stored,
    observed_at: new Date("2026-08-04T03:10:00.000Z"),
    active_children: 3,
  };
  const loaded = await loadSessionSnapshot(new FakeReadClient([row]), stored.sessionId);
  assert.deepEqual(loaded.budget.usage, {
    elapsedSeconds: 600,
    totalTokens: 1_000,
    modelRequests: 2,
    activeChildren: 3,
  });
  const listed = await listSessionSnapshots(new FakeReadClient([row]));
  assert.deepEqual(listed[0].budget, loaded.budget);
});

test("projects hard model limits and observed telemetry from the durable ledger", async () => {
  const stored = snapshot({
    budget: {
      version: "codeops.session-budget/v1",
      startedAt: "2026-08-04T03:00:00.000Z",
      observedAt: "2026-08-04T03:01:00.000Z",
      limits: {
        elapsedSeconds: 3600,
        totalTokens: 10_000,
        modelRequests: 10,
        activeChildren: 4,
      },
      usage: {
        elapsedSeconds: 60,
        totalTokens: 1_000,
        modelRequests: 2,
        activeChildren: 0,
      },
      remaining: {
        elapsedSeconds: 3540,
        totalTokens: 9_000,
        modelRequests: 8,
        activeChildren: 4,
      },
      exhaustedLimit: null,
    },
  });
  const row = {
    snapshot_json: stored,
    observed_at: new Date("2026-08-04T03:10:00.000Z"),
    active_children: 2,
    model_budget_id: stored.sessionId,
    model_budget_started_at: new Date("2026-08-04T03:00:00.000Z"),
    provider_requests_limit: "10",
    output_tokens_limit: "10000",
    committed_provider_requests: "3",
    settled_output_tokens: "1200",
    reserved_output_tokens: "300",
    observed_input_tokens: "4500",
    observed_total_tokens: "5700",
    model_budget_revision: "7",
  };
  const loaded = await loadSessionSnapshot(new FakeReadClient([row]), stored.sessionId);
  assert.equal(loaded.budget.version, "codeops.session-budget/v2");
  assert.deepEqual(loaded.budget.usage, {
    elapsedSeconds: 600,
    providerRequests: 3,
    outputTokens: 1_200,
    observedInputTokens: 4_500,
    observedTotalTokens: 5_700,
    activeChildren: 2,
  });
  assert.deepEqual(loaded.budget.reserved, { outputTokens: 300 });
  assert.deepEqual(loaded.budget.remaining, {
    elapsedSeconds: 3_000,
    providerRequests: 7,
    outputTokens: 8_500,
    activeChildren: 2,
  });
});

test("bounds and revalidates the fleet snapshot read", async () => {
  const client = new FakeReadClient([{ snapshot_json: snapshot() }]);
  assert.equal((await listSessionSnapshots(client, 25)).length, 1);
  assert.deepEqual(client.calls[0].values, [25]);
  assert.match(client.calls[0].text, /parent\.updated_at DESC, parent\.session_id ASC/);
  await assert.rejects(listSessionSnapshots(client, 201), /between 1 and 200/);
  await assert.rejects(
    listSessionSnapshots(new FakeReadClient([{ snapshot_json: { unsafe: true } }])),
  );
});

test("loads strict ordered events after one bounded cursor", async () => {
  const client = new FakeReadClient([{ event_json: event() }]);
  const events = await loadSessionEvents(client, {
    sessionId: "ses_91a4",
    afterCursor: 184,
    limit: 50,
  });
  assert.equal(events[0].cursor, 185);
  assert.deepEqual(client.calls[0].values, ["ses_91a4", 184, 50]);
  assert.match(client.calls[0].text, /cursor > \$2[\s\S]*ORDER BY cursor ASC/);
  await assert.rejects(
    loadSessionEvents(client, { sessionId: "ses_91a4", afterCursor: -1 }),
    /cursor/,
  );
  await assert.rejects(
    loadSessionEvents(client, { sessionId: "ses_91a4", limit: 501 }),
    /between 1 and 500/,
  );
  await assert.rejects(
    loadSessionEvents(
      new FakeReadClient([{ event_json: event({ cursor: 186 }) }]),
      { sessionId: "ses_91a4", afterCursor: 184 },
    ),
    /contiguous cursor/,
  );
});

class FakeClient {
  constructor({ current = snapshot(), existing = null, reservedRuntimeDispatch = null, updateCount = 1, forkInsertCount = 1 } = {}) {
    this.current = current;
    this.existing = existing;
    this.reservedRuntimeDispatch = reservedRuntimeDispatch;
    this.updateCount = updateCount;
    this.forkInsertCount = forkInsertCount;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: this.current }] };
    }
    if (text.includes("FROM codeops.session_commands")) {
      return { rowCount: this.existing ? 1 : 0, rows: this.existing ? [this.existing] : [] };
    }
    if (text.includes("FROM codeops.session_runtime_outbox")) {
      return {
        rowCount: this.reservedRuntimeDispatch ? 1 : 0,
        rows: this.reservedRuntimeDispatch
          ? [{ dispatch_id: this.reservedRuntimeDispatch }]
          : [],
      };
    }
    if (text.startsWith("UPDATE codeops.sessions")) {
      return { rowCount: this.updateCount, rows: [] };
    }
    if (text.startsWith("INSERT INTO codeops.sessions")) {
      return { rowCount: this.forkInsertCount, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

const execute = (client, overrides = {}) => executeSessionCommandTransaction(client, {
  command: command(),
  principalId: "user:aidan",
  now: () => new Date("2026-08-04T03:04:01.000Z"),
  commandId: () => "55555555-5555-4555-8555-555555555555",
  mutate: () => mutation(),
  ...overrides,
});

test("locks, compare-and-swaps, audits, and commits one command transaction", async () => {
  const client = new FakeClient();
  const result = await execute(client);
  assert.equal(result.disposition, "committed");
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[2].text, /session_runtime_outbox[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /session_commands[\s\S]*FOR UPDATE/);
  assert.match(client.calls[4].text, /INSERT INTO codeops\.session_events/);
  assert.match(client.calls[5].text, /generation = \$6[\s\S]*lease_id = \$7/);
  assert.equal(client.calls[6].values[5], "user:aidan");
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("rejects a local command that collides with a reserved runtime dispatch", async () => {
  const client = new FakeClient({ reservedRuntimeDispatch: dispatchId });
  await assert.rejects(execute(client), ImmutableSessionCommandConflictError);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("replays an identical idempotency key without invoking the mutator", async () => {
  const original = committed();
  const client = new FakeClient({ existing: { command_json: command(), result_json: original } });
  let invoked = false;
  const result = await execute(client, { mutate: () => { invoked = true; return mutation(original); } });
  assert.equal(invoked, false);
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.originalCommandId, original.commandId);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("rejects immutable idempotency conflicts and rolls back", async () => {
  const client = new FakeClient({
    existing: { command_json: command({ prompt: "Different." }), result_json: committed() },
  });
  await assert.rejects(execute(client), ImmutableSessionCommandConflictError);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("durably rejects stale generation and lease commands without mutation", async () => {
  for (const stale of [
    command({ generation: 2 }),
    command({ leaseId: "99999999-9999-4999-8999-999999999999" }),
  ]) {
    const client = new FakeClient();
    let invoked = false;
    const result = await execute(client, {
      command: stale,
      mutate: () => { invoked = true; return mutation(); },
    });
    assert.equal(invoked, false);
    assert.match(result.rejectionCode, /^(generation|lease)_conflict$/);
    assert.equal(client.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")), false);
    assert.equal(client.calls.at(-1).text, "COMMIT");
  }
});

test("durably rejects prompt execution after an exact budget is exhausted", async () => {
  const current = snapshot({
    budget: {
      version: "codeops.session-budget/v1",
      startedAt: "2026-08-04T03:00:00.000Z",
      observedAt: "2026-08-04T03:04:00.000Z",
      limits: {
        elapsedSeconds: 3600,
        totalTokens: 10_000,
        modelRequests: 4,
        activeChildren: 2,
      },
      usage: {
        elapsedSeconds: 240,
        totalTokens: 10_000,
        modelRequests: 2,
        activeChildren: 0,
      },
      remaining: {
        elapsedSeconds: 3360,
        totalTokens: 0,
        modelRequests: 2,
        activeChildren: 2,
      },
      exhaustedLimit: "total_tokens",
    },
  });
  const client = new FakeClient({ current });
  let invoked = false;
  const result = await execute(client, {
    mutate: () => { invoked = true; return mutation(); },
  });
  assert.equal(invoked, false);
  assert.equal(result.disposition, "rejected");
  assert.equal(result.rejectionCode, "budget_exhausted");
  assert.equal(result.reason, "The token budget is exhausted.");
  assert.equal(result.snapshot.budget.exhaustedLimit, "total_tokens");
  assert.equal(
    client.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")),
    false,
  );
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("rolls back when the final compare-and-swap loses", async () => {
  const client = new FakeClient({ updateCount: 0 });
  await assert.rejects(execute(client), /changed during command commit/);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("rejects a mutator result that crosses command identity", async () => {
  const client = new FakeClient();
  await assert.rejects(
    execute(client, {
      mutate: () => mutation({ ...committed(), idempotencyKey: "77777777-7777-4777-8777-777777777777" }),
    }),
    /does not match the command identity/,
  );
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("validates the authenticated principal before opening a transaction", async () => {
  const client = new FakeClient();
  await assert.rejects(execute(client, { principalId: "bad principal" }), /audit identity/);
  assert.equal(client.calls.length, 0);
});

test("rolls back snapshots that advance without a complete ordered event history", async () => {
  for (const invalid of [
    mutation(committed(), []),
    mutation(committed(), [event({ cursor: 186 })]),
    mutation(committed(), [event({ sessionId: "ses_foreign" })]),
  ]) {
    const client = new FakeClient();
    await assert.rejects(execute(client, { mutate: () => invalid }), /event|cursor/);
    assert.equal(client.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")), false);
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});

test("atomically inserts a fork child without overwriting its parent", async () => {
  const checkpointId = "22222222-2222-4222-8222-222222222222";
  const childLeaseId = "77777777-7777-4777-8777-777777777777";
  const parent = snapshot({
    state: "completed",
    lease: {
      leaseId,
      generation: 3,
      status: "released",
      releasedAt: "2026-08-04T03:04:00.000Z",
    },
    checkpoint: {
      version: "codeops.session-checkpoint/v1",
      checkpointId,
      sessionId: "ses_91a4",
      generation: 3,
      baseSha: "a".repeat(40),
      patchDigest: `sha256:${"b".repeat(64)}`,
      acpSessionId: "acp-parent",
      eventCursor: 184,
      evidenceReferences: [],
      createdAt: "2026-08-04T03:04:00.000Z",
    },
    capabilities: capabilities(["fork", "archive"]),
  });
  const forkCommand = {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "fork",
    checkpointId,
    parentEventCursor: 184,
    title: "Alternative implementation",
  };
  const child = snapshot({
    sessionId: "ses_child",
    generation: 1,
    identity: {
      ...parent.identity,
      branch: "feat/agents-ui-child",
      workflowId: "workflow-child",
      runId: "run-child",
      parentSessionId: parent.sessionId,
      forkedAtCursor: 184,
    },
    lease: {
      leaseId: childLeaseId,
      generation: 1,
      status: "active",
      holderId: "worker-child",
      acquiredAt: "2026-08-04T03:04:01.000Z",
      expiresAt: "2026-08-04T03:24:01.000Z",
    },
    checkpoint: null,
    eventCursor: 1,
    updatedAt: "2026-08-04T03:04:01.000Z",
  });
  const result = {
    ...committed(parent),
    type: "fork",
    eventCursor: child.eventCursor,
    snapshot: child,
  };
  const childEvent = event({
    sessionId: child.sessionId,
    generation: child.generation,
    cursor: 1,
    type: "session_created",
  });
  const client = new FakeClient({ current: parent });

  const committedFork = await execute(client, {
    command: forkCommand,
    mutate: () => mutation(result, [childEvent]),
  });

  assert.equal(committedFork.snapshot.sessionId, "ses_child");
  const insertIndex = client.calls.findIndex(({ text }) =>
    text.startsWith("INSERT INTO codeops.sessions"));
  const eventIndex = client.calls.findIndex(({ text }) =>
    text.includes("INSERT INTO codeops.session_events"));
  assert.ok(insertIndex > 0 && insertIndex < eventIndex);
  assert.equal(
    client.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")),
    false,
  );
  assert.equal(client.calls[insertIndex].values[0], "ses_child");
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("fails closed on fork lineage drift or an existing child identity", async () => {
  const checkpointId = "22222222-2222-4222-8222-222222222222";
  const parent = snapshot({
    state: "completed",
    lease: {
      leaseId,
      generation: 3,
      status: "released",
      releasedAt: "2026-08-04T03:04:00.000Z",
    },
    checkpoint: {
      version: "codeops.session-checkpoint/v1",
      checkpointId,
      sessionId: "ses_91a4",
      generation: 3,
      baseSha: "a".repeat(40),
      patchDigest: `sha256:${"b".repeat(64)}`,
      acpSessionId: "acp-parent",
      eventCursor: 184,
      evidenceReferences: [],
      createdAt: "2026-08-04T03:04:00.000Z",
    },
    capabilities: capabilities(["fork", "archive"]),
  });
  const forkCommand = {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "fork",
    checkpointId,
    parentEventCursor: 184,
    title: "Alternative implementation",
  };
  const child = snapshot({
    sessionId: "ses_child",
    generation: 1,
    identity: {
      ...parent.identity,
      workflowId: "workflow-child",
      runId: "run-child",
      parentSessionId: parent.sessionId,
      forkedAtCursor: 184,
    },
    lease: {
      leaseId: "77777777-7777-4777-8777-777777777777",
      generation: 1,
      status: "active",
      holderId: "worker-child",
      acquiredAt: "2026-08-04T03:04:01.000Z",
      expiresAt: "2026-08-04T03:24:01.000Z",
    },
    checkpoint: null,
    eventCursor: 1,
    updatedAt: "2026-08-04T03:04:01.000Z",
  });
  const result = {
    ...committed(parent),
    type: "fork",
    eventCursor: child.eventCursor,
    snapshot: child,
  };
  const childEvent = event({
    sessionId: child.sessionId,
    generation: child.generation,
    cursor: 1,
    type: "session_created",
  });

  const drifted = new FakeClient({ current: parent });
  await assert.rejects(
    execute(drifted, {
      command: { ...forkCommand, parentEventCursor: 183 },
      mutate: () => mutation(result, [childEvent]),
    }),
    /exact parent checkpoint, cursor/,
  );
  assert.equal(drifted.calls.at(-1).text, "ROLLBACK");

  const existing = new FakeClient({ current: parent, forkInsertCount: 0 });
  await assert.rejects(
    execute(existing, {
      command: forkCommand,
      mutate: () => mutation(result, [childEvent]),
    }),
    SessionForkConflictError,
  );
  assert.equal(existing.calls.at(-1).text, "ROLLBACK");
});
