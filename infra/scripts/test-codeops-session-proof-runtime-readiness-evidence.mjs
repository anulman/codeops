import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofRuntimeReadinessEvidence,
  verifySessionProofRuntimeReadinessEvidence,
} from "./codeops-session-proof-runtime-readiness-evidence.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const admission = { identity: { sessionSuffix: "video-1" } };
const applyAuthorization = {
  planSha256: "a".repeat(64), stepIndex: 16, stepId: "start-runtime",
  action: "operator-apply", artifact: "runtime", artifactSha256: "b".repeat(64),
  namespace, admission,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:20:00Z",
  resources: sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
    .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed", proceed: true, planSha256: applyAuthorization.planSha256,
  namespace, stepIndex: 16, stepId: "start-runtime", action: "operator-apply",
  artifact: "runtime", artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: digest(applyEvidenceSource),
});
const authorization = {
  planSha256: applyAuthorization.planSha256, stepIndex: 17, stepId: "wait-runtime",
  action: "operator-wait-ready", artifact: null, namespace, admission,
  previousReceiptSha256: digest(applyReceiptSource),
};
const observedAt = "2026-08-05T22:21:00Z";

function job(overrides = {}) {
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: "codeops-session-runtime-video-1", uid: "runtime-resource-uid-0", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: 1, startTime: "2026-08-05T22:20:30Z" },
    ...overrides,
  };
}

function pod(overrides = {}) {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-abcde", uid: "runtime-pod-uid",
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
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildSessionProofRuntimeReadinessEvidence({
    authorization, runtimeApplyReceiptSource: applyReceiptSource,
    runtimeApplyEvidenceSource: applyEvidenceSource, job: job(), pod: pod(),
    observedAt, ...overrides,
  });
}

test("binds initialized runtime readiness to the exact applied Job and single Pod", () => {
  const evidence = build();
  assert.equal(evidence.job.uid, "runtime-resource-uid-0");
  assert.equal(evidence.job.active, 1);
  assert.equal(evidence.job.ready, 1);
  assert.equal(evidence.pod.ownerJobUid, evidence.job.uid);
  assert.deepEqual(evidence.pod.containers.map((value) => value.name), ["coding-agent", "runtime-worker"]);
});

test("rejects predecessor, apply evidence, Job UID, or Pod owner drift", () => {
  assert.throws(() => build({ runtimeApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ runtimeApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
  assert.throws(() => build({ job: job({ metadata: { ...job().metadata, uid: "replacement" } }) }), /Job UID/);
  const driftedPod = pod();
  driftedPod.metadata.ownerReferences[0].uid = "replacement";
  assert.throws(() => build({ pod: driftedPod }), /Pod drifted/);
});

test("rejects pending, failed, retried, terminating, or uninitialized runtime state", () => {
  const pendingPod = pod();
  pendingPod.status.conditions = pendingPod.status.conditions.map((condition) =>
    condition.type === "Ready" ? { ...condition, status: "False" } : condition);
  const restartedPod = pod();
  restartedPod.status.containerStatuses[0].restartCount = 1;
  const terminatingPod = pod();
  terminatingPod.metadata.deletionTimestamp = observedAt;
  for (const inputs of [
    { job: job({ status: { active: 1, ready: 0, startTime: "2026-08-05T22:20:30Z" } }) },
    { job: job({ status: { failed: 1, startTime: "2026-08-05T22:20:30Z" } }) },
    { pod: pendingPod },
    { pod: restartedPod },
    { pod: terminatingPod },
  ]) assert.throws(() => build(inputs));
});

test("rejects generic, wrong-step, timestamp-drifted, or extra-field evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofRuntimeReadinessEvidence(
    { ...authorization, stepId: "record-proof" }, evidence,
  ));
  for (const drifted of [
    { ...evidence, observedAt: "2026-08-05T22:20:00Z" },
    { ...evidence, logs: "forbidden" },
    { apiVersion: evidence.apiVersion, result: "verified", stepId: "wait-runtime" },
  ]) assert.throws(() => verifySessionProofRuntimeReadinessEvidence(authorization, drifted));
});
