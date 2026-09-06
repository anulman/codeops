import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatedCheckpointOperator,
  authorizeCheckpointCleanup,
  evaluateCheckpointCleanup,
} from "../dist/checkpoint-recovery.js";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { serveCheckpointRecoveryControl } from
  "../dist/checkpoint-recovery-http.js";

const operator = (principalId) => authenticatedCheckpointOperator({ token: "t".repeat(32),
  headers: { authorization: `Bearer ${"t".repeat(32)}`, "x-codeops-principal": principalId } });
const digest = (value) => `sha256:${value.repeat(64)}`;
const checkpointId = "22222222-2222-4222-8222-222222222222";
const binding = {
  version: "codeops.checkpoint-workspace-binding/v1",
  sessionId: "ses_verified", generation: 3,
  workspaceJobUid: "11111111-1111-4111-8111-111111111111",
  resourceConfigurationDigest: digest("e"),
  workspaceConfigurationDigest: digest("a"),
  workspaceManifestDigest: digest("b"),
};
const manifest = {
  version: "codeops.checkpoint-manifest/v1", checkpointId, binding,
  sourcePatches: [],
  scratchArtifact: {
    artifactId: `artifact:${checkpointId}:scratch`, bytes: 2, digest: digest("d"),
  },
  pathSetDigest: sha256CanonicalJsonDigest([]), pathCount: 0,
  totalBytes: 2, capturedAt: "2026-09-04T10:00:00.000Z",
};
const descriptor = {
  version: "codeops.checkpoint-descriptor/v1", manifest,
  manifestDigest: sha256CanonicalJsonDigest(manifest),
};
const descriptorDigest = sha256CanonicalJsonDigest(descriptor);
const checkpointReceipt = {
  version: "codeops.checkpoint-receipt/v1", checkpointId, binding,
  descriptorDigest, manifestDigest: descriptor.manifestDigest,
  issuedAt: "2026-09-04T10:01:00.000Z",
};
const restoreReceipt = {
  version: "codeops.restore-receipt/v1", checkpointId, binding,
  descriptorDigest, manifestDigest: descriptor.manifestDigest,
  restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  restoredWorkspaceJobUid: "66666666-6666-4666-8666-666666666666",
  restoredResourceConfigurationDigest: digest("f"), restoredGeneration: 4,
  restoredPathSetDigest: sha256CanonicalJsonDigest([]),
  restoredAt: "2026-09-04T10:02:00.000Z",
};
const retentionDecision = {
  version: "codeops.checkpoint-retention-decision/v1",
  decisionId: "77777777-7777-4777-8777-777777777777", checkpointId,
  policyRevision: 1, configured: true,
  retainUntil: "2026-09-04T11:00:00.000Z",
  expiresAt: "2026-09-04T13:00:00.000Z",
  decidedAt: "2026-09-04T10:03:00.000Z",
  operatorPrincipalId: "operator:alice",
};
const live = {
  sessionId: binding.sessionId, generation: 4, state: "completed", checkpointId,
  workspaceJobUid: restoreReceipt.restoredWorkspaceJobUid,
  resourceConfigurationDigest: restoreReceipt.restoredResourceConfigurationDigest,
  workspaceConfigurationDigest: binding.workspaceConfigurationDigest,
  workspaceManifestDigest: binding.workspaceManifestDigest,
};
const evidence = (overrides = {}) => ({
  descriptor, checkpointReceipt, restoreReceipt, retentionDecision,
  holdEvents: [], live, ...overrides,
});
const evaluate = (overrides = {}, now = "2026-09-04T12:00:00.000Z") =>
  evaluateCheckpointCleanup({ evidence: evidence(overrides), now,
    decisionId: "88888888-8888-4888-8888-888888888888" });

test("cleanup authority is disabled until an operator configures retention", () => {
  assert.deepEqual(evaluate({ retentionDecision: null }), {
    version: "codeops.checkpoint-cleanup-decision/v1",
    decisionId: "88888888-8888-4888-8888-888888888888", checkpointId,
    authorized: false, reason: "policy-not-configured",
    decidedAt: "2026-09-04T12:00:00.000Z",
  });
});

test("requires both exact receipts and exact live generation and workspace readback", () => {
  assert.equal(evaluate({ checkpointReceipt: null }).reason, "checkpoint-receipt-missing");
  assert.equal(evaluate({ restoreReceipt: null }).reason, "restore-receipt-missing");
  assert.equal(evaluate({ restoreReceipt: { ...restoreReceipt,
    descriptorDigest: digest("f") } }).reason, "receipt-mismatch");
  assert.equal(evaluate({ live: { ...live, generation: 5 } }).reason, "later-generation");
  assert.equal(evaluate({ live: { ...live,
    workspaceJobUid: "99999999-9999-4999-8999-999999999999" } }).reason,
  "later-generation");
  for (const drift of [
    { checkpointId: "99999999-9999-4999-8999-999999999999" },
    { workspaceConfigurationDigest: digest("f") },
    { workspaceManifestDigest: digest("f") },
  ]) assert.equal(evaluate({ live: { ...live, ...drift } }).reason, "stale-readback");
});

test("fails closed for an active hold and expired or not-yet-eligible retention", () => {
  const holdEvents = [{
    version: "codeops.checkpoint-hold-event/v1",
    eventId: "99999999-9999-4999-8999-999999999999", checkpointId,
    revision: 1, action: "placed", operatorPrincipalId: "operator:alice",
    reason: "Investigate", occurredAt: "2026-09-04T10:30:00.000Z",
  }];
  assert.equal(evaluate({ holdEvents }).reason, "active-hold");
  assert.equal(evaluate({ holdEvents, retentionDecision: null }).reason,
    "policy-not-configured");
  assert.equal(evaluate({}, "2026-09-04T10:30:00.000Z").reason,
    "retention-not-expired");
  assert.equal(evaluate({}, "2026-09-04T13:00:00.000Z").reason,
    "retention-expired");
});

test("cancellation, archive, failure, retry, and hibernation retain the checkpoint gate", () => {
  for (const state of ["cancelled", "archived", "failed"]) {
    assert.equal(evaluate({ restoreReceipt: null, live: { ...live, state } }).reason,
      "restore-receipt-missing");
  }
  assert.equal(evaluate({ live: { ...live, state: "hibernated" } }).reason,
    "session-not-terminal");
  assert.equal(evaluate({ live: { ...live, state: "failed", generation: 5 } }).reason,
    "later-generation");
});

test("binds an authorization to hold, retention, restore, and live revisions", () => {
  const decision = evaluate();
  assert.equal(decision.authorized, true);
  assert.equal(decision.holdRevision, 0);
  assert.equal(decision.retentionRevision, retentionDecision.policyRevision);
  assert.equal(decision.liveGeneration, restoreReceipt.restoredGeneration);
  assert.equal(decision.consumedAt, decision.decidedAt);
});

test("does not grant hold authority to a runtime Session", () => {
  for (const principal of ["session-runtime:ses_verified", "runtime-worker:test",
    "runtime", "session-job:ses_verified", "SESSION-RUNTIME:test"]) {
    assert.throws(() => operator(principal), /authenticated operator/);
  }
  assert.equal(operator("operator:alice").principalId,
  "operator:alice");
});

test("copied operator objects and unauthenticated principals cannot reach PostgreSQL", async () => {
  const client = { query: async () => assert.fail("forged authority reached PostgreSQL") };
  await assert.rejects(authorizeCheckpointCleanup(client, {
    operator: { ...operator("operator:alice") }, checkpointId,
  }), /authenticated operator/);
  assert.throws(() => authenticatedCheckpointOperator({ token: "t".repeat(32),
    headers: { authorization: `Bearer ${"x".repeat(32)}`, "x-codeops-principal": "operator:alice" },
  }), /authenticated operator/);
});

test("constructs operator authority only after the existing bearer and principal boundary", async () => {
  const base = { method: "POST", url: `/v1/checkpoints/${checkpointId}/holds`,
    token: "t".repeat(32), readBody: async () => ({ action: "placed", reason: "test" }),
    hold: async ({ operator }) => ({ principalId: operator.principalId }),
    retention: async () => assert.fail(), cleanup: async () => assert.fail() };
  assert.equal((await serveCheckpointRecoveryControl({ ...base, headers: {
    authorization: `Bearer ${"t".repeat(32)}`,
    "content-type": "application/json", "x-codeops-principal": "operator:alice",
  } })).body.result.principalId, "operator:alice");
  await assert.rejects(serveCheckpointRecoveryControl({ ...base, headers: {
    authorization: `Bearer ${"t".repeat(32)}`,
    "content-type": "application/json",
    "x-codeops-principal": "session-runtime:ses_verified",
  } }), /non-runtime principal/);
});
