import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionJobInitializationRequestError,
  initializeSessionFromJob,
  serveSessionJobInitialization,
} from "../dist/session-job-initialization.js";

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
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT snapshot_json")) {
        return { rowCount: 1, rows: [{ snapshot_json: state.snapshot }] };
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
  assert.deepEqual(result.snapshot.budget.usage, {
    elapsedSeconds: 0,
    totalTokens: 0,
    modelRequests: 0,
    activeChildren: 0,
  });
  assert.equal(result.snapshot.budget.exhaustedLimit, null);
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
