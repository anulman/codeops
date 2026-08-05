import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import {
  buildSessionProofRecordEvidence,
  verifySessionProofRecordEvidence,
} from "./codeops-session-proof-record-evidence.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const admission = {
  identity: { baseSha: "1".repeat(40), sessionSuffix: "video-1" },
};
const planSha256 = "a".repeat(64);
const applyAuthorization = {
  planSha256, stepIndex: 16, stepId: "start-runtime", action: "operator-apply",
  artifact: "runtime", artifactSha256: "b".repeat(64), namespace, admission,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:20:00Z",
  resources: sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
    .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed", proceed: true, planSha256, namespace, stepIndex: 16,
  stepId: "start-runtime", action: "operator-apply", artifact: "runtime",
  artifactSha256: applyAuthorization.artifactSha256,
  previousReceiptSha256: "c".repeat(64),
  evidenceSha256: digest(applyEvidenceSource),
});
const waitAuthorization = {
  planSha256, stepIndex: 17, stepId: "wait-runtime", action: "operator-wait-ready",
  artifact: null, namespace, admission, previousReceiptSha256: digest(applyReceiptSource),
};
const runtimeEvidenceSource = JSON.stringify(buildSessionProofRuntimeReadinessEvidence({
  authorization: waitAuthorization,
  runtimeApplyReceiptSource: applyReceiptSource,
  runtimeApplyEvidenceSource: applyEvidenceSource,
  job: {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: "codeops-session-runtime-video-1", uid: "runtime-resource-uid-0", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: 1, startTime: "2026-08-05T22:20:30Z" },
  },
  pod: {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-pod", uid: "runtime-pod-uid",
      labels: { "job-name": "codeops-session-runtime-video-1" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", uid: "runtime-resource-uid-0", controller: true }],
    },
    status: {
      phase: "Running", startTime: "2026-08-05T22:20:31Z",
      conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"]
        .map((type) => ({ type, status: "True" })),
      initContainerStatuses: [{ name: "workspace-builder", restartCount: 0, state: { terminated: { exitCode: 0 } } }],
      containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({
        name, ready: true, restartCount: 0,
        state: { running: { startedAt: "2026-08-05T22:20:32Z" } },
      })),
    },
  },
  observedAt: "2026-08-05T22:21:00Z",
}));
const runtimeReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed", proceed: true, planSha256, namespace, stepIndex: 17,
  stepId: "wait-runtime", action: "operator-wait-ready", artifact: null,
  artifactSha256: null, previousReceiptSha256: digest(applyReceiptSource),
  evidenceSha256: digest(runtimeEvidenceSource),
});
const authorization = {
  planSha256, stepIndex: 18, stepId: "record-proof",
  action: "operator-record-and-export-evidence", artifact: null, namespace,
  admission, previousReceiptSha256: digest(runtimeReceiptSource),
};
const inspection = {
  legible: true,
  completeOperationCoverage: true,
  correctFinalLifecycleState: true,
  syntheticOwnedContentOnly: true,
  sensitiveMaterialAbsent: true,
};
const artifacts = {
  "browser/video/raw.webm": Buffer.from("canonical raw video"),
  "browser/trace.zip": Buffer.from("playwright trace"),
  "session/export.json": Buffer.from('{"sessions":[]}\n'),
  "assertions.json": Buffer.from('{"result":"passed"}\n'),
};

function build(overrides = {}) {
  return buildSessionProofRecordEvidence({
    authorization,
    runtimeReadinessReceiptSource: runtimeReceiptSource,
    runtimeReadinessEvidenceSource: runtimeEvidenceSource,
    startedAt: "2026-08-05T22:22:00Z",
    finishedAt: "2026-08-05T22:30:00Z",
    observedAt: "2026-08-05T22:31:00Z",
    inspection,
    artifacts,
    ...overrides,
  });
}

test("binds the reviewed capture inventory and complete operation coverage to runtime readiness", () => {
  const evidence = build();
  assert.equal(evidence.capture.sourceSha, "1".repeat(40));
  assert.equal(evidence.capture.operations.length, 12);
  assert.equal(evidence.capture.artifacts.length, 4);
  assert.equal(evidence.capture.artifacts[0].sha256, digest(artifacts["browser/video/raw.webm"]));
});

test("rejects predecessor, runtime evidence, or source SHA drift", () => {
  assert.throws(() => build({ runtimeReadinessReceiptSource: `${runtimeReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ runtimeReadinessEvidenceSource: `${runtimeEvidenceSource}\n` }), /receipt identity/);
  const evidence = build();
  evidence.capture.sourceSha = "2".repeat(40);
  assert.throws(() => verifySessionProofRecordEvidence(authorization, evidence), /capture contract/);
});

test("rejects incomplete artifacts, unsafe inspection, or non-monotonic capture time", () => {
  const missing = { ...artifacts };
  delete missing["browser/trace.zip"];
  assert.throws(() => build({ artifacts: missing }), /artifact set/);
  assert.throws(() => build({ inspection: { ...inspection, sensitiveMaterialAbsent: false } }), /capture contract/);
  assert.throws(() => build({ startedAt: "2026-08-05T22:20:00Z" }), /capture contract/);
});

test("rejects generic, extra-field, wrong-step, or pre-finish evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofRecordEvidence(
    { ...authorization, stepId: "stop-runtime" }, evidence,
  ));
  assert.throws(() => verifySessionProofRecordEvidence(authorization, { ...evidence, logs: "forbidden" }));
  assert.throws(() => verifySessionProofRecordEvidence(authorization, {
    apiVersion: evidence.apiVersion, result: "verified", stepId: "record-proof",
  }));
  assert.throws(() => verifySessionProofRecordEvidence(authorization, {
    ...evidence, observedAt: "2026-08-05T22:29:59Z",
  }), /observation time/);
});
