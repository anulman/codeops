import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";
import { buildSessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import {
  buildSessionProofRuntimeStopEvidence,
  verifySessionProofRuntimeStopEvidence,
} from "./codeops-session-proof-runtime-stop-evidence.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
const planSha256 = "a".repeat(64);
const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const admission = { identity: { baseSha: "1".repeat(40), sessionSuffix: "video-1" } };
const applyAuthorization = {
  planSha256,
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: "b".repeat(64),
  namespace,
  admission,
};
const runtimeResources = sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
  .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` }));
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:20:00Z",
  resources: runtimeResources,
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: applyAuthorization.artifactSha256,
  previousReceiptSha256: "c".repeat(64),
  evidenceSha256: digest(applyEvidenceSource),
});
const waitAuthorization = {
  planSha256,
  stepIndex: 17,
  stepId: "wait-runtime",
  action: "operator-wait-ready",
  artifact: null,
  namespace,
  admission,
  previousReceiptSha256: digest(applyReceiptSource),
};
const runtimeEvidenceSource = JSON.stringify(buildSessionProofRuntimeReadinessEvidence({
  authorization: waitAuthorization,
  runtimeApplyReceiptSource: applyReceiptSource,
  runtimeApplyEvidenceSource: applyEvidenceSource,
  job: {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-session-runtime-video-1", uid: "runtime-resource-uid-0", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: 1, startTime: "2026-08-05T22:20:30Z" },
  },
  pod: {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-pod",
      uid: "runtime-pod-uid",
      labels: { "job-name": "codeops-session-runtime-video-1" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", uid: "runtime-resource-uid-0", controller: true }],
    },
    status: {
      phase: "Running",
      startTime: "2026-08-05T22:20:31Z",
      conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"]
        .map((type) => ({ type, status: "True" })),
      initContainerStatuses: [{ name: "workspace-builder", restartCount: 0, state: { terminated: { exitCode: 0 } } }],
      containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({
        name,
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: "2026-08-05T22:20:32Z" } },
      })),
    },
  },
  observedAt: "2026-08-05T22:21:00Z",
}));
const runtimeReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 17,
  stepId: "wait-runtime",
  action: "operator-wait-ready",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(applyReceiptSource),
  evidenceSha256: digest(runtimeEvidenceSource),
});
const recordAuthorization = {
  planSha256,
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  namespace,
  admission,
  previousReceiptSha256: digest(runtimeReceiptSource),
};
const recordEvidenceSource = JSON.stringify(buildSessionProofRecordEvidence({
  authorization: recordAuthorization,
  runtimeReadinessReceiptSource: runtimeReceiptSource,
  runtimeReadinessEvidenceSource: runtimeEvidenceSource,
  startedAt: "2026-08-05T22:22:00Z",
  finishedAt: "2026-08-05T22:30:00Z",
  observedAt: "2026-08-05T22:31:00Z",
  inspection: {
    legible: true,
    completeOperationCoverage: true,
    correctFinalLifecycleState: true,
    syntheticOwnedContentOnly: true,
    sensitiveMaterialAbsent: true,
  },
  artifacts: {
    "browser/video/raw.webm": Buffer.from("canonical raw video"),
    "browser/trace.zip": Buffer.from("playwright trace"),
    "session/export.json": Buffer.from('{"sessions":[]}\n'),
    "assertions.json": Buffer.from('{"result":"passed"}\n'),
  },
}));
const recordReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(runtimeReceiptSource),
  evidenceSha256: digest(recordEvidenceSource),
});
const authorization = {
  planSha256,
  stepIndex: 19,
  stepId: "stop-runtime",
  action: "operator-delete-exact-runtime-job",
  artifact: null,
  namespace,
  admission,
  previousReceiptSha256: digest(recordReceiptSource),
};
const retainedResources = runtimeResources.filter((resource) => resource.kind !== "Job");

function build(overrides = {}) {
  return buildSessionProofRuntimeStopEvidence({
    authorization,
    recordReceiptSource,
    recordEvidenceSource,
    runtimeJobAbsent: true,
    retainedResources,
    observedAt: "2026-08-05T22:32:00Z",
    ...overrides,
  });
}

test("binds runtime Job absence and retained identities to the exact recording chain", () => {
  const evidence = build();
  assert.equal(evidence.deletedJobUid, "runtime-resource-uid-0");
  assert.equal(evidence.runtimeJobAbsent, true);
  assert.equal(evidence.retainedResourceInventory.length, 2);
  assert.equal(verifySessionProofRuntimeStopEvidence(authorization, evidence), true);
});

test("rejects predecessor, nested recording, or deleted Job UID drift", () => {
  assert.throws(() => build({ recordReceiptSource: `${recordReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ recordEvidenceSource: `${recordEvidenceSource}\n` }), /receipt identity/);
  const evidence = build();
  evidence.deletedJobUid = "replacement-job-uid";
  assert.throws(() => verifySessionProofRuntimeStopEvidence(authorization, evidence), /Job UID/);
});

test("rejects retained-resource replacement, missing absence, or timestamp drift", () => {
  assert.throws(() => build({
    retainedResources: retainedResources.map((resource, index) =>
      index === 0 ? { ...resource, uid: "replacement-retained-uid" } : resource),
  }), /retained/);
  assert.throws(() => build({ runtimeJobAbsent: false }), /identity/);
  assert.throws(() => build({ observedAt: "2026-08-05T22:30:59Z" }), /observation time/);
});

test("rejects generic, wrong-step, oversized, or extra-field evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofRuntimeStopEvidence(
    { ...authorization, stepId: "revoke-capabilities" },
    evidence,
  ));
  assert.throws(() => verifySessionProofRuntimeStopEvidence(authorization, { ...evidence, logs: "forbidden" }));
  assert.throws(() => verifySessionProofRuntimeStopEvidence(authorization, {
    ...evidence,
    recordEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity/);
});
