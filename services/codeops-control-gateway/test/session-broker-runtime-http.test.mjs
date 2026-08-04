import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionRuntimeRequestError,
  serveSessionRuntime,
} from "../dist/session-broker-runtime-http.js";

const token = "r".repeat(32);
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";

function completion(overrides = {}) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    observedEventCursor: 184,
    type: "prompt",
    completedAt: "2026-08-04T19:05:00.000Z",
    ...overrides,
  };
}

function request(overrides = {}) {
  const claims = [];
  const completions = [];
  return {
    claims,
    completions,
    promise: serveSessionRuntime({
      method: "POST",
      url: "/v1/session-runtime/claims",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      token,
      workerId: "acp-worker:primary",
      readBody: async () => ({
        version: "codeops.session-runtime-claim-request/v1",
        leaseMs: 300_000,
      }),
      claim: async (input) => {
        claims.push(input);
        return null;
      },
      complete: async (input) => {
        completions.push(input);
        return { disposition: "committed" };
      },
      ...overrides,
    }),
  };
}

test("authenticates one server-bound worker before claiming", async () => {
  const submitted = request();
  assert.deepEqual(await submitted.promise, {
    status: 200,
    body: {
      version: "codeops.session-runtime-claim-response/v1",
      claim: null,
    },
  });
  assert.deepEqual(submitted.claims, [
    { workerId: "acp-worker:primary", leaseMs: 300_000 },
  ]);

  const unauthorized = request({ headers: {} });
  assert.deepEqual(await unauthorized.promise, {
    status: 401,
    body: { status: "unauthorized" },
  });
  assert.equal(unauthorized.claims.length, 0);
});

test("binds a completion to the path, claim, and authenticated worker", async () => {
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/completions`,
    readBody: async () => ({
      version: "codeops.session-runtime-completion-request/v1",
      claimToken,
      completion: completion(),
    }),
  });
  assert.deepEqual(await submitted.promise, {
    status: 200,
    body: { disposition: "committed" },
  });
  assert.deepEqual(submitted.completions, [
    {
      dispatchId,
      claimToken,
      workerId: "acp-worker:primary",
      completion: completion(),
    },
  ]);
});

test("rejects ambiguous or drifting runtime requests before persistence", async () => {
  for (const submitted of [
    request({ url: "/v1/session-runtime/claims?limit=1" }),
    request({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
    }),
    request({
      readBody: async () => ({
        version: "codeops.session-runtime-claim-request/v1",
        leaseMs: 999,
      }),
    }),
    request({
      readBody: async () => {
        throw new SyntaxError("invalid JSON");
      },
    }),
    request({
      url: `/v1/session-runtime/dispatches/${dispatchId}/completions`,
      readBody: async () => ({
        version: "codeops.session-runtime-completion-request/v1",
        claimToken,
        completion: completion({
          dispatchId: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    }),
  ]) {
    await assert.rejects(submitted.promise, InvalidSessionRuntimeRequestError);
    assert.equal(submitted.claims.length, 0);
    assert.equal(submitted.completions.length, 0);
  }
});

test("ignores unrelated methods and paths", async () => {
  assert.equal(await request({ method: "GET" }).promise, null);
  assert.equal(await request({ url: "/v1/sessions" }).promise, null);
});
