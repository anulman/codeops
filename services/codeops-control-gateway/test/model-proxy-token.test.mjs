import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createModelProxyToken } from "@codeops/codeops-contracts/model-proxy";

test("issues one exact 75-minute session-bound model proxy token", () => {
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
});
