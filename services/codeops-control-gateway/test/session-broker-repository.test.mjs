import assert from "node:assert/strict";
import test from "node:test";
import {
  ImmutableSessionCommandConflictError,
  executeSessionCommandTransaction,
} from "../dist/session-broker-repository.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

function capabilities(enabled = "prompt") {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive", "delete",
  ].map((action) => action === enabled
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
      acquiredAt: "2026-08-04T03:00:00.000Z",
      expiresAt: "2026-08-04T03:05:00.000Z",
    },
    checkpoint: null,
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

class FakeClient {
  constructor({ current = snapshot(), existing = null, updateCount = 1 } = {}) {
    this.current = current;
    this.existing = existing;
    this.updateCount = updateCount;
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
    if (text.startsWith("UPDATE codeops.sessions")) {
      return { rowCount: this.updateCount, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

const execute = (client, overrides = {}) => executeSessionCommandTransaction(client, {
  command: command(),
  principalId: "user:aidan",
  now: () => new Date("2026-08-04T03:04:01.000Z"),
  commandId: () => "55555555-5555-4555-8555-555555555555",
  mutate: () => committed(),
  ...overrides,
});

test("locks, compare-and-swaps, audits, and commits one command transaction", async () => {
  const client = new FakeClient();
  const result = await execute(client);
  assert.equal(result.disposition, "committed");
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[2].text, /session_commands[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /generation = \$6[\s\S]*lease_id = \$7/);
  assert.equal(client.calls[4].values[5], "user:aidan");
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("replays an identical idempotency key without invoking the mutator", async () => {
  const original = committed();
  const client = new FakeClient({ existing: { command_json: command(), result_json: original } });
  let invoked = false;
  const result = await execute(client, { mutate: () => { invoked = true; return original; } });
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
      mutate: () => { invoked = true; return committed(); },
    });
    assert.equal(invoked, false);
    assert.match(result.rejectionCode, /^(generation|lease)_conflict$/);
    assert.equal(client.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")), false);
    assert.equal(client.calls.at(-1).text, "COMMIT");
  }
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
      mutate: () => ({ ...committed(), idempotencyKey: "77777777-7777-4777-8777-777777777777" }),
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
