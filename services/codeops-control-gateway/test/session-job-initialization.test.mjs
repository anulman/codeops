import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJsonText } from "@codeops/codeops-contracts";
import {
  InvalidSessionJobInitializationRequestError,
  initializeAdmittedChildSessionFromJob,
  initializeSessionFromJob,
  serveSessionJobInitialization,
} from "../dist/session-job-initialization.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";

const token = "j".repeat(32);
const request = {
  version: "codeops.session-job-initialization/v1",
  sessionId: "ses_video_1",
  identity: {
    repository: "example-org/example-repository",
    branch: "feat/agents-ui",
    baseSha: "a".repeat(40),
    workflowId: "agents-video-proof",
    runId: "agents-video-proof-1",
    parentSessionId: null,
    forkedAtCursor: null,
  },
  leaseId: "11111111-1111-4111-8111-111111111111",
  holderId: "job:agents-video-proof",
  ownerPrincipalId: "access:aidan@example.com",
};

function fakeDatabase(existing = null) {
  const calls = [];
  const state = { snapshot: existing };
  return {
    calls,
    state,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.startsWith("INSERT INTO codeops.sessions")) {
        if (state.snapshot !== null) return { rowCount: 0, rows: [] };
        state.snapshot = JSON.parse(values[3]);
        state.ownerPrincipalId = values[5];
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT snapshot_json")) {
        return { rowCount: 1, rows: [{
          snapshot_json: state.snapshot,
          owner_principal_id: state.ownerPrincipalId ?? request.ownerPrincipalId,
        }] };
      }
      return { rowCount: null, rows: [] };
    },
  };
}

test("creates one running root session and one commandless creation event", async () => {
  const database = fakeDatabase();
  const result = await initializeSessionFromJob(database, {
    request,
    now: () => new Date("2026-08-05T03:00:00.000Z"),
  });
  assert.equal(result.disposition, "created");
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.snapshot.eventCursor, 1);
  assert.equal(result.snapshot.lease.holderId, request.holderId);
  assert.equal(result.snapshot.budget.version, "codeops.session-budget/v2");
  assert.equal(result.snapshot.budget.budgetId, request.sessionId);
  assert.deepEqual(result.snapshot.budget.usage, {
    elapsedSeconds: 0,
    providerRequests: 0,
    outputTokens: 0,
    observedInputTokens: 0,
    observedTotalTokens: 0,
    activeChildren: 0,
  });
  assert.equal(result.snapshot.budget.exhaustedLimit, null);
  const budget = database.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_model_budgets"),
  );
  assert.deepEqual(budget.values, [
    request.sessionId,
    request.sessionId,
    "2026-08-05T03:00:00.000Z",
    200,
    1_000_000,
    0,
    0,
    0,
    0,
    0,
    1,
    "2026-08-05T03:00:00.000Z",
  ]);
  const event = database.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_events"),
  );
  assert.match(event.text, /NULL/);
  assert.equal(event.values[1], request.sessionId);
  assert.equal(database.calls.at(-1).text, "COMMIT");
});

test("replays the current session for an exact root identity and rejects drift", async () => {
  const first = fakeDatabase();
  const created = await initializeSessionFromJob(first, {
    request,
    now: () => new Date("2026-08-05T03:00:00.000Z"),
  });
  const retry = fakeDatabase({
    ...created.snapshot,
    eventCursor: 2,
    updatedAt: "2026-08-05T03:01:00.000Z",
  });
  const duplicate = await initializeSessionFromJob(retry, {
    request,
    now: () => new Date("2026-08-05T03:02:00.000Z"),
  });
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(duplicate.snapshot.eventCursor, 2);
  const recoveredBudget = retry.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_model_budgets"),
  );
  assert.ok(recoveredBudget);
  assert.match(recoveredBudget.text, /ON CONFLICT \(session_id\) DO NOTHING/);
  assert.deepEqual(recoveredBudget.values, [
    request.sessionId,
    request.sessionId,
    "2026-08-05T03:00:00.000Z",
    200,
    1_000_000,
    0,
    0,
    0,
    0,
    0,
    1,
    "2026-08-05T03:00:00.000Z",
  ]);

  const wrongOwner = fakeDatabase(created.snapshot);
  wrongOwner.state.ownerPrincipalId = "access:mallory@example.com";
  await assert.rejects(
    initializeSessionFromJob(wrongOwner, { request }),
    /different Job identity/,
  );
  assert.equal(wrongOwner.calls.at(-1).text, "ROLLBACK");

  const drift = fakeDatabase({
    ...created.snapshot,
    identity: { ...created.snapshot.identity, baseSha: "b".repeat(40) },
  });
  await assert.rejects(
    initializeSessionFromJob(drift, { request }),
    /different Job identity/,
  );
  assert.equal(drift.calls.at(-1).text, "ROLLBACK");
});

test("authenticates and validates the exact Job initialization route", async () => {
  const response = await serveSessionJobInitialization({
    method: "POST",
    url: "/v1/session-jobs/initializations",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    token,
    readBody: async () => request,
    initialize: async () => ({
      version: "codeops.session-job-initialization-result/v1",
      disposition: "created",
      snapshot: (await initializeSessionFromJob(fakeDatabase(), { request })).snapshot,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.disposition, "created");

  assert.deepEqual(
    await serveSessionJobInitialization({
      method: "POST",
      url: "/v1/session-jobs/initializations",
      headers: {},
      token,
      readBody: async () => request,
      initialize: async () => assert.fail("must not initialize"),
    }),
    { status: 401, body: { status: "unauthorized" } },
  );
  await assert.rejects(
    serveSessionJobInitialization({
      method: "POST",
      url: "/v1/session-jobs/initializations",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      token,
      readBody: async () => request,
      initialize: async () => assert.fail("must not initialize"),
    }),
    InvalidSessionJobInitializationRequestError,
  );
});

test("replays one exact admitted child and rejects stale authority without creating a Session", async () => {
  const source = { catalogKey: "codeops", repository: "example-org/example-repository",
    checkoutPath: "sources/codeops", requestedRef: "main", resolvedSha: "a".repeat(40) };
  const secondarySource = { catalogKey: "shared", repository: "example-org/shared-library",
    checkoutPath: "sources/shared", requestedRef: "main", resolvedSha: "c".repeat(40) };
  const policy = { version: "codeops.session-policy/v1", mode: "implement",
    workspaceAccess: "bounded-writes", modelCalls: "allowed",
    modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } };
  const bytes = Buffer.from("exact server context\n");
  const attachment = { attachmentId: "brief", name: "brief.txt", mimeType: "text/plain",
    sizeBytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    content: bytes.toString("base64") };
  const identity = { version: "codeops.session-workspace-identity/v1", policy,
    contextAttachments: [{ ...attachment, content: undefined }],
    workspace: { version: "codeops.workspace/v1", sources: [source, secondarySource],
      scratchPath: "scratch" },
    workflowId: "workflow-1", runId: "run-1", parentSessionId: "session-parent", forkedAtCursor: 2 };
  delete identity.contextAttachments[0].content;
  const seeded = await initializeSessionFromJob(fakeDatabase(), { request, now: () => new Date("2026-08-05T03:00:00.000Z") });
  const child = { ...seeded.snapshot, sessionId: "session-child", identity,
    lease: { ...seeded.snapshot.lease, holderId: "runtime-worker:child" } };
  const admissionId = "22222222-2222-4222-8222-222222222222";
  const approvalId = "33333333-3333-4333-8333-333333333333";
  const dispatchId = "44444444-4444-4444-8444-444444444444";
  const image = `registry.example/image@sha256:${"b".repeat(64)}`;
  const materialization = { version: "codeops.admitted-child-materialization-input/v1",
    admissionId, admissionDigest: `sha256:${"1".repeat(64)}`, approvalId,
    approvalDigest: `sha256:${"2".repeat(64)}`, parentSessionId: "session-parent",
    childSessionId: child.sessionId, childDispatchId: dispatchId,
    principalId: request.ownerPrincipalId,
    workItem: { repository: source.repository, provider: { kind: "plane",
      workspaceId: "55555555-5555-4555-8555-555555555555",
      projectId: "66666666-6666-4666-8666-666666666666" }, workItemId: "88888888-8888-4888-8888-888888888888",
      workflowId: "workflow-1", runId: "run-1", sourceSha: source.resolvedSha },
    source, policy, profile: "custom", release: "v0.5.0-alpha.58",
    images: { agent: image, runtimeWorker: image }, contextAttachments: [attachment], generation: 1,
    lease: { leaseId: child.lease.leaseId, holderId: child.lease.holderId,
      acquiredAt: child.lease.acquiredAt, expiresAt: child.lease.expiresAt },
    workflowId: "workflow-1", runId: "run-1", identity, initialDispatch: {
      version: "codeops.session-runtime-dispatch/v1", dispatchId, principalId: request.ownerPrincipalId,
      command: { version: "codeops.session-command/v1", sessionId: child.sessionId, generation: 1,
        leaseId: child.lease.leaseId, idempotencyKey: "77777777-7777-4777-8777-777777777777",
        type: "prompt", prompt: "Implement it." }, snapshot: child,
      dispatchedAt: "2026-08-05T03:00:00.000Z" }, admittedAt: "2026-08-05T03:00:00.000Z" };
  const inputDigest = `sha256:${createHash("sha256").update(canonicalJsonText(materialization)).digest("hex")}`;
  const v3 = { version: "codeops.session-job-initialization/v3", admissionId, approvalId,
    dispatchId, inputDigest, sessionId: child.sessionId, generation: 1, identity,
    leaseId: child.lease.leaseId, holderId: child.lease.holderId,
    ownerPrincipalId: request.ownerPrincipalId, parentSessionId: "session-parent",
    repository: source.repository, sourceSha: source.resolvedSha, workItemId: "88888888-8888-4888-8888-888888888888",
    profile: "custom", release: "v0.5.0-alpha.58", images: materialization.images };
  const database = (authorityCurrent = true, snapshotJson = child,
    materializationState = "runtime-authorized") => ({ calls: [], async query(text) {
    this.calls.push(text);
    if (text.includes("SELECT materialization.input_json")) return { rowCount: 1, rows: [{
      input_json: materialization, input_digest: inputDigest,
      initial_dispatch_digest: `sha256:${createHash("sha256")
        .update(canonicalJsonText(materialization.initialDispatch)).digest("hex")}`,
      state: materializationState,
      snapshot_json: snapshotJson, owner_principal_id: request.ownerPrincipalId,
      authority_current: authorityCurrent }] };
    return { rowCount: 1, rows: [] };
  } });
  for (let replay = 0; replay < 2; replay += 1) {
    const db = database();
    const result = await initializeAdmittedChildSessionFromJob(db, {
      request: v3, now: () => new Date("2026-08-05T03:10:00.000Z") });
    assert.equal(result.disposition, "duplicate");
    assert.deepEqual(result.contextAttachments, [attachment]);
    assert.equal(result.initialDispatchDigest,
      `sha256:${createHash("sha256").update(canonicalJsonText(materialization.initialDispatch)).digest("hex")}`);
    assert.equal(db.calls.some((sql) => sql.includes("INSERT INTO codeops.sessions")), false);
  }
  assert.equal((await initializeAdmittedChildSessionFromJob(
    database(true, child, "success-finalizing"), {
      request: v3, now: () => new Date("2026-08-05T03:10:00.000Z"),
    })).disposition, "duplicate");
  const stale = database(false);
  await assert.rejects(initializeAdmittedChildSessionFromJob(stale, {
    request: v3, now: () => new Date("2026-08-05T03:10:00.000Z") }), /authority drifted/);
  assert.equal(stale.calls.at(-1), "ROLLBACK");

  const replacementLeaseId = "99999999-9999-4999-8999-999999999999";
  const leaseDrifts = [
    { ...child, state: "hibernated", capabilities: sessionCapabilitiesFor("hibernated", false),
      lease: { leaseId: child.lease.leaseId, generation: child.lease.generation,
        status: "released", releasedAt: "2026-08-05T03:05:00.000Z" } },
    { ...child, lease: { ...child.lease, leaseId: replacementLeaseId } },
    { ...child, lease: { ...child.lease, holderId: "runtime-worker:replacement" } },
    { ...child, generation: 2, lease: { ...child.lease, generation: 2 } },
    { ...child, lease: { ...child.lease, expiresAt: "2026-08-05T04:16:00.000Z" } },
  ];
  for (const drifted of leaseDrifts) {
    await assert.rejects(initializeAdmittedChildSessionFromJob(database(true, drifted), {
      request: v3, now: () => new Date("2026-08-05T03:10:00.000Z") }),
    /authority drifted/);
  }
  await assert.rejects(initializeAdmittedChildSessionFromJob(database(), {
    request: v3, now: () => new Date(materialization.lease.expiresAt) }),
  /authority drifted/);
});
