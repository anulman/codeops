import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofGatewayReadinessEvidence,
  sessionProofGatewayMigrationRelation,
  verifySessionProofGatewayReadinessEvidence,
} from "./codeops-session-proof-gateway-readiness-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const applyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "start-gateway",
  action: "operator-apply",
  artifact: "gateway",
  artifactSha256: "b".repeat(64),
  namespace,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T20:15:00Z",
  resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Deployment" ? "gateway-deployment-uid" : `gateway-resource-uid-${index}`,
  })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: applyAuthorization.planSha256,
  namespace,
  stepIndex: 6,
  stepId: "start-gateway",
  action: "operator-apply",
  artifact: "gateway",
  artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
});
const authorization = {
  planSha256: applyAuthorization.planSha256,
  stepIndex: 7,
  stepId: "wait-gateway-migration",
  action: "operator-wait-ready",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"),
};

function deployment(overrides = {}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "codeops-control-gateway",
      namespace: namespace.name,
      uid: "gateway-deployment-uid",
      generation: 1,
    },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      conditions: [
        { type: "Progressing", status: "True" },
        { type: "Available", status: "True" },
      ],
      ...overrides,
    },
  };
}

function build(overrides = {}) {
  return buildSessionProofGatewayReadinessEvidence({
    authorization,
    gatewayApplyReceiptSource: applyReceiptSource,
    gatewayApplyEvidenceSource: applyEvidenceSource,
    deployment: deployment(),
    migrationRelation: sessionProofGatewayMigrationRelation(),
    observedAt: "2026-08-05T20:16:00Z",
    ...overrides,
  });
}

test("binds ready gateway and exact migrated receipt relation to its apply chain", () => {
  const evidence = build();
  assert.equal(evidence.deployment.uid, "gateway-deployment-uid");
  assert.equal(evidence.deployment.readyReplicas, 1);
  assert.equal(evidence.migrationRelation.columns.length, 6);
  assert.deepEqual(evidence.migrationRelation.primaryKey, ["dispatch_id"]);
  assert.equal(evidence.migrationRelation.foreignKeys[0].referencedTable, "session_runtime_outbox");
  assert.equal(evidence.migrationRelation.checkConstraints.length, 4);
});

test("rejects predecessor, apply evidence, or applied Deployment UID drift", () => {
  assert.throws(() => build({ gatewayApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ gatewayApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
  const replacement = deployment();
  replacement.metadata.uid = "replacement-deployment-uid";
  assert.throws(() => build({ deployment: replacement }), /UID drifted/);
});

test("rejects stale, changed-generation, incomplete, or failed gateway readiness", () => {
  for (const changed of [
    deployment({ observedGeneration: 0 }),
    deployment({ readyReplicas: 0 }),
    deployment({ unavailableReplicas: 1 }),
    deployment({ conditions: [
      { type: "Available", status: "False" },
      { type: "Progressing", status: "True" },
    ] }),
  ]) {
    assert.throws(() => build({ deployment: changed }), /deployment drifted/);
  }
  const changedGeneration = deployment();
  changedGeneration.metadata.generation = 2;
  changedGeneration.status.observedGeneration = 2;
  assert.throws(() => build({ deployment: changedGeneration }), /deployment drifted/);
});

test("rejects missing, renamed, structurally drifted, or extra migration evidence", () => {
  const relation = sessionProofGatewayMigrationRelation();
  for (const changed of [
    { ...relation, oid: 0 },
    { ...relation, name: "wrong_table" },
    { ...relation, columns: relation.columns.slice(1) },
    { ...relation, primaryKey: [] },
    { ...relation, foreignKeys: [] },
    { ...relation, checkConstraints: relation.checkConstraints.slice(1) },
  ]) {
    assert.throws(() => build({ migrationRelation: changed }), /relation drifted/);
  }
  const evidence = build();
  assert.throws(() => verifySessionProofGatewayReadinessEvidence(authorization, {
    ...evidence,
    migrationLogs: "forbidden",
  }), /identity drifted/);
  assert.throws(() => verifySessionProofGatewayReadinessEvidence({
    ...authorization,
    stepId: "wait-database",
  }, evidence), /not qualified/);
});
