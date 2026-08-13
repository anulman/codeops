import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createSessionBrokerClient,
  parseSessionBrokerBaseUrl,
} from "../src/lib/sessionBroker.server.ts";

const token = "t".repeat(32);
const writeToken = "w".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("allows an ephemeral loopback broker port only outside production", () => {
  assert.equal(
    parseSessionBrokerBaseUrl("http://127.0.0.1:43127", "development").port,
    "43127",
  );
  assert.equal(
    parseSessionBrokerBaseUrl("http://127.0.0.1:43127", "production", true).port,
    "43127",
  );
  assert.throws(
    () => parseSessionBrokerBaseUrl("http://127.0.0.1:43127", "production"),
    /exact service origin|HTTPS/,
  );
});

test("keeps the read token server-side and validates all fleet snapshots", async () => {
  const calls = [];
  const client = createSessionBrokerClient({
    baseUrl: parseSessionBrokerBaseUrl("http://codeops-control-gateway:8080", "production"),
    readToken: token,
    writeToken,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return json({ version: "codeops.session-fleet/v1", sessions: [snapshot()] });
    },
  });
  assert.equal((await client.listSessions(25))[0].sessionId, "ses_91a4");
  assert.equal(calls[0].url, "http://codeops-control-gateway:8080/v1/sessions?limit=25");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, "error");
  await assert.rejects(client.listSessions(201));
});

test("rejects wrong identities and discontinuous event pages", async () => {
  const wrongSession = createSessionBrokerClient({
    baseUrl: new URL("https://broker.example/"),
    readToken: token,
    writeToken,
    fetch: async () => json({
      version: "codeops.session-detail/v1",
      session: { ...snapshot(), sessionId: "ses_foreign" },
    }),
  });
  await assert.rejects(wrongSession.getSession("ses_91a4"), /wrong session identity/);

  const skippedEvent = createSessionBrokerClient({
    baseUrl: new URL("https://broker.example/"),
    readToken: token,
    writeToken,
    fetch: async () => json({
      version: "codeops.session-events/v1",
      sessionId: "ses_91a4",
      afterCursor: 184,
      nextCursor: 186,
      events: [event({ cursor: 186 })],
    }),
  });
  await assert.rejects(
    skippedEvent.getEvents({ sessionId: "ses_91a4", afterCursor: 184 }),
    /contiguous/,
  );
});

test("allows an explicit missing session but fails closed on other upstream responses", async () => {
  const missing = createSessionBrokerClient({
    baseUrl: new URL("https://broker.example/"),
    readToken: token,
    writeToken,
    fetch: async () => json({ status: "not-found" }, 404),
  });
  assert.equal(await missing.getSession("ses_missing"), null);
  await assert.rejects(missing.listSessions(), /status 404/);

  assert.throws(() => parseSessionBrokerBaseUrl("http://example.com:8080/", "production"), /HTTPS/);
  assert.throws(() => parseSessionBrokerBaseUrl("https://broker.example/path", "production"), /exact service origin/);
  assert.throws(() => createSessionBrokerClient({ baseUrl: new URL("https://broker.example/"), readToken: "short", writeToken }));
  assert.throws(() => createSessionBrokerClient({ baseUrl: new URL("https://broker.example/"), readToken: token, writeToken: token }), /must be distinct/);
});

test("uses the separate write credential and binds command responses", async () => {
  const calls = [];
  const command = {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    type: "cancel",
    reason: "Operator cancelled the run.",
  };
  const client = createSessionBrokerClient({
    baseUrl: new URL("https://broker.example/"),
    readToken: token,
    writeToken,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "33333333-3333-4333-8333-333333333333",
        sessionId: command.sessionId,
        generation: command.generation,
        leaseId: command.leaseId,
        idempotencyKey: command.idempotencyKey,
        type: command.type,
        eventCursor: 185,
        snapshot: {
          ...snapshot(),
          state: "cancelled",
          lease: {
            leaseId,
            generation: 3,
            status: "released",
            releasedAt: "2026-08-04T03:04:01.000Z",
          },
          eventCursor: 185,
          capabilities: capabilities().map(({ action }) =>
            ["fork", "archive"].includes(action)
              ? { action, availability: action === "archive" ? "enabled" : "disabled", ...(action === "fork" ? { reason: "A checkpoint is required." } : {}) }
              : { action, availability: "disabled", reason: "Unavailable." },
          ),
          updatedAt: "2026-08-04T03:04:01.000Z",
        },
        committedAt: "2026-08-04T03:04:01.000Z",
        disposition: "committed",
      });
    },
  });
  const result = await client.executeCommand({ command, principalId: "operator@example.com" });
  assert.equal(result.disposition, "committed");
  assert.equal(calls[0].url, "https://broker.example/v1/sessions/ses_91a4/commands");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${writeToken}`);
  assert.equal(calls[0].init.headers["X-CodeOps-Principal"], "operator@example.com");
  assert.deepEqual(JSON.parse(calls[0].init.body), command);
});

test("accepts an identity-bound asynchronous runtime command submission", async () => {
  const command = {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    type: "prompt",
    prompt: "Show the live runtime handoff.",
  };
  const client = createSessionBrokerClient({
    baseUrl: new URL("https://broker.example/"),
    readToken: token,
    writeToken,
    fetch: async () => json({
      version: "codeops.session-command-accepted/v1",
      disposition: "accepted",
      dispatchId: "44444444-4444-4444-8444-444444444444",
      sessionId: command.sessionId,
      generation: command.generation,
      leaseId: command.leaseId,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
    }),
  });
  const result = await client.executeCommand({
    command,
    principalId: "operator@example.com",
  });
  assert.equal(result.disposition, "accepted");
  assert.equal(result.type, "prompt");
});

test("server functions bind the private UI service principal", async () => {
  const dataSource = await readFile(new URL("../src/lib/sessionBroker.data.ts", import.meta.url), "utf8");
  const contextSource = await readFile(new URL("../src/lib/agentsContext.ts", import.meta.url), "utf8");
  assert.equal((dataSource.match(/\.middleware\(\[agentsContextMiddleware\]\)/g) ?? []).length, 4);
  assert.doesNotMatch(dataSource, /TOKEN_FILE|readFile/);
  assert.match(contextSource, /codeops:agents-ui/);
  assert.doesNotMatch(contextSource, /requestHeader|process\.env/i);
});
