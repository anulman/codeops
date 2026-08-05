import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
  verifySessionProofApplyEvidence,
} from "./codeops-session-proof-apply-evidence.mjs";

const authorization = {
  planSha256: "a".repeat(64),
  stepId: "start-database",
  action: "operator-apply",
  artifact: "database",
  artifactSha256: "b".repeat(64),
  namespace: { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" },
};

function resources() {
  return sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
    ...resource,
    uid: `resource-uid-${index}`,
  }));
}

test("attests exactly the five applied database resource identities", () => {
  const evidence = buildSessionProofApplyEvidence({
    authorization,
    observedAt: "2026-08-05T19:35:00Z",
    resources: resources().reverse(),
  });
  assert.equal(evidence.artifactSha256, authorization.artifactSha256);
  assert.equal(evidence.resourceInventory.length, 5);
  assert.deepEqual(
    evidence.resourceInventory.map((resource) => resource.kind).sort(),
    ["ConfigMap", "Deployment", "NetworkPolicy", "Service", "ServiceAccount"].sort(),
  );
});

test("attests exactly the four applied gateway resource identities", () => {
  const gatewayAuthorization = {
    ...authorization,
    stepId: "start-gateway",
    artifact: "gateway",
  };
  const evidence = buildSessionProofApplyEvidence({
    authorization: gatewayAuthorization,
    observedAt: "2026-08-05T20:10:00Z",
    resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
      ...resource,
      uid: `gateway-resource-uid-${index}`,
    })),
  });
  assert.equal(evidence.resourceInventory.length, 4);
  assert.deepEqual(
    evidence.resourceInventory.map((resource) => resource.kind).sort(),
    ["Deployment", "NetworkPolicy", "Service", "ServiceAccount"].sort(),
  );
});

test("attests exactly the four applied receipt-grant resource identities", () => {
  const grantAuthorization = {
    ...authorization,
    stepId: "grant-receipts",
    artifact: "grants",
  };
  const evidence = buildSessionProofApplyEvidence({
    authorization: grantAuthorization,
    observedAt: "2026-08-05T20:42:00Z",
    resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
      ...resource,
      uid: `grant-resource-uid-${index}`,
    })),
  });
  assert.equal(evidence.resourceInventory.length, 4);
  assert.deepEqual(
    evidence.resourceInventory.map((resource) => resource.kind).sort(),
    ["ConfigMap", "Job", "NetworkPolicy", "ServiceAccount"].sort(),
  );
});

test("rejects database, incomplete, duplicate, or wrong-artifact gateway evidence", () => {
  const gatewayAuthorization = {
    ...authorization,
    stepId: "start-gateway",
    artifact: "gateway",
  };
  const expected = sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
    ...resource,
    uid: `gateway-resource-uid-${index}`,
  }));
  for (const invalid of [
    resources(),
    expected.slice(1),
    [...expected, expected[0]],
    expected.map((resource, index) => index === 0 ? { ...resource, name: "renamed" } : resource),
  ]) {
    assert.throws(() => buildSessionProofApplyEvidence({
      authorization: gatewayAuthorization,
      observedAt: "2026-08-05T20:10:00Z",
      resources: invalid,
    }));
  }
  assert.throws(() => buildSessionProofApplyEvidence({
    authorization: { ...gatewayAuthorization, artifact: "database" },
    observedAt: "2026-08-05T20:10:00Z",
    resources: expected,
  }), /not a qualified apply/);
});

test("rejects gateway, incomplete, duplicate, or wrong-artifact grant evidence", () => {
  const grantAuthorization = {
    ...authorization,
    stepId: "grant-receipts",
    artifact: "grants",
  };
  const expected = sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
    ...resource,
    uid: `grant-resource-uid-${index}`,
  }));
  for (const invalid of [
    sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
      ...resource,
      uid: `gateway-resource-uid-${index}`,
    })),
    expected.slice(1),
    [...expected, expected[0]],
    expected.map((resource, index) => index === 0 ? { ...resource, name: "renamed" } : resource),
  ]) {
    assert.throws(() => buildSessionProofApplyEvidence({
      authorization: grantAuthorization,
      observedAt: "2026-08-05T20:42:00Z",
      resources: invalid,
    }));
  }
  assert.throws(() => buildSessionProofApplyEvidence({
    authorization: { ...grantAuthorization, artifact: "gateway" },
    observedAt: "2026-08-05T20:42:00Z",
    resources: expected,
  }), /not a qualified apply/);
});

test("rejects missing, extra, duplicate, renamed, or UID-less resources", () => {
  const expected = resources();
  for (const invalid of [
    expected.slice(1),
    [...expected, { apiVersion: "v1", kind: "Secret", name: "unreviewed", uid: "secret-uid" }],
    [...expected, expected[0]],
    expected.map((resource, index) => index === 0 ? { ...resource, name: "renamed" } : resource),
    expected.map((resource, index) => index === 0 ? { ...resource, uid: "" } : resource),
  ]) {
    assert.throws(() => buildSessionProofApplyEvidence({
      authorization,
      observedAt: "2026-08-05T19:35:00Z",
      resources: invalid,
    }));
  }
});

test("rejects wrong step, manifest digest, namespace, time, or extra evidence fields", () => {
  const evidence = buildSessionProofApplyEvidence({
    authorization,
    observedAt: "2026-08-05T19:35:00Z",
    resources: resources(),
  });
  assert.throws(() => verifySessionProofApplyEvidence({
    ...authorization,
    stepId: "start-ui",
  }, evidence), /not a qualified apply/);
  for (const drifted of [
    { ...evidence, artifactSha256: "c".repeat(64) },
    { ...evidence, namespace: { ...evidence.namespace, uid: "replacement" } },
    { ...evidence, observedAt: "not-a-time" },
    { ...evidence, data: { value: "forbidden" } },
  ]) {
    assert.throws(() => verifySessionProofApplyEvidence(authorization, drifted));
  }
});
