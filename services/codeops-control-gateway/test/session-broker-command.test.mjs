import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionCommandRequestError,
  applyLocalSessionCommandMutation,
  serveSessionBrokerCommand,
} from "../dist/session-broker-command.js";

const token = "t".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const committedAt = "2026-08-04T05:55:00.000Z";

const allActions = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive",
];

function capabilities(enabled = ["prompt", "cancel", "checkpoint", "hibernate"]) {
  return allActions.map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot() {
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
      acquiredAt: "2026-08-04T05:40:00.000Z",
      expiresAt: "2026-08-04T06:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(),
    updatedAt: "2026-08-04T05:50:00.000Z",
  };
}

function command(type = "cancel", overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type,
    reason: "Operator requested cancellation.",
    ...overrides,
  };
}

function request(overrides = {}) {
  const body = command();
  const calls = [];
  return {
    calls,
    promise: serveSessionBrokerCommand({
      method: "POST",
      url: "/v1/sessions/ses_91a4/commands",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "x-codeops-principal": "access:aidan@example.com",
      },
      token,
      readBody: async () => body,
      execute: async (input) => {
        calls.push(input);
        return applyLocalSessionCommandMutation(snapshot(), input.command, {
          commandId: "55555555-5555-4555-8555-555555555555",
          committedAt,
        }).result;
      },
      enqueueRuntime: async () => {
        throw new Error("unexpected runtime enqueue");
      },
      ...overrides,
    }),
  };
}

test("authenticates, identity-binds, and audits one local command", async () => {
  const submitted = request();
  const response = await submitted.promise;
  assert.equal(response.status, 200);
  assert.equal(response.body.disposition, "committed");
  assert.equal(response.body.snapshot.state, "cancelled");
  assert.equal(submitted.calls[0].principalId, "access:aidan@example.com");
  assert.equal(submitted.calls[0].command.sessionId, "ses_91a4");

  const unauthorized = request({ headers: {} });
  assert.deepEqual(await unauthorized.promise, {
    status: 401,
    body: { status: "unauthorized" },
  });
  assert.equal(unauthorized.calls.length, 0);
});

test("rejects ambiguous command transport before execution", async () => {
  await assert.rejects(
    request({ url: "/v1/sessions/ses_91a4/commands?retry=1" }).promise,
    InvalidSessionCommandRequestError,
  );
  await assert.rejects(
    request({ headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "x-codeops-principal": "access:aidan@example.com",
    } }).promise,
    InvalidSessionCommandRequestError,
  );
  await assert.rejects(
    request({ readBody: async () => command("cancel", { sessionId: "ses_other" }) }).promise,
    InvalidSessionCommandRequestError,
  );
});

test("admits ACP-dependent commands only through the durable runtime outbox", async () => {
  const runtimeCalls = [];
  const submitted = request({
    readBody: async () => ({
      version: "codeops.session-command/v1",
      sessionId: "ses_91a4",
      generation: 3,
      leaseId,
      idempotencyKey,
      type: "prompt",
      prompt: "Continue with the focused test.",
    }),
    enqueueRuntime: async (input) => {
      runtimeCalls.push(input);
      return {
        version: "codeops.session-runtime-dispatch/v1",
        dispatchId: "44444444-4444-4444-8444-444444444444",
        principalId: input.principalId,
        command: input.command,
        snapshot: snapshot(),
        dispatchedAt: committedAt,
      };
    },
  });
  assert.deepEqual(await submitted.promise, {
    status: 200,
    body: {
      version: "codeops.session-command-accepted/v1",
      disposition: "accepted",
      dispatchId: "44444444-4444-4444-8444-444444444444",
      sessionId: "ses_91a4",
      generation: 3,
      leaseId,
      idempotencyKey,
      type: "prompt",
    },
  });
  assert.equal(submitted.calls.length, 0);
  assert.equal(runtimeCalls[0].principalId, "access:aidan@example.com");
});

test("binds the committed result and ordered event to one mutation context", () => {
  const mutation = applyLocalSessionCommandMutation(
    snapshot(),
    command(),
    {
      commandId: "55555555-5555-4555-8555-555555555555",
      committedAt,
    },
  );
  assert.equal(mutation.result.commandId, "55555555-5555-4555-8555-555555555555");
  assert.equal(mutation.result.committedAt, committedAt);
  assert.equal(mutation.result.eventCursor, 185);
  assert.equal(mutation.events[0].cursor, 185);
  assert.equal(mutation.events[0].occurredAt, committedAt);
});
