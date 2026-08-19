import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionSupervisionReconciliationRequestError,
  reconcileSessionSupervision,
  serveSessionSupervisionReconciliation,
} from "../dist/session-supervision.js";

const token = "s".repeat(32);
const owner = "access:aidan@example.com";
const workItemId = "22222222-2222-4222-8222-222222222222";
const headSha = "b".repeat(40);
const request = {
  version: "codeops.session-supervision-reconciliation/v1",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  supervisorSessionId: "ses_pm",
  childSessionIds: ["ses_worker", "ses_reviewer"],
  repository: "example-org/example-repository",
  workItemId,
  workflowId: "adopt-pr-158",
  pullRequestNumber: 158,
  pullRequestHeadSha: headSha,
};

function capabilities(state) {
  const enabled = state === "running" ? ["prompt", "cancel", "checkpoint", "hibernate"] : ["archive"];
  return [
    ...["prompt", "respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
      .map((action) => enabled.includes(action)
        ? { action, availability: "enabled" }
        : { action, availability: "disabled", reason: "Unavailable." }),
  ];
}

function snapshot(sessionId, identity, state, eventCursor) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId,
    generation: 1,
    state,
    identity,
    lease: state === "running" ? {
      leaseId: "33333333-3333-4333-8333-333333333333",
      generation: 1,
      status: "active",
      holderId: "worker",
      acquiredAt: "2026-08-19T19:00:00.000Z",
      expiresAt: "2026-08-20T19:00:00.000Z",
    } : {
      leaseId: "33333333-3333-4333-8333-333333333333",
      generation: 1,
      status: "released",
      releasedAt: "2026-08-19T19:30:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor,
    capabilities: capabilities(state),
    updatedAt: "2026-08-19T19:30:00.000Z",
  };
}

function database() {
  const supervisor = snapshot("ses_pm", {
    version: "codeops.session-workspace-identity/v1",
    policy: {
      version: "codeops.session-policy/v1",
      mode: "implement",
      workspaceAccess: "bounded-writes",
      modelCalls: "allowed",
      modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
    workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
    workflowId: "pm-session",
    runId: "pm-run",
    displayName: "PM Project Session",
    parentSessionId: null,
    forkedAtCursor: null,
  }, "running", 5);
  const childIdentity = (runId, agentRole) => ({
    repository: request.repository,
    branch: "feat/existing-pr",
    baseSha: "a".repeat(40),
    workflowId: request.workflowId,
    runId,
    displayName: `${agentRole} session`,
    workItemId,
    agentRole,
    round: 1,
    pullRequestNumber: 158,
    pullRequestHeadSha: headSha,
    parentSessionId: null,
    forkedAtCursor: null,
  });
  const sessions = new Map([
    ["ses_pm", { snapshot_json: supervisor, owner_principal_id: owner }],
    ["ses_worker", { snapshot_json: snapshot("ses_worker", childIdentity("worker", "coding"), "completed", 4), owner_principal_id: owner }],
    ["ses_reviewer", { snapshot_json: snapshot("ses_reviewer", childIdentity("reviewer", "critic"), "completed", 6), owner_principal_id: owner }],
  ]);
  const events = [];
  return {
    sessions,
    events,
    async query(sql, values = []) {
      if (sql.includes("FROM codeops.sessions")) {
        return {
          rowCount: values[0].length,
          rows: values[0].map((sessionId) => ({ session_id: sessionId, ...sessions.get(sessionId) })),
        };
      }
      if (sql.includes("FROM codeops.session_events")) {
        return {
          rowCount: events.filter((event) =>
            event.sessionId === values[0] && event.update.projectionId === values[1]).length,
          rows: events
            .filter((event) => event.sessionId === values[0] && event.update.projectionId === values[1])
            .map((event_json) => ({ event_json })),
        };
      }
      if (sql.includes("INSERT INTO codeops.session_events")) {
        events.push(JSON.parse(values[5]));
      }
      if (sql.includes("UPDATE codeops.sessions")) {
        sessions.get(values[0]).snapshot_json = JSON.parse(values[1]);
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

test("projects exact child state into the supervisor and replays idempotently", async () => {
  const client = database();
  const first = await reconcileSessionSupervision(client, request, {
    now: () => new Date("2026-08-19T20:00:00.000Z"),
  });
  assert.deepEqual(first.projected.map(({ disposition }) => disposition), ["created", "created"]);
  assert.equal(client.sessions.get("ses_pm").snapshot_json.eventCursor, 7);
  assert.equal(client.events[1].update.resultUri, "artifact:///agent-runs/reviewer/result.json");

  const replay = await reconcileSessionSupervision(client, request, {
    now: () => new Date("2026-08-19T20:05:00.000Z"),
  });
  assert.deepEqual(replay.projected.map(({ disposition }) => disposition), ["existing", "existing"]);
  assert.equal(client.events.length, 2);
  assert.equal(client.sessions.get("ses_pm").snapshot_json.eventCursor, 7);
});

test("authenticates and validates the reconciliation HTTP boundary", async () => {
  assert.equal(await serveSessionSupervisionReconciliation({
    method: "GET", url: "/healthz", headers: {}, token,
    readBody: async () => request, reconcile: async () => assert.fail(),
  }), null);
  assert.equal((await serveSessionSupervisionReconciliation({
    method: "POST", url: "/v1/session-supervision/reconciliations", headers: {}, token,
    readBody: async () => request, reconcile: async () => assert.fail(),
  })).status, 401);
  await assert.rejects(serveSessionSupervisionReconciliation({
    method: "POST", url: "/v1/session-supervision/reconciliations",
    headers: { authorization: `Bearer ${token}` }, token,
    readBody: async () => request, reconcile: async () => assert.fail(),
  }), InvalidSessionSupervisionReconciliationRequestError);
  const result = await serveSessionSupervisionReconciliation({
    method: "POST", url: "/v1/session-supervision/reconciliations",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, token,
    readBody: async () => request,
    reconcile: async (body) => ({
      version: "codeops.session-supervision-reconciliation-result/v1",
      idempotencyKey: body.idempotencyKey,
      supervisorSessionId: body.supervisorSessionId,
      projected: [{ childSessionId: "ses_worker", disposition: "created", eventCursor: 6 }],
    }),
  });
  assert.equal(result.status, 200);
});
