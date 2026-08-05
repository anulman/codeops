import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import {
  buildSessionProofCodexSmokeReplacementEvidence,
  verifySessionProofCodexSmokeReplacementEvidence,
} from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const loginApplyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: "b".repeat(64),
  namespace,
};
const loginApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: loginApplyAuthorization,
  observedAt: "2026-08-05T21:15:00Z",
  resources: sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job" ? "login-job-uid" : `retained-resource-uid-${index}`,
  })),
}));
const loginApplyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: loginApplyAuthorization.planSha256,
  namespace,
  stepIndex: 10,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: loginApplyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(loginApplyEvidenceSource).digest("hex"),
});
const loginWaitAuthorization = {
  planSha256: loginApplyAuthorization.planSha256,
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
    metadata: { name: "codeops-codex-auth", namespace: namespace.name, uid: "retained-resource-uid-2" },
    status: { phase: "Bound" },
  },
  observedAt: "2026-08-05T21:18:00Z",
}));
const loginCompletionReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: loginApplyAuthorization.planSha256,
  namespace,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  artifactSha256: null,
  evidenceSha256: createHash("sha256").update(loginCompletionEvidenceSource).digest("hex"),
});
const authorization = {
  planSha256: loginApplyAuthorization.planSha256,
  stepIndex: 12,
  stepId: "codex-smoke",
  action: "operator-replace-auth-job",
  artifact: "codex-smoke",
  artifactSha256: "c".repeat(64),
  namespace,
  previousReceiptSha256: createHash("sha256").update(loginCompletionReceiptSource).digest("hex"),
};

function resources(overrides = {}) {
  return sessionProofApplyResourceIdentities("codex-smoke").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job" ? "smoke-job-uid" : `retained-resource-uid-${index}`,
    ...overrides[resource.kind],
  }));
}

function build(overrides = {}) {
  return buildSessionProofCodexSmokeReplacementEvidence({
    authorization,
    loginCompletionReceiptSource,
    loginCompletionEvidenceSource,
    resources: resources(),
    loginJobAbsent: true,
    observedAt: "2026-08-05T21:19:00Z",
    ...overrides,
  });
}

test("binds smoke replacement to exact login completion and retained identities", () => {
  const evidence = build();
  assert.equal(evidence.replacedLoginJobUid, "login-job-uid");
  assert.equal(evidence.loginJobAbsent, true);
  const smoke = JSON.parse(evidence.smokeApplyEvidenceSource);
  assert.equal(smoke.resourceInventory.find((resource) => resource.kind === "Job").uid, "smoke-job-uid");
});

test("rejects predecessor or nested login completion drift", () => {
  assert.throws(() => build({ loginCompletionReceiptSource: `${loginCompletionReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ loginCompletionEvidenceSource: `${loginCompletionEvidenceSource}\n` }), /receipt identity/);
});

test("rejects retained identity replacement, Job reuse, or unproven login absence", () => {
  assert.throws(() => build({ resources: resources({ NetworkPolicy: { uid: "replacement-policy-uid" } }) }), /retained/);
  assert.throws(() => build({ resources: resources({ Job: { uid: "login-job-uid" } }) }), /replacement Job/);
  assert.throws(() => build({ loginJobAbsent: false }), /identity drifted/);
});

test("rejects generic, oversized, timestamp-drifted, or extra-field evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofCodexSmokeReplacementEvidence(authorization, {
    ...evidence,
    loginCompletionEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity drifted/);
  assert.throws(() => build({ observedAt: "2026-08-05T21:17:59Z" }), /timestamp drifted/);
  assert.throws(() => verifySessionProofCodexSmokeReplacementEvidence(authorization, {
    ...evidence,
    credentialContents: "forbidden",
  }), /identity drifted/);
  const { smokeApplyEvidenceSource: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofCodexSmokeReplacementEvidence(authorization, generic), /identity drifted/);
});
