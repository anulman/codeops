import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofCodexLoginCompletionEvidence,
  verifySessionProofCodexLoginCompletionEvidence,
} from "./codeops-session-proof-codex-login-completion-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const applyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: "b".repeat(64),
  namespace,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T21:15:00Z",
  resources: sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job"
      ? "login-job-uid"
      : resource.kind === "PersistentVolumeClaim"
        ? "login-claim-uid"
        : `resource-uid-${index}`,
  })),
}));
const applyReceipt = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: applyAuthorization.planSha256,
  namespace,
  stepIndex: 10,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
};
const applyReceiptSource = JSON.stringify(applyReceipt);
const authorization = {
  planSha256: applyAuthorization.planSha256,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T21:15:30Z",
};

function job(overrides = {}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: "codeops-codex-auth-login",
      namespace: namespace.name,
      uid: "login-job-uid",
      generation: 1,
    },
    spec: {
      completions: 1,
      parallelism: 1,
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 3600,
    },
    status: {
      active: 0,
      succeeded: 1,
      failed: 0,
      startTime: "2026-08-05T21:16:00Z",
      completionTime: "2026-08-05T21:17:00Z",
      conditions: [{ type: "Complete", status: "True", reason: "CompletionsReached" }],
      ...overrides,
    },
  };
}

function claim(overrides = {}) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: "codeops-codex-auth",
      namespace: namespace.name,
      uid: "login-claim-uid",
      ...overrides.metadata,
    },
    status: { phase: "Bound", ...overrides.status },
  };
}

function build(overrides = {}) {
  return buildSessionProofCodexLoginCompletionEvidence({
    authorization,
    loginApplyReceiptSource: applyReceiptSource,
    loginApplyEvidenceSource: applyEvidenceSource,
    job: job(),
    persistentVolumeClaim: claim(),
    observedAt: "2026-08-05T21:18:00Z",
    ...overrides,
  });
}

test("binds Codex login completion to the exact apply evidence, Job, and credential claim", () => {
  const evidence = build();
  assert.equal(
    createHash("sha256").update(evidence.loginApplyReceiptSource).digest("hex"),
    authorization.previousReceiptSha256,
  );
  assert.equal(evidence.job.uid, "login-job-uid");
  assert.equal(evidence.persistentVolumeClaim.uid, "login-claim-uid");
  assert.equal(evidence.persistentVolumeClaim.phase, "Bound");
});

test("allows completion authorization after the exact login Job has started or completed", () => {
  const evidence = buildSessionProofCodexLoginCompletionEvidence({
    authorization: {
      ...authorization,
      authorizedAt: "2026-08-05T21:17:30Z",
    },
    loginApplyReceiptSource: applyReceiptSource,
    loginApplyEvidenceSource: applyEvidenceSource,
    job: job(),
    persistentVolumeClaim: claim(),
    observedAt: "2026-08-05T21:18:00Z",
  });
  assert.equal(evidence.job.completionTime, "2026-08-05T21:17:00Z");
});

test("rejects predecessor, apply evidence, Job UID, or claim UID drift", () => {
  assert.throws(() => build({ loginApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ loginApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
  const replacementJob = job();
  replacementJob.metadata.uid = "replacement-job-uid";
  assert.throws(() => build({ job: replacementJob }), /live identity drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ metadata: { uid: "replacement-claim-uid" } }) }), /live identity drifted/);
});

test("rejects pending, failed, retried, malformed, or deleting login completion", () => {
  for (const status of [
    { active: 1, succeeded: 0, completionTime: undefined, conditions: [] },
    { succeeded: 0, failed: 1, conditions: [{ type: "Failed", status: "True" }] },
    { succeeded: 2 },
    { completionTime: "2026-08-05T21:15:59Z" },
  ]) {
    assert.throws(() => build({ job: job(status) }), /Job drifted/);
  }
  const changedSpec = job();
  changedSpec.spec.activeDeadlineSeconds = 901;
  assert.throws(() => build({ job: changedSpec }), /Job drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ status: { phase: "Pending" } }) }), /claim drifted/);
  assert.throws(() => build({ persistentVolumeClaim: claim({ metadata: { deletionTimestamp: "2026-08-05T21:17:30Z" } }) }), /claim drifted/);
  assert.throws(() => build({ job: job({ startTime: "2026-08-05T21:14:59Z" }) }), /timestamp drifted/);
  assert.throws(() => build({ observedAt: "2026-08-05T21:16:59Z" }), /timestamp drifted/);
});

test("rejects generic, oversized, wrong-step, or extra-field completion evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofCodexLoginCompletionEvidence({
    ...authorization,
    stepId: "wait-grants",
  }, evidence), /not qualified/);
  const { persistentVolumeClaim: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofCodexLoginCompletionEvidence(authorization, generic), /identity drifted/);
  assert.throws(() => verifySessionProofCodexLoginCompletionEvidence(authorization, {
    ...evidence,
    loginApplyEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity drifted/);
  assert.throws(() => verifySessionProofCodexLoginCompletionEvidence(authorization, {
    ...evidence,
    podLogs: "forbidden",
  }), /identity drifted/);
});
