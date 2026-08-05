import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofApplyEvidence, sessionProofApplyResourceIdentities } from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import { buildSessionProofCodexSmokeReplacementEvidence } from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";
import { waitForSessionProofCodexSmoke } from "./codeops-session-proof-codex-smoke-wait.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "1".repeat(40),
  sessionSuffix: "video-1",
};
const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const operator = {
  username: "kubernetes-admin",
  uid: null,
  credentialSha256: createHash("sha256").update(Buffer.from(certificateData, "base64")).digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({ id, sha256: createHash("sha256").update(`${id}\n`).digest("hex") }));
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts,
  sequence: sessionProofSequence(),
});
const planSha256 = createHash("sha256").update(planSource).digest("hex");

function namespaceResource(uid = "namespace-uid-1") {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid,
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.renoconcierge.ca/proof-run": identity.runId,
        "codeops.renoconcierge.ca/base-sha": identity.baseSha,
      },
    },
  };
}

const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: planSha256,
  operator,
  target,
  approvedAt: "2026-08-05T21:00:00Z",
  expiresAt: "2026-08-05T23:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T21:01:00Z",
});
const namespace = { name: identity.namespace, uid: admission.namespaceUid };
const loginApplyAuthorization = {
  planSha256,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: artifacts.find((value) => value.id === "codex-login").sha256,
  namespace,
};
const loginResources = sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
  ...resource,
  uid: resource.kind === "Job" ? "login-job-uid" : resource.kind === "PersistentVolumeClaim" ? "claim-uid" : `retained-uid-${index}`,
}));
const loginApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: loginApplyAuthorization,
  observedAt: "2026-08-05T21:14:00Z",
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
  authorizedAt: "2026-08-05T21:15:00Z",
};
const loginCompletionEvidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
  authorization: loginWaitAuthorization,
  loginApplyReceiptSource,
  loginApplyEvidenceSource,
  job: {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: "codeops-codex-auth-login", namespace: namespace.name, uid: "login-job-uid", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600 },
    status: { active: 0, succeeded: 1, failed: 0, startTime: "2026-08-05T21:16:00Z", completionTime: "2026-08-05T21:17:00Z", conditions: [{ type: "Complete", status: "True" }] },
  },
  persistentVolumeClaim: {
    apiVersion: "v1", kind: "PersistentVolumeClaim",
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
  artifactSha256: artifacts.find((value) => value.id === "codex-smoke").sha256,
  namespace,
  previousReceiptSha256: createHash("sha256").update(loginCompletionReceiptSource).digest("hex"),
};
const replacementEvidenceSource = JSON.stringify(buildSessionProofCodexSmokeReplacementEvidence({
  authorization: replacementAuthorization,
  loginCompletionReceiptSource,
  loginCompletionEvidenceSource,
  resources: sessionProofApplyResourceIdentities("codex-smoke").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job" ? "smoke-job-uid" : resource.kind === "PersistentVolumeClaim" ? "claim-uid" : `retained-uid-${index}`,
  })),
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
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace,
  stepIndex: 13,
  stepId: "wait-codex-smoke",
  action: "operator-wait-complete",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: createHash("sha256").update(replacementReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T21:19:30Z",
};

function job({ complete = true, failed = false, uid = "smoke-job-uid", namespaceName = identity.namespace, generation = 1 } = {}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-codex-auth-smoke", namespace: namespaceName, uid, generation },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600 },
    status: {
      active: complete || failed ? 0 : 1,
      succeeded: complete ? 1 : 0,
      failed: failed ? 1 : 0,
      startTime: "2026-08-05T21:20:00Z",
      completionTime: complete ? "2026-08-05T21:21:00Z" : undefined,
      conditions: complete ? [{ type: "Complete", status: "True" }] : failed ? [{ type: "Failed", status: "True" }] : [],
    },
  };
}

function claim({ uid = "claim-uid", namespaceName = identity.namespace, phase = "Bound", deleting = false } = {}) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "codeops-codex-auth", namespace: namespaceName, uid, ...(deleting ? { deletionTimestamp: "2026-08-05T21:21:30Z" } : {}) },
    status: { phase },
  };
}

function makeRunner({ jobs, claims = [claim()], namespaceUid = "namespace-uid-1", loginPresent = false }) {
  const calls = [];
  let jobReads = 0;
  let claimReads = 0;
  const runner = (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    if (file === "kubectl" && key === "config current-context") return `${target.context}\n`;
    if (file === "kubectl" && key === "config view --minify -o json") return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    if (file === "kubectl" && key === "auth whoami -o json") return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    if (file === "kubectl" && key.includes("client-certificate-data")) return certificateData;
    if (file === "kubectl" && key.startsWith(`get namespace ${identity.namespace}`)) return JSON.stringify(namespaceResource(namespaceUid));
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get" && args[3] === "job.batch" && args[4] === "codeops-codex-auth-login") return loginPresent ? "job.batch/codeops-codex-auth-login\n" : "";
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get" && args[3] === "job.batch") {
      const value = jobs[Math.min(jobReads, jobs.length - 1)];
      jobReads += 1;
      return JSON.stringify(value);
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get" && args[3] === "persistentvolumeclaim") {
      const value = claims[Math.min(claimReads, claims.length - 1)];
      claimReads += 1;
      return JSON.stringify(value);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, get jobReads() { return jobReads; }, get claimReads() { return claimReads; }, runner };
}

function wait(stub, overrides = {}, waits = []) {
  return waitForSessionProofCodexSmoke({
    authorization,
    smokeReplacementReceiptSource: replacementReceiptSource,
    smokeReplacementEvidenceSource: replacementEvidenceSource,
    startedAt: "2026-08-05T21:20:00Z",
    completedAt: "2026-08-05T21:22:00Z",
    maxAttempts: 3,
    pollIntervalMs: 1000,
    ...overrides,
  }, stub.runner, (milliseconds) => waits.push(milliseconds));
}

test("polls only the exact smoke Job and receipts stable claim-bound success with login absent", () => {
  const stub = makeRunner({ jobs: [job({ complete: false }), job(), job()] });
  const waits = [];
  const result = wait(stub, {}, waits);
  assert.equal(result.receipt.stepId, "wait-codex-smoke");
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.job.uid, "smoke-job-uid");
  assert.equal(evidence.persistentVolumeClaim.uid, "claim-uid");
  assert.equal(evidence.loginJobAbsent, true);
  assert.deepEqual(waits, [1000]);
  assert.equal(stub.jobReads, 3);
  assert.equal(stub.claimReads, 2);
  assert.equal(stub.calls.some(({ args }) => ["create", "apply", "patch", "delete"].includes(args[2])), false);
});

test("rejects action, time, chain, or polling drift before Kubernetes access", () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-wait-ready" } },
    { startedAt: "2026-08-05T21:19:29Z" },
    { maxAttempts: 193 },
    { maxAttempts: 192, pollIntervalMs: 6000 },
    { smokeReplacementReceiptSource: `${replacementReceiptSource}\n` },
  ]) {
    const stub = makeRunner({ jobs: [job()] });
    assert.throws(() => wait(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("withholds completion on timeout and fails immediately on terminal smoke failure", () => {
  const pending = makeRunner({ jobs: [job({ complete: false })] });
  const waits = [];
  assert.throws(() => wait(pending, { maxAttempts: 3 }, waits), /did not complete/);
  assert.deepEqual(waits, [1000, 1000]);
  const failed = makeRunner({ jobs: [job({ complete: false, failed: true })] });
  assert.throws(() => wait(failed), /Job failed/);
  assert.equal(failed.jobReads, 1);
});

test("fails closed on smoke, claim, login absence, Namespace, or final-state drift", () => {
  for (const input of [
    { jobs: [job({ uid: "replacement-job-uid" })] },
    { jobs: [job({ namespaceName: "shared-dev" })] },
    { jobs: [job({ generation: 2 })] },
    { jobs: [job()], claims: [claim({ uid: "replacement-claim-uid" })] },
    { jobs: [job()], claims: [claim({ phase: "Pending" })] },
    { jobs: [job()], claims: [claim({ deleting: true })] },
    { jobs: [job(), job({ complete: false })] },
    { jobs: [job()], claims: [claim(), claim({ uid: "replacement-claim-uid" })] },
    { jobs: [job()], namespaceUid: "replacement-namespace-uid" },
    { jobs: [job()], loginPresent: true },
  ]) {
    const stub = makeRunner(input);
    assert.throws(() => wait(stub));
  }
});
