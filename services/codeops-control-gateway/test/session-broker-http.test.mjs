import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  InvalidSessionReadRequestError,
  serveSessionBrokerRead,
} from "../dist/session-broker-http.js";

const token = "t".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";
const legacyWorkspaceFixtureUrl = new URL(
  "../../../packages/codeops-contracts/test/fixtures/codeops-0.4.2-workspace-session.json",
  import.meta.url,
);

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => ["prompt", "cancel", "checkpoint", "hibernate"].includes(action)
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
      acquiredAt: "2026-08-04T03:00:00.000Z",
      expiresAt: "2026-08-04T03:05:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(),
    updatedAt: "2026-08-04T03:04:00.000Z",
  };
}

function event() {
  return {
    version: "codeops.session-event/v1",
    eventId: `sha256:${"c".repeat(64)}`,
    sessionId: "ses_91a4",
    generation: 3,
    cursor: 185,
    type: "command_committed",
    occurredAt: "2026-08-04T03:04:01.000Z",
  };
}

class FakeClient {
  constructor({ sessions = [snapshot()], events = [event()] } = {}) {
    this.sessions = sessions;
    this.events = events;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("provider_effect_receipts")) {
      return { rowCount: 1, rows: [{
        effect_id: `githubmutation-${"a".repeat(64)}`,
        provider: "github",
        repository: "anulman/codeops",
        operation: "check_rerun",
        pull_request_number: null,
        target_id: "1234",
        expected_head_sha: "b".repeat(40),
        payload_digest: `sha256:${"c".repeat(64)}`,
        permission_digest: `sha256:${"d".repeat(64)}`,
        session_id: "ses_91a4",
        dispatch_id: "22222222-2222-4222-8222-222222222222",
        state: "unknown",
        authorized_at: "2026-08-04T03:00:00.000Z",
        attempted_at: "2026-08-04T03:00:01.000Z",
        resolved_at: null,
        reconciliation_action: "inspect_check_attempts",
        resolution_summary: null,
      }] };
    }
    if (text.includes("session_events")) {
      return { rowCount: this.events.length, rows: this.events.map((value) => ({ event_json: value })) };
    }
    const rows = /WHERE (?:parent\.)?session_id/.test(text)
      ? this.sessions.filter((value) => value.sessionId === values[0])
      : this.sessions;
    return { rowCount: rows.length, rows: rows.map((value) => ({ snapshot_json: value })) };
  }
}

function request(database, url, overrides = {}) {
  return serveSessionBrokerRead({
    method: "GET",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "x-codeops-principal": "access:aidan@example.com",
    },
    token,
    database,
    ...overrides,
  });
}

test("authenticates and bounds the fleet read", async () => {
  const database = new FakeClient();
  const result = await request(database, "/v1/sessions?limit=25");
  assert.equal(result.status, 200);
  assert.equal(result.body.version, "codeops.session-fleet/v1");
  assert.equal(result.body.sessions.length, 1);
  assert.deepEqual(database.calls[0].values, [25, "access:aidan@example.com"]);

  const unauthorized = await request(database, "/v1/sessions", { headers: {} });
  assert.deepEqual(unauthorized, { status: 401, body: { status: "unauthorized" } });
  await assert.rejects(request(database, "/v1/sessions?limit=201"), InvalidSessionReadRequestError);
  await assert.rejects(request(database, "/v1/sessions?unknown=1"), /unknown query/);
});

test("serves an owner-filtered fleet from a serialized 0.4.2 workspace snapshot", async () => {
  const fixture = JSON.parse(await readFile(legacyWorkspaceFixtureUrl, "utf8"));
  const database = new FakeClient({ sessions: [fixture.snapshot] });
  const result = await request(database, "/v1/sessions?limit=25", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-codeops-principal": fixture.ownerPrincipalId,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.sessions.length, 1);
  assert.equal(result.body.sessions[0].sessionId, fixture.snapshot.sessionId);
  assert.equal(result.body.sessions[0].identity.policy.mode, "implement");
  assert.deepEqual(result.body.sessions[0].identity.contextAttachments, []);
  assert.deepEqual(database.calls[0].values, [25, fixture.ownerPrincipalId]);
});

test("loads an exact session and returns an explicit miss", async () => {
  const database = new FakeClient();
  const found = await request(database, "/v1/sessions/ses_91a4");
  assert.equal(found.status, 200);
  assert.equal(found.body.session.sessionId, "ses_91a4");

  const missing = await request(database, "/v1/sessions/ses_missing");
  assert.deepEqual(missing, { status: 404, body: { status: "not-found" } });
  assert.equal(await request(database, "/v1/not-a-session"), null);
});

test("loads one strict cursor page and exposes its committed next cursor", async () => {
  const database = new FakeClient();
  const result = await request(
    database,
    "/v1/sessions/ses_91a4/events?afterCursor=184&limit=50",
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.nextCursor, 185);
  assert.equal(result.body.events[0].cursor, 185);
  assert.deepEqual(database.calls[0].values, [
    "ses_91a4", 184, 50, "access:aidan@example.com",
  ]);
  await assert.rejects(request(database, "/v1/sessions/ses_91a4/events?afterCursor=-1"), /integer/);
  await assert.rejects(request(database, "/v1/sessions/ses_91a4/events?limit=1&limit=2"), /one integer/);
});

test("lists bounded provider effects with unknown outcomes first", async () => {
  const database = new FakeClient();
  const result = await request(database, "/v1/provider-effects?limit=25");
  assert.equal(result.status, 200);
  assert.equal(result.body.version, "codeops.provider-effect-fleet/v1");
  assert.equal(result.body.effects[0].state, "unknown");
  assert.equal(result.body.effects[0].reconciliationAction, "inspect_check_attempts");
  assert.deepEqual(database.calls[0].values, [25, "access:aidan@example.com"]);
  await assert.rejects(request(database, "/v1/provider-effects?limit=201"));
});
