import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProjectContext } from "@codeops/codeops-contracts";
import {
  AmbiguousPlaneSessionTargetError,
  InvalidPlaneSessionSteeringRequestError,
  PlaneSessionTargetNotFoundError,
  resolvePlaneSessionTarget,
  servePlaneSessionSteering,
} from "../dist/plane-session-steering.js";

const token = "p".repeat(32);
const repository = "example-org/example-repository";
const workItemId = "11111111-1111-4111-8111-111111111111";
const requestedBy = "22222222-2222-4222-8222-222222222222";
const triggerCommentId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const sha = "a".repeat(40);
const documentContent = "# Agents\n";
const projectContext = createProjectContext({
  version: "codeops.project-context/v1",
  repository: { owner: "example-org", name: "example-repository" },
  controlPlaneSha: sha,
  baseSha: sha,
  project: {
    workspaceId,
    projectId,
    name: "ACP session utility",
    descriptionHtml: "<p>Improve bounded ACP sessions.</p>",
    updatedAt: "2026-08-14T00:00:00.000Z",
  },
  documents: [{
    path: "AGENTS.md",
    purpose: "Agent guidance",
    digest: `sha256:${createHash("sha256").update(documentContent).digest("hex")}`,
    content: documentContent,
  }],
});

function planeRequest(overrides = {}) {
  return {
    version: "codeops.plane-session-request/v1",
    requestId: "plane-session-request-1",
    workspaceId,
    projectId,
    projectContext,
    workItemId,
    triggerCommentId,
    requestedBy,
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: sha,
    baseSha: sha,
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    ticketSnapshot: {
      workItemId,
      name: "Complete ACP steering",
      descriptionHtml: "<p>Route the exact comment.</p>",
      priority: "high",
      stateId: "77777777-7777-4777-8777-777777777777",
      labelIds: [],
      assigneeIds: [],
      moduleId: null,
      parentId: null,
      updatedAt: "2026-08-14T00:00:00.000Z",
      relevantComments: [],
      relations: [],
      projectTasks: [],
    },
    intent: "steering",
    personas: [],
    comment: "Also cover the mobile session route.",
    requestedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_plane_1",
    generation: 1,
    state: "running",
    identity: {
      repository,
      branch: "feat/acp-session-utility",
      baseSha: sha,
      workflowId: "workflow-plane-1",
      runId: "run-plane-1",
      workItemId,
      agentRole: "coordinator",
      round: 1,
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "worker-plane-1",
      acquiredAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T01:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 3,
    capabilities: [
      { action: "prompt", availability: "enabled" },
      ...["respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
        .map((action) => ({ action, availability: "disabled", reason: "Unavailable." })),
    ],
    updatedAt: "2026-08-14T00:01:00.000Z",
    ...overrides,
  };
}

function request(overrides = {}) {
  const calls = [];
  return {
    calls,
    promise: servePlaneSessionSteering({
      method: "POST",
      url: "/v1/repositories/example-org/example-repository/plane-session-events",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      resolveToken: (value) => {
        if (value !== repository) throw new Error("not admitted");
        return token;
      },
      readBody: async () => ({
        version: "codeops.plane-session-steering/v1",
        request: planeRequest(),
        principalId: `plane:${requestedBy}`,
      }),
      listSessions: async () => [snapshot()],
      now: () => new Date("2026-08-14T00:10:00.000Z"),
      enqueue: async (input) => {
        calls.push(input);
        return {
          version: "codeops.session-runtime-dispatch/v1",
          dispatchId: "88888888-8888-4888-8888-888888888888",
          principalId: input.principalId,
          command: input.command,
          snapshot: snapshot(),
          dispatchedAt: "2026-08-14T00:10:00.000Z",
        };
      },
      ...overrides,
    }),
  };
}

test("routes one authenticated Plane comment to the exact active bound session", async () => {
  const submitted = request();
  const result = await submitted.promise;
  assert.equal(result.status, 202);
  assert.equal(result.body.sessionId, "ses_plane_1");
  assert.deepEqual(submitted.calls[0].principalId, `plane:${requestedBy}`);
  assert.equal(submitted.calls[0].command.idempotencyKey, triggerCommentId);
  assert.match(submitted.calls[0].command.prompt, /Also cover the mobile session route/);
  assert.match(submitted.calls[0].command.prompt, new RegExp(workItemId));
});

test("fails closed on unauthorized, drifting, missing, and ambiguous Plane targets", async () => {
  assert.deepEqual(await request({ headers: {} }).promise, {
    status: 401,
    body: { status: "unauthorized" },
  });
  await assert.rejects(request({
    readBody: async () => ({
      version: "codeops.plane-session-steering/v1",
      request: planeRequest(),
      principalId: "plane:99999999-9999-4999-8999-999999999999",
    }),
  }).promise, InvalidPlaneSessionSteeringRequestError);
  assert.throws(() => resolvePlaneSessionTarget({
    sessions: [],
    request: planeRequest(),
  }), PlaneSessionTargetNotFoundError);
  assert.throws(() => resolvePlaneSessionTarget({
    sessions: [snapshot(), snapshot({ sessionId: "ses_plane_2" })],
    request: planeRequest(),
    now: new Date("2026-08-14T00:10:00.000Z"),
  }), AmbiguousPlaneSessionTargetError);
  assert.throws(() => resolvePlaneSessionTarget({
    sessions: [snapshot({ identity: { ...snapshot().identity, workItemId: "99999999-9999-4999-8999-999999999999" } })],
    request: planeRequest(),
    now: new Date("2026-08-14T00:10:00.000Z"),
  }), PlaneSessionTargetNotFoundError);
});
