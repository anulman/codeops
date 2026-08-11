import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionJobInitializer,
} from "../dist/initialization.js";
import { SessionRuntimeTransportError } from "../dist/transport.js";

const token = "i".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";

function request() {
  return {
    version: "codeops.session-job-initialization/v1",
    sessionId: "ses_video_1",
    identity: {
      repository: "example-org/example-repository",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "video-proof-1",
      runId: "video-proof-job-1",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    leaseId,
    holderId: "session-job:video-proof-1",
  };
}

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => ["prompt", "cancel", "checkpoint", "hibernate"].includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function response(overrides = {}) {
  return {
    version: "codeops.session-job-initialization-result/v1",
    disposition: "created",
    modelProxyToken: `v1.${Buffer.from("session-token").toString("base64url")}.${"s".repeat(43)}`,
    snapshot: {
      version: "codeops.session-snapshot/v1",
      sessionId: "ses_video_1",
      generation: 1,
      state: "running",
      identity: request().identity,
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
      capabilities: capabilities(),
      updatedAt: "2026-08-05T03:15:00.000Z",
      ...overrides,
    },
  };
}

function hibernatedDuplicateResponse() {
  return {
    ...response({
      generation: 2,
      state: "hibernated",
      lease: {
        leaseId: "22222222-2222-4222-8222-222222222222",
        generation: 2,
        status: "released",
        releasedAt: "2026-08-05T03:20:00.000Z",
      },
      checkpoint: {
        version: "codeops.session-checkpoint/v1",
        checkpointId: "33333333-3333-4333-8333-333333333333",
        sessionId: "ses_video_1",
        generation: 2,
        baseSha: "a".repeat(40),
        patchDigest: `sha256:${"b".repeat(64)}`,
        acpSessionId: "acp-session-video-1",
        eventCursor: 10,
        evidenceReferences: [],
        createdAt: "2026-08-05T03:20:00.000Z",
      },
      eventCursor: 10,
      capabilities: capabilities().map((capability) =>
        capability.action === "resume" || capability.action === "fork"
          ? { action: capability.action, availability: "enabled" }
          : capability.action === "archive"
            ? { action: capability.action, availability: "enabled" }
            : { action: capability.action, availability: "disabled", reason: "Unavailable." }),
      updatedAt: "2026-08-05T03:20:00.000Z",
    }),
    disposition: "duplicate",
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

test("initializes one exact root session through the Job-only bearer", async () => {
  const calls = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return json(response());
    },
  });
  const result = await initializer.initialize(request());
  assert.equal(result.disposition, "created");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://codeops-control-gateway:8080/v1/session-jobs/initializations",
  );
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(calls[0].body, request());
});

test("rejects a valid-looking response that drifts from the Job root", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(response({ sessionId: "ses_other" })),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

test("rejects drift in optional CodeOps session identity", async () => {
  const codeOpsRequest = {
    ...request(),
    identity: {
      ...request().identity,
      workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
      agentRole: "coding",
      round: 1,
    },
  };
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(response()),
  });
  await assert.rejects(
    initializer.initialize(codeOpsRequest),
    /root identity/,
  );
});

test("accepts an exact duplicate root whose successor lease was released", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(hibernatedDuplicateResponse()),
  });
  const result = await initializer.initialize(request());
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.snapshot.state, "hibernated");
  assert.equal(result.snapshot.lease.status, "released");
  assert.notEqual(result.snapshot.lease.leaseId, request().leaseId);
});

test("rejects a created root without the exact requested active lease", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json({
      ...hibernatedDuplicateResponse(),
      disposition: "created",
    }),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

test("rejects initialization without short-lived model authority", async () => {
  const { modelProxyToken: _removed, ...missingToken } = response();
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(missingToken),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

test("inherits strict origin, token, status, type, and body bounds", async () => {
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://user@gateway.test",
      token,
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test/path",
      token,
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test",
      token: "short",
    }),
    SessionRuntimeTransportError,
  );
  for (const raw of [
    new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    json({}, 200, { "content-length": String(1024 * 1024 + 1) }),
  ]) {
    const initializer = new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test",
      token,
      fetch: async () => raw,
    });
    await assert.rejects(
      initializer.initialize(request()),
      SessionRuntimeTransportError,
    );
  }
});
