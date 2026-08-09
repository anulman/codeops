import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofGrantCompletionEvidence,
  verifySessionProofGrantCompletionEvidence,
} from "./codeops-session-proof-grant-completion-evidence.mjs";

const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const applyAuthorization = {
  planSha256: "a".repeat(64),
  stepId: "grant-receipts",
  action: "operator-apply",
  artifact: "grants",
  artifactSha256: "b".repeat(64),
  namespace,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T20:40:00Z",
  resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job" ? "grant-job-uid" : `resource-uid-${index}`,
  })),
}));
const applyReceipt = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256: applyAuthorization.planSha256,
  namespace,
  stepIndex: 8,
  stepId: "grant-receipts",
  action: "operator-apply",
  artifact: "grants",
  artifactSha256: applyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
};
const applyReceiptSource = JSON.stringify(applyReceipt);
const authorization = {
  planSha256: applyAuthorization.planSha256,
  stepIndex: 9,
  stepId: "wait-grants",
  action: "operator-wait-complete",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T20:40:30Z",
};

function job(overrides = {}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: "codeops-session-proof-grants",
      namespace: namespace.name,
      uid: "grant-job-uid",
      generation: 1,
    },
    spec: {
      completions: 1,
      parallelism: 1,
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
    },
    status: {
      active: 0,
      succeeded: 1,
      failed: 0,
      startTime: "2026-08-05T20:41:00Z",
      completionTime: "2026-08-05T20:41:04Z",
      conditions: [{ type: "Complete", status: "True", reason: "CompletionsReached" }],
      ...overrides,
    },
  };
}

function build(overrides = {}) {
  return buildSessionProofGrantCompletionEvidence({
    authorization,
    grantApplyReceiptSource: applyReceiptSource,
    grantApplyEvidenceSource: applyEvidenceSource,
    job: job(),
    observedAt: "2026-08-05T20:42:00Z",
    ...overrides,
  });
}

test("binds grant completion to the exact apply evidence and successful Job UID", () => {
  const evidence = build();
  assert.equal(
    createHash("sha256").update(evidence.grantApplyReceiptSource).digest("hex"),
    authorization.previousReceiptSha256,
  );
  assert.equal(evidence.job.uid, "grant-job-uid");
  assert.equal(evidence.job.succeeded, 1);
  assert.equal(evidence.job.failed, 0);
});

test("rejects predecessor, apply evidence, or applied Job UID drift", () => {
  assert.throws(() => build({ grantApplyReceiptSource: `${applyReceiptSource}\n` }), /predecessor/);
  assert.throws(() => build({ grantApplyEvidenceSource: `${applyEvidenceSource}\n` }), /receipt identity/);
  const replacement = job();
  replacement.metadata.uid = "replacement-job-uid";
  assert.throws(() => build({ job: replacement }), /UID drifted/);
});

test("rejects pending, failed, retried, malformed, or extra-field completion", () => {
  for (const status of [
    { active: 1, succeeded: 0, completionTime: undefined, conditions: [] },
    { succeeded: 0, failed: 1, conditions: [{ type: "Failed", status: "True" }] },
    { succeeded: 2 },
    { completionTime: "2026-08-05T20:40:59Z" },
  ]) {
    assert.throws(() => build({ job: job(status) }), /Job drifted/);
  }
  const changedSpec = job();
  changedSpec.spec.backoffLimit = 1;
  assert.throws(() => build({ job: changedSpec }), /Job drifted/);
  assert.throws(() => build({ observedAt: "2026-08-05T20:41:03Z" }), /timestamp drifted/);
  const evidence = build();
  assert.throws(() => verifySessionProofGrantCompletionEvidence(authorization, {
    ...evidence,
    podLogs: "forbidden",
  }), /identity drifted/);
});

test("allows the applied Job to start before the later wait authorization", () => {
  const appliedBeforeWaitAuthorization = job();
  appliedBeforeWaitAuthorization.status.startTime = "2026-08-05T20:40:29Z";
  const evidence = build({ job: appliedBeforeWaitAuthorization });
  assert.equal(evidence.job.uid, "grant-job-uid");
  assert.equal(evidence.job.startTime, "2026-08-05T20:40:29Z");
});

test("rejects generic, oversized, or wrong-step completion evidence", () => {
  const evidence = build();
  assert.throws(() => verifySessionProofGrantCompletionEvidence({
    ...authorization,
    stepId: "wait-codex-login",
  }, evidence), /not qualified/);
  const { job: ignored, ...generic } = evidence;
  assert.ok(ignored);
  assert.throws(() => verifySessionProofGrantCompletionEvidence(authorization, generic), /identity drifted/);
  assert.throws(() => verifySessionProofGrantCompletionEvidence(authorization, {
    ...evidence,
    grantApplyEvidenceSource: "x".repeat(64 * 1024 + 1),
  }), /identity drifted/);
});
