import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofReadinessEvidence,
  verifySessionProofReadinessEvidence,
} from "./codeops-session-proof-readiness-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const applyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "start-database",
  action: "operator-apply",
  artifact: "database",
  artifactSha256: "b".repeat(64),
  namespace,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T19:40:00Z",
  resources: sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Deployment" ? "database-deployment-uid" : `resource-uid-${index}`,
  })),
}));
const applyReceipt = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: applyAuthorization.planSha256,
  namespace,
  stepIndex: 4,
  stepId: "start-database",
  action: "operator-apply",
  artifact: "database",
  artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
};
const applyReceiptSource = JSON.stringify(applyReceipt);
const authorization = {
  planSha256: applyAuthorization.planSha256,
  stepIndex: 5,
  stepId: "wait-database",
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
      name: "codeops-session-proof-database",
      namespace: namespace.name,
      uid: "database-deployment-uid",
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
        { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" },
        { type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
      ],
      ...overrides,
    },
  };
}

function build(overrides = {}) {
  return buildSessionProofReadinessEvidence({
    authorization,
    databaseApplyReceiptSource: applyReceiptSource,
    databaseApplyEvidenceSource: applyEvidenceSource,
    deployment: deployment(),
    observedAt: "2026-08-05T19:41:00Z",
    ...overrides,
  });
}

test("binds database readiness to the exact apply evidence and fully ready Deployment UID", () => {
  const evidence = build();
  assert.equal(
    createHash("sha256").update(evidence.databaseApplyReceiptSource).digest("hex"),
    authorization.previousReceiptSha256,
  );
  assert.equal(
    createHash("sha256").update(evidence.databaseApplyEvidenceSource).digest("hex"),
    applyReceipt.evidenceSha256,
  );
  assert.equal(evidence.deployment.uid, "database-deployment-uid");
  assert.equal(evidence.deployment.readyReplicas, 1);
  assert.equal(evidence.deployment.unavailableReplicas, 0);
});

test("rejects predecessor, apply evidence, or applied Deployment UID drift", () => {
  assert.throws(() => build({ databaseApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ databaseApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
  const replacement = deployment();
  replacement.metadata.uid = "replacement-deployment-uid";
  assert.throws(() => build({ deployment: replacement }), /UID drifted/);
});

test("rejects stale generations, incomplete replicas, failed conditions, and extra fields", () => {
  for (const status of [
    { observedGeneration: 0 },
    { readyReplicas: 0 },
    { unavailableReplicas: 1 },
    { conditions: [{ type: "Available", status: "False" }, { type: "Progressing", status: "True" }] },
  ]) {
    assert.throws(() => build({ deployment: deployment(status) }), /deployment drifted/);
  }
  const changedSpec = deployment();
  changedSpec.metadata.generation = 2;
  changedSpec.status.observedGeneration = 2;
  assert.throws(() => build({ deployment: changedSpec }), /deployment drifted/);
  const evidence = build();
  assert.throws(() => verifySessionProofReadinessEvidence(authorization, {
    ...evidence,
    podLogs: "forbidden",
  }), /identity drifted/);
  assert.throws(() => verifySessionProofReadinessEvidence(authorization, {
    ...evidence,
    databaseApplyEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity drifted/);
});

test("rejects generic or wrong-step readiness evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofReadinessEvidence({
    ...authorization,
    stepId: "wait-gateway",
  }, evidence), /not qualified/);
  const { deployment: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofReadinessEvidence(authorization, generic), /identity drifted/);
});
