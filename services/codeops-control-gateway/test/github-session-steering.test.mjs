import assert from "node:assert/strict";
import test from "node:test";
import {
  AmbiguousGitHubSessionTargetError,
  GitHubSessionTargetNotFoundError,
  InvalidGitHubSessionSteeringRequestError,
  resolveGitHubSessionTarget,
  serveGitHubSessionSteering,
} from "../dist/github-session-steering.js";

const token = "g".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const workItemId = "33333333-3333-4333-8333-333333333333";
const headSha = "a".repeat(40);
const actions = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive",
];

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_159",
    generation: 2,
    state: "running",
    identity: {
      repository: "anulman/renoconcierge",
      branch: "feat/agents-ui",
      baseSha: "b".repeat(40),
      workflowId: "workflow-159",
      runId: "run-159",
      workItemId,
      pullRequestNumber: 159,
      pullRequestHeadSha: headSha,
      agentRole: "coding",
      round: 1,
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 2,
      status: "active",
      holderId: "worker-159",
      acquiredAt: "2026-08-09T17:00:00.000Z",
      expiresAt: "2026-08-09T19:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 12,
    capabilities: actions.map((action) => action === "prompt"
      ? { action, availability: "enabled" }
      : { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-08-09T17:20:00.000Z",
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    version: "codeops.github-session-steering/v1",
    binding: {
      repository: "anulman/renoconcierge",
      number: 159,
      workItemId,
      state: "open",
      headSha,
      headRef: "feat/agents-ui",
      baseRef: "feat/codeops-contracts-ci",
    },
    event: {
      kind: "issue_comment",
      repository: "anulman/renoconcierge",
      number: 159,
      actorId: 6723643628,
      actorType: "User",
      currentHeadSha: headSha,
      headRef: "feat/agents-ui",
      baseRef: "feat/codeops-contracts-ci",
    },
    prompt: "Please fix the exact permission label.",
    idempotencyKey,
    principalId: "github:6723643628",
    ...overrides,
  };
}

function request(overrides = {}) {
  const calls = [];
  return {
    calls,
    promise: serveGitHubSessionSteering({
      method: "POST",
      url: "/v1/github-session-events",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      token,
      readBody: async () => body(),
      listSessions: async () => [snapshot()],
      now: () => new Date("2026-08-09T17:30:00.000Z"),
      enqueue: async (input) => {
        calls.push(input);
        return {
          version: "codeops.session-runtime-dispatch/v1",
          dispatchId: "44444444-4444-4444-8444-444444444444",
          principalId: input.principalId,
          command: input.command,
          snapshot: snapshot(),
          dispatchedAt: "2026-08-09T17:30:00.000Z",
        };
      },
      ...overrides,
    }),
  };
}

test("routes one authenticated PR prompt to the exact active bound session", async () => {
  const submitted = request();
  const result = await submitted.promise;
  assert.equal(result.status, 202);
  assert.equal(result.body.sessionId, "ses_159");
  assert.equal(result.body.workItemId, workItemId);
  assert.deepEqual(submitted.calls[0], {
    principalId: "github:6723643628",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "ses_159",
      generation: 2,
      leaseId,
      idempotencyKey,
      type: "prompt",
      prompt: "Please fix the exact permission label.",
    },
  });
});

test("fails closed on transport, principal, and head drift", async () => {
  assert.deepEqual(await request({ headers: {} }).promise, {
    status: 401,
    body: { status: "unauthorized" },
  });
  await assert.rejects(
    request({ readBody: async () => body({ principalId: "github:1" }) }).promise,
    InvalidGitHubSessionSteeringRequestError,
  );
  await assert.rejects(
    request({ readBody: async () => body({ event: {
      ...body().event,
      kind: "pull_request",
      headSha: "f".repeat(40),
    } }) }).promise,
    InvalidGitHubSessionSteeringRequestError,
  );
  for (const event of [
    { ...body().event, currentHeadSha: undefined },
    { ...body().event, currentHeadSha: "f".repeat(40) },
    { ...body().event, headRef: "feat/other" },
    { ...body().event, baseRef: "main" },
  ]) {
    await assert.rejects(
      request({ readBody: async () => body({ event }) }).promise,
      InvalidGitHubSessionSteeringRequestError,
    );
  }
});

test("rejects missing, expired, and ambiguous session targets", () => {
  const binding = body().binding;
  assert.throws(
    () => resolveGitHubSessionTarget({ sessions: [], binding }),
    GitHubSessionTargetNotFoundError,
  );
  assert.throws(
    () => resolveGitHubSessionTarget({
      sessions: [snapshot()],
      binding,
      now: new Date("2026-08-09T20:00:00.000Z"),
    }),
    GitHubSessionTargetNotFoundError,
  );
  assert.throws(
    () => resolveGitHubSessionTarget({
      sessions: [snapshot(), snapshot({ sessionId: "ses_other" })],
      binding,
      now: new Date("2026-08-09T17:30:00.000Z"),
    }),
    AmbiguousGitHubSessionTargetError,
  );
});
