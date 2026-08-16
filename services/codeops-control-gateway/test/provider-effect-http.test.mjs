import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidProviderEffectRequestError,
  serveProviderEffectReconciliation,
} from "../dist/provider-effect-http.js";

const token = "t".repeat(32);
const effectId = `githubmutation-${"a".repeat(64)}`;

function request(overrides = {}) {
  return serveProviderEffectReconciliation({
    method: "POST",
    url: `/v1/provider-effects/${effectId}/reconcile`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-codeops-principal": "codeops:agents-ui",
    },
    token,
    readBody: async () => ({
      version: "codeops.provider-effect-reconciliation-command/v1",
    }),
    reconcile: async (identity) => ({
      version: "codeops.github-mutation-reconciliation-result/v1",
      state: "unknown",
      result: null,
      summary: `Read ${identity.effectId} for ${identity.principalId}.`,
    }),
    resolve: async (resolution) => ({
      version: "codeops.provider-effect-operator-resolution-result/v1",
      effectId: resolution.effectId,
      state: "operator_resolved",
      resolution: resolution.resolution,
    }),
    ...overrides,
  });
}

test("authenticates and identity-binds one explicit reconciliation read", async () => {
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "unknown");
  assert.match(result.body.summary, /codeops:agents-ui/);
  assert.deepEqual(await request({ headers: {} }), {
    status: 401,
    body: { status: "unauthorized" },
  });
  assert.equal(await request({ method: "GET" }), null);
});

test("accepts one bounded identity-bound operator resolution", async () => {
  const result = await request({
    url: `/v1/provider-effects/${effectId}/resolve`,
    readBody: async () => ({
      version: "codeops.provider-effect-operator-resolution-command/v1",
      resolution: "accepted_unknown",
      summary: "The operator accepts that provider attribution is unavailable.",
      evidenceReferences: ["ticket:CODEOPS-123"],
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "operator_resolved");
  assert.equal(result.body.resolution, "accepted_unknown");
});

test("rejects malformed bodies, principals, and query parameters", async () => {
  await assert.rejects(
    request({ readBody: async () => ({ version: "wrong" }) }),
    InvalidProviderEffectRequestError,
  );
  await assert.rejects(
    request({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codeops-principal": "bad principal",
      },
    }),
    InvalidProviderEffectRequestError,
  );
  await assert.rejects(request({
    url: `/v1/provider-effects/${effectId}/reconcile?retry=true`,
  }), /does not accept query/);
});
