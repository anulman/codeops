import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createClaimedDispatchModelProxyToken,
  createModelProxyToken,
  createSessionModelProxyToken,
} from "@codeops/codeops-contracts/model-proxy";

test("preserves one exact 75-minute non-session model proxy token", () => {
  const signingKey = "m".repeat(64);
  const issuedAt = new Date("2026-08-10T01:00:00.000Z");
  const token = createModelProxyToken({
    subject: "ses_agents_control_plane_1",
    signingKey,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    issuedAt,
  });
  const [version, encoded, signature] = token.split(".");
  assert.equal(version, "v1");
  assert.equal(
    signature,
    createHmac("sha256", signingKey).update(`v1.${encoded}`).digest("base64url"),
  );
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(payload, {
    aud: "codeops-model-proxy",
    sub: "ses_agents_control_plane_1",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumRequests: 200,
    maximumOutputTokens: 32768,
    iat: 1786323600,
    exp: 1786328100,
  });
});

test("issues a distinct session token with exact durable budget authority", () => {
  const signingKey = "m".repeat(64);
  const issuedAt = new Date("2026-08-10T01:00:00.000Z");
  const token = createSessionModelProxyToken({
    subject: "ses_agents_control_plane_1",
    budgetId: "budget_agents_control_plane_1",
    generation: 3,
    signingKey,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    issuedAt,
  });
  const [, encoded] = token.split(".");
  assert.deepEqual(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    {
      aud: "codeops-model-proxy",
      sub: "ses_agents_control_plane_1",
      budgetId: "budget_agents_control_plane_1",
      generation: 3,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maximumRequests: 200,
      maximumOutputTokens: 32768,
      iat: 1786323600,
      exp: 1786328100,
    },
  );
});

test("binds a five-minute token to one claimed dispatch and active lease", () => {
  const token = createClaimedDispatchModelProxyToken({
    subject: "ses_agents_control_plane_1",
    budgetId: "budget_agents_control_plane_1",
    generation: 3,
    leaseId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    issuedAt: new Date("2026-08-10T01:00:00.000Z"),
    expiresAt: new Date("2026-08-10T01:05:00.000Z"),
  });
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.equal(payload.leaseId, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.dispatchId, "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.exp - payload.iat, 300);
});

test("rejects invalid token subjects and reusable signing-key bounds", () => {
  assert.throws(() => createModelProxyToken({
    subject: "unsafe/session",
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }));
  assert.throws(() => createModelProxyToken({
    subject: "ses_1",
    signingKey: "short",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }));
  assert.throws(() => createModelProxyToken({
    subject: "ses_1",
    signingKey: "m".repeat(64),
    model: "unsafe/model",
    reasoningEffort: "high",
  }));
  assert.throws(() => createModelProxyToken({
    subject: "ses_1",
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumRequests: 0,
  }));
  assert.throws(() => createModelProxyToken({
    subject: "ses_1",
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maximumOutputTokens: 100_001,
  }));
  assert.throws(() => createSessionModelProxyToken({
    subject: "ses_1",
    budgetId: "unsafe/budget",
    generation: 1,
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }));
  assert.throws(() => createSessionModelProxyToken({
    subject: "ses_1",
    budgetId: "budget_1",
    generation: 0,
    signingKey: "m".repeat(64),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }));
});
