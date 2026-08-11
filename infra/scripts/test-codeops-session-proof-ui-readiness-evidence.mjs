import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofUiReadinessEvidence,
  verifySessionProofUiReadinessEvidence,
} from "./codeops-session-proof-ui-readiness-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const applyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "start-ui",
  action: "operator-apply",
  artifact: "ui",
  artifactSha256: "b".repeat(64),
  namespace,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:15:00Z",
  resources: sessionProofApplyResourceIdentities("start-ui").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Deployment" ? "ui-deployment-uid" : `resource-uid-${index}`,
  })),
}));
const applyReceipt = {
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: applyAuthorization.planSha256,
  namespace,
  stepIndex: 14,
  stepId: "start-ui",
  action: "operator-apply",
  artifact: "ui",
  artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
};
const applyReceiptSource = JSON.stringify(applyReceipt);
const authorization = {
  planSha256: applyAuthorization.planSha256,
  stepIndex: 15,
  stepId: "wait-ui",
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
      name: "codeops-agents-ui",
      namespace: namespace.name,
      uid: "ui-deployment-uid",
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
  return buildSessionProofUiReadinessEvidence({
    authorization,
    uiApplyReceiptSource: applyReceiptSource,
    uiApplyEvidenceSource: applyEvidenceSource,
    deployment: deployment(),
    observedAt: "2026-08-05T22:16:00Z",
    ...overrides,
  });
}

test("binds UI readiness to the exact apply evidence and fully ready Deployment UID", () => {
  const evidence = build();
  assert.equal(
    createHash("sha256").update(evidence.uiApplyReceiptSource).digest("hex"),
    authorization.previousReceiptSha256,
  );
  assert.equal(
    createHash("sha256").update(evidence.uiApplyEvidenceSource).digest("hex"),
    applyReceipt.evidenceSha256,
  );
  assert.equal(evidence.deployment.uid, "ui-deployment-uid");
  assert.equal(evidence.deployment.readyReplicas, 1);
  assert.equal(evidence.deployment.unavailableReplicas, 0);
});

test("rejects predecessor, apply evidence, or applied Deployment UID drift", () => {
  assert.throws(() => build({ uiApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ uiApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
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
  assert.throws(() => verifySessionProofUiReadinessEvidence(authorization, {
    ...evidence,
    podLogs: "forbidden",
  }), /identity drifted/);
  assert.throws(() => verifySessionProofUiReadinessEvidence(authorization, {
    ...evidence,
    uiApplyEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity drifted/);
});

test("rejects generic or wrong-step UI readiness evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofUiReadinessEvidence({
    ...authorization,
    stepId: "wait-database",
  }, evidence), /not qualified/);
  const { deployment: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofUiReadinessEvidence(authorization, generic), /identity drifted/);
});
