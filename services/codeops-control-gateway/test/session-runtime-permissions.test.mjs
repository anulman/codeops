import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  pollSessionRuntimePermission,
  SessionRuntimePermissionConflictError,
  submitSessionRuntimePermission,
} from "../dist/session-runtime-permissions.js";

const dispatchId = "33333333-3333-4333-8333-333333333333";
const claimToken = "44444444-4444-4444-8444-444444444444";
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const operation = { kind: "command", command: "npm test", cwd: "/workspace" };
const operationBytes = '{"command":"npm test","cwd":"/workspace","kind":"command"}';
const operationDigest = `sha256:${createHash("sha256").update(operationBytes).digest("hex")}`;
const requestId = `permission-${createHash("sha256")
  .update(operationBytes)
  .update("\0")
  .update(dispatchId)
  .update("\0")
  .update("tool-call-1")
  .digest("hex")}`;
const workerId = "acp-worker:primary";

function capabilities(state) {
  const enabled = new Set(
    state === "running"
      ? ["prompt", "cancel", "checkpoint", "hibernate"]
      : ["respond_permission", "cancel", "checkpoint", "hibernate"],
  );
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => enabled.has(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_video_1",
    generation: 1,
    state: "running",
    identity: {
      repository: "example-org/example-repository",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "video-proof-1",
      runId: "video-proof-job-1",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "session-job:video-proof-1",
      acquiredAt: "2026-08-05T03:15:00.000Z",
      expiresAt: "2026-08-05T04:15:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 1,
    capabilities: capabilities("running"),
    updatedAt: "2026-08-05T03:15:00.000Z",
    ...overrides,
  };
}

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "ses_video_1",
      generation: 1,
      leaseId,
      idempotencyKey,
      type: "prompt",
      prompt: "Make one safe edit.",
    },
    snapshot: snapshot(),
    dispatchedAt: "2026-08-05T03:16:00.000Z",
  };
}

function submission(overrides = {}) {
  return {
    version: "codeops.session-runtime-permission-submission/v1",
    claimToken,
    request: {
      requestId,
      title: "Allow write?",
      description: "The agent wants to update one file.",
      operation,
      operationDigest,
      options: [
        { optionId: "allow-once", label: "Allow once" },
        { optionId: "allow-session", label: "Allow for session" },
      ],
      requestedAt: "2026-08-05T03:17:00.000Z",
    },
    acpSessionId: "acp-session-1",
    toolCallId: "tool-call-1",
    options: [
      { optionId: "allow-once", acpOptionId: "opaque-allow-once" },
      { optionId: "allow-session", acpOptionId: "opaque-allow-session" },
    ],
    ...overrides,
  };
}

class SubmitClient {
  constructor({ stored = null, current = snapshot(), updateCount = 1, token = claimToken, expiresAt = "2026-08-05T03:30:00.000Z" } = {}) {
    this.stored = stored;
    this.current = current;
    this.updateCount = updateCount;
    this.token = token;
    this.expiresAt = expiresAt;
    this.calls = [];
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.session_runtime_outbox")) {
      return {
        rowCount: 1,
        rows: [{
          dispatch_json: dispatch(),
          status: "claimed",
          claim_token: this.token,
          claimed_by: workerId,
          claim_expires_at: this.expiresAt,
        }],
      };
    }
    if (text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: this.current }] };
    }
    if (text.includes("FROM codeops.session_runtime_permission_requests")) {
      return {
        rowCount: this.stored ? 1 : 0,
        rows: this.stored ? [{ request_id: requestId, request_json: this.stored }] : [],
      };
    }
    if (text.startsWith("UPDATE codeops.sessions")) {
      return { rowCount: this.updateCount, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

test("atomically publishes one claim-bound permission request and waiting snapshot", async () => {
  const client = new SubmitClient();
  const result = await submitSessionRuntimePermission(client, {
    dispatchId,
    workerId,
    submission: submission(),
    now: () => new Date("2026-08-05T03:18:00.000Z"),
  });
  assert.equal(result.disposition, "pending");
  assert.equal(client.calls[1].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[2].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /session_runtime_outbox[\s\S]*FOR UPDATE/);
  assert.ok(client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_runtime_permission_requests")));
  const event = client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_events"));
  assert.equal(event.values[4], "permission_requested");
  assert.equal(event.values[6], "2026-08-05T03:18:00.000Z");
  const update = client.calls.find(({ text }) => text.startsWith("UPDATE codeops.sessions"));
  assert.match(update.values[0], /"state":"waiting_permission"/);
  assert.match(update.values[0], new RegExp(`"requestId":"${requestId}"`));
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("replays only the exact immutable permission request and rejects stale claims", async () => {
  const replay = new SubmitClient({ stored: submission() });
  assert.equal((await submitSessionRuntimePermission(replay, {
    dispatchId,
    workerId,
    submission: submission(),
    now: () => new Date("2026-08-05T03:18:00.000Z"),
  })).disposition, "pending");
  assert.equal(
    replay.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")),
    false,
  );

  const operationDrift = new SubmitClient({ stored: submission() });
  await assert.rejects(submitSessionRuntimePermission(operationDrift, {
    dispatchId,
    workerId,
    submission: submission({
      request: {
        ...submission().request,
        operation: { kind: "command", command: "npm run deploy", cwd: "/workspace" },
      },
    }),
    now: () => new Date("2026-08-05T03:18:00.000Z"),
  }), SessionRuntimePermissionConflictError);
  assert.equal(operationDrift.calls.length, 0);

  for (const client of [
    new SubmitClient({ token: "99999999-9999-4999-8999-999999999999" }),
    new SubmitClient({ expiresAt: null }),
  ]) {
    await assert.rejects(submitSessionRuntimePermission(client, {
      dispatchId,
      workerId,
      submission: submission(),
      now: () => new Date("2026-08-05T03:18:00.000Z"),
    }), SessionRuntimePermissionConflictError);
    assert.equal(client.calls.length, 1);
  }

  const snapshotDrift = new SubmitClient({
    current: snapshot({ eventCursor: 2 }),
  });
  await assert.rejects(submitSessionRuntimePermission(snapshotDrift, {
    dispatchId,
    workerId,
    submission: submission(),
    now: () => new Date("2026-08-05T03:18:00.000Z"),
  }), SessionRuntimePermissionConflictError);
  assert.equal(snapshotDrift.calls.at(-1).text, "ROLLBACK");
  assert.equal(
    snapshotDrift.calls[2].text.includes("codeops.sessions"),
    true,
  );
});

function waitingSnapshot() {
  return snapshot({
    state: "waiting_permission",
    pendingPermission: submission().request,
    eventCursor: 2,
    capabilities: capabilities("waiting_permission"),
    updatedAt: "2026-08-05T03:18:00.000Z",
  });
}

function decisionCommand(decision) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_video_1",
    generation: 1,
    leaseId,
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
    type: "respond_permission",
    permissionRequestId: requestId,
    decision,
  };
}

function decisionResult(command) {
  return {
    version: "codeops.session-command-result/v1",
    commandId: "66666666-6666-4666-8666-666666666666",
    sessionId: command.sessionId,
    generation: command.generation,
    leaseId: command.leaseId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    eventCursor: 3,
    snapshot: snapshot({ eventCursor: 3, updatedAt: "2026-08-05T03:19:00.000Z" }),
    committedAt: "2026-08-05T03:19:00.000Z",
    disposition: "committed",
  };
}

class PollClient {
  constructor({ snapshotValue = waitingSnapshot(), command = null, result = null } = {}) {
    this.snapshotValue = snapshotValue;
    this.command = command;
    this.result = result;
  }

  async query() {
    return {
      rowCount: 1,
      rows: [{
        request_json: submission(),
        dispatch_json: dispatch(),
        status: "claimed",
        claim_token: claimToken,
        claimed_by: workerId,
        claim_expires_at: "2026-08-05T03:30:00.000Z",
        snapshot_json: this.snapshotValue,
        command_json: this.command,
        result_json: this.result,
      }],
    };
  }
}

const poll = (client) => pollSessionRuntimePermission(client, {
  dispatchId,
  workerId,
  poll: {
    version: "codeops.session-runtime-permission-poll/v1",
    claimToken,
    requestId,
  },
  now: () => new Date("2026-08-05T03:20:00.000Z"),
});

test("polls pending, denied, and opaque selected ACP decisions", async () => {
  assert.equal((await poll(new PollClient())).disposition, "pending");

  const denied = decisionCommand({ outcome: "denied" });
  assert.deepEqual((await poll(new PollClient({
    snapshotValue: decisionResult(denied).snapshot,
    command: denied,
    result: decisionResult(denied),
  }))).decision, { outcome: "denied" });

  const selected = decisionCommand({ outcome: "selected", optionId: "allow-session" });
  assert.deepEqual((await poll(new PollClient({
    snapshotValue: decisionResult(selected).snapshot,
    command: selected,
    result: decisionResult(selected),
  }))).decision, {
    outcome: "selected",
    acpOptionId: "opaque-allow-session",
  });
});
