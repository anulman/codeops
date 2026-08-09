import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import {
  buildSessionProofCodexSmokeCompletionEvidence,
  verifySessionProofCodexSmokeCompletionEvidence,
} from "./codeops-session-proof-codex-smoke-completion-evidence.mjs";
import { buildSessionProofCodexSmokeReplacementEvidence } from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const planSha256 = "a".repeat(64);
const loginApplyAuthorization = {
  planSha256,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: "b".repeat(64),
  namespace,
};
const loginResources = sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
  ...resource,
  uid: resource.kind === "Job"
    ? "login-job-uid"
    : resource.kind === "PersistentVolumeClaim"
      ? "claim-uid"
      : `retained-uid-${index}`,
}));
const loginApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: loginApplyAuthorization,
  observedAt: "2026-08-05T21:15:00Z",
  resources: loginResources,
}));
const loginApplyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 10,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: loginApplyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(loginApplyEvidenceSource).digest("hex"),
});
const loginWaitAuthorization = {
  planSha256,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(loginApplyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T21:15:30Z",
};
const loginCompletionEvidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
  authorization: loginWaitAuthorization,
  loginApplyReceiptSource,
  loginApplyEvidenceSource,
  job: {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-codex-auth-login", namespace: namespace.name, uid: "login-job-uid", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600 },
    status: {
      active: 0,
      succeeded: 1,
      failed: 0,
      startTime: "2026-08-05T21:16:00Z",
      completionTime: "2026-08-05T21:17:00Z",
      conditions: [{ type: "Complete", status: "True" }],
    },
  },
  persistentVolumeClaim: {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "codeops-codex-auth", namespace: namespace.name, uid: "claim-uid" },
    status: { phase: "Bound" },
  },
  observedAt: "2026-08-05T21:18:00Z",
}));
const loginCompletionReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  artifactSha256: null,
  evidenceSha256: createHash("sha256").update(loginCompletionEvidenceSource).digest("hex"),
});
const replacementAuthorization = {
  planSha256,
  stepIndex: 12,
  stepId: "codex-smoke",
  action: "operator-replace-auth-job",
  artifact: "codex-smoke",
  artifactSha256: "c".repeat(64),
  namespace,
  previousReceiptSha256: createHash("sha256").update(loginCompletionReceiptSource).digest("hex"),
};
const smokeResources = sessionProofApplyResourceIdentities("codex-smoke").map((resource, index) => ({
  ...resource,
  uid: resource.kind === "Job"
    ? "smoke-job-uid"
    : resource.kind === "PersistentVolumeClaim"
      ? "claim-uid"
      : `retained-uid-${index}`,
}));
const replacementEvidenceSource = JSON.stringify(buildSessionProofCodexSmokeReplacementEvidence({
  authorization: replacementAuthorization,
  loginCompletionReceiptSource,
  loginCompletionEvidenceSource,
  resources: smokeResources,
  loginJobAbsent: true,
  observedAt: "2026-08-05T21:19:00Z",
}));
const replacementReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 12,
  stepId: "codex-smoke",
  action: "operator-replace-auth-job",
  artifact: "codex-smoke",
  artifactSha256: replacementAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(replacementEvidenceSource).digest("hex"),
});
const authorization = {
  planSha256,
  stepIndex: 13,
  stepId: "wait-codex-smoke",
  action: "operator-wait-complete",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(replacementReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T21:19:30Z",
};

function job(overrides = {}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-codex-auth-smoke", namespace: namespace.name, uid: "smoke-job-uid", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600 },
    status: {
      active: 0,
      succeeded: 1,
      failed: 0,
      startTime: "2026-08-05T21:20:00Z",
      completionTime: "2026-08-05T21:21:00Z",
      conditions: [{ type: "Complete", status: "True" }],
      ...overrides,
    },
  };
}

function claim(overrides = {}) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "codeops-codex-auth", namespace: namespace.name, uid: "claim-uid", ...overrides.metadata },
    status: { phase: "Bound", ...overrides.status },
  };
}

function build(overrides = {}) {
  return buildSessionProofCodexSmokeCompletionEvidence({
    authorization,
    smokeReplacementReceiptSource: replacementReceiptSource,
    smokeReplacementEvidenceSource: replacementEvidenceSource,
    loginJobAbsent: true,
    job: job(),
    persistentVolumeClaim: claim(),
    observedAt: "2026-08-05T21:22:00Z",
    ...overrides,
  });
}

test("binds smoke success to the exact replacement Job, claim, and login absence", () => {
  const evidence = build();
  assert.equal(evidence.job.uid, "smoke-job-uid");
  assert.equal(evidence.persistentVolumeClaim.uid, "claim-uid");
  assert.equal(evidence.loginJobAbsent, true);
});

test("allows smoke completion authorization after the exact smoke Job completed", () => {
  const evidence = buildSessionProofCodexSmokeCompletionEvidence({
    authorization: { ...authorization, authorizedAt: "2026-08-05T21:21:30Z" },
    smokeReplacementReceiptSource: replacementReceiptSource,
    smokeReplacementEvidenceSource: replacementEvidenceSource,
    loginJobAbsent: true,
    job: job(),
    persistentVolumeClaim: claim(),
    observedAt: "2026-08-05T21:22:00Z",
  });
  assert.equal(evidence.job.completionTime, "2026-08-05T21:21:00Z");
});

test("rejects predecessor, replacement evidence, Job UID, claim UID, or login presence drift", () => {
  assert.throws(() => build({ smokeReplacementReceiptSource: `${replacementReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ smokeReplacementEvidenceSource: `${replacementEvidenceSource}\n` }), /receipt identity/);
  const replacementJob = job();
  replacementJob.metadata.uid = "replacement-job-uid";
  assert.throws(() => build({ job: replacementJob }), /live identity drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ metadata: { uid: "replacement-claim-uid" } }) }), /live identity drifted/);
  assert.throws(() => build({ loginJobAbsent: false }), /identity drifted/);
});

test("rejects pending, failed, retried, malformed, deleting, or timestamp-drifted smoke completion", () => {
  for (const status of [
    { active: 1, succeeded: 0, completionTime: undefined, conditions: [] },
    { succeeded: 0, failed: 1, conditions: [{ type: "Failed", status: "True" }] },
    { succeeded: 2 },
    { completionTime: "2026-08-05T21:19:59Z" },
  ]) {
    assert.throws(() => build({ job: job(status) }), /Job drifted/);
  }
  const changedSpec = job();
  changedSpec.spec.backoffLimit = 1;
  assert.throws(() => build({ job: changedSpec }), /Job drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ status: { phase: "Pending" } }) }), /claim drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ metadata: { deletionTimestamp: "2026-08-05T21:21:30Z" } }) }), /claim drifted/);
  assert.throws(() => build({ job: job({ startTime: "2026-08-05T21:18:59Z" }) }), /timestamp drifted/);
  assert.throws(() => build({ observedAt: "2026-08-05T21:20:59Z" }), /timestamp drifted/);
});

test("rejects generic, oversized, wrong-step, or extra-field completion evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofCodexSmokeCompletionEvidence({ ...authorization, stepId: "wait-codex-login" }, evidence), /not qualified/);
  const { persistentVolumeClaim: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofCodexSmokeCompletionEvidence(authorization, generic), /identity drifted/);
  assert.throws(() => verifySessionProofCodexSmokeCompletionEvidence(authorization, {
    ...evidence,
    smokeReplacementEvidenceSource: "x".repeat(192 * 1024 + 1),
  }), /identity drifted/);
  assert.throws(() => verifySessionProofCodexSmokeCompletionEvidence(authorization, { ...evidence, podLogs: "forbidden" }), /identity drifted/);
});
