import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionRuntimeCompletion,
  SessionRuntimeTransport,
  SessionRuntimeTransportError,
} from "../dist/transport.js";

const token = "w".repeat(32);
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive", "delete",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function claim() {
  return {
    dispatch: {
      version: "codeops.session-runtime-dispatch/v1",
      dispatchId,
      principalId: "access:aidan@example.com",
      command: {
        version: "codeops.session-command/v1",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        prompt: "Continue the bounded implementation.",
      },
      snapshot: {
        version: "codeops.session-snapshot/v1",
        sessionId: "ses_91a4",
        generation: 3,
        state: "running",
        identity: {
          repository: "anulman/renoconcierge",
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
          acquiredAt: "2026-08-04T20:00:00.000Z",
          expiresAt: "2026-08-04T21:00:00.000Z",
        },
        checkpoint: null,
        pendingPermission: null,
        eventCursor: 184,
        capabilities: capabilities(),
        updatedAt: "2026-08-04T20:00:00.000Z",
      },
      dispatchedAt: "2026-08-04T20:00:00.000Z",
    },
    claimToken,
    claimExpiresAt: "2026-08-04T20:05:00.000Z",
    claimCount: 1,
  };
}

function completion(overrides = {}) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    observedEventCursor: 184,
    type: "prompt",
    completedAt: "2026-08-04T20:03:00.000Z",
    ...overrides,
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

test("claims and completes one exact dispatch through the worker-only boundary", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      if (url.endsWith("/claims")) {
        return json({
          version: "codeops.session-runtime-claim-response/v1",
          claim: claim(),
        });
      }
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 185,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 185 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });

  const result = await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    execute: async (runtimeDispatch) => {
      assert.deepEqual(runtimeDispatch, claim().dispatch);
      assert.equal("claimToken" in runtimeDispatch, false);
      return { type: "prompt" };
    },
  });
  assert.equal(result.disposition, "committed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(requests[0].body, {
    version: "codeops.session-runtime-claim-request/v1",
    leaseMs: 300_000,
  });
  assert.equal(
    requests[1].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/completions`,
  );
  assert.equal(requests[1].body.claimToken, claimToken);
  assert.deepEqual(requests[1].body.completion, completion());
});

test("returns null without invoking the executor when no dispatch is available", async () => {
  let executed = false;
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json({
      version: "codeops.session-runtime-claim-response/v1",
      claim: null,
    }),
  });
  assert.equal(await transport.runOne({
    leaseMs: 1_000,
    execute: async () => {
      executed = true;
      return completion();
    },
  }), null);
  assert.equal(executed, false);
});

test("builds the completion envelope from the claim instead of trusting the executor", () => {
  assert.deepEqual(
    buildSessionRuntimeCompletion(
      claim(),
      { type: "prompt" },
      new Date("2026-08-04T20:03:00.000Z"),
    ),
    completion(),
  );
  assert.throws(
    () => buildSessionRuntimeCompletion(
      claim(),
      { type: "prompt", dispatchId: "77777777-7777-4777-8777-777777777777" },
      new Date("2026-08-04T20:03:00.000Z"),
    ),
  );
  assert.throws(
    () => buildSessionRuntimeCompletion(
      claim(),
      {
        type: "checkpoint",
        material: {
          checkpointId: "77777777-7777-4777-8777-777777777777",
          patchDigest: `sha256:${"a".repeat(64)}`,
          acpSessionId: "acp-7",
          evidenceReferences: [],
        },
      },
      new Date("2026-08-04T20:03:00.000Z"),
    ),
    SessionRuntimeTransportError,
  );
});

test("rejects identity drift and expired claims before completion crosses the network", async () => {
  let completeCalls = 0;
  const direct = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => {
      completeCalls += 1;
      return json({});
    },
  });
  await assert.rejects(
    direct.complete(
      claim(),
      completion({ dispatchId: "77777777-7777-4777-8777-777777777777" }),
      () => new Date("2026-08-04T20:03:00.000Z"),
    ),
    SessionRuntimeTransportError,
  );
  assert.equal(completeCalls, 0);

  let claimCalls = 0;
  let executed = false;
  const expired = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => {
      claimCalls += 1;
      return json({
        version: "codeops.session-runtime-claim-response/v1",
        claim: claim(),
      });
    },
  });
  await assert.rejects(expired.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:05:00.000Z"),
    execute: async () => {
      executed = true;
      return { type: "prompt" };
    },
  }), SessionRuntimeTransportError);
  assert.equal(claimCalls, 1);
  assert.equal(executed, false);
});

test("fails closed on ambiguous origins, credentials, response types, and body bounds", async () => {
  for (const gatewayOrigin of [
    "https://user@gateway.test",
    "https://gateway.test/path",
    "ftp://gateway.test",
  ]) {
    assert.throws(
      () => new SessionRuntimeTransport({ gatewayOrigin, token }),
      SessionRuntimeTransportError,
    );
  }
  assert.throws(
    () => new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token: " short ",
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token,
      requestTimeoutMs: 999,
    }),
    SessionRuntimeTransportError,
  );

  for (const response of [
    new Response("no", { status: 503, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    json({}, 200, { "content-length": String(1024 * 1024 + 1) }),
    new Response("x".repeat(1024 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const transport = new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token,
      fetch: async () => response,
    });
    await assert.rejects(transport.claim(1_000), SessionRuntimeTransportError);
  }
});
