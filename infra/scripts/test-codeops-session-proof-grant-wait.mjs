import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { waitForSessionProofGrants } from "./codeops-session-proof-grant-wait.mjs";
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
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
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
  approvedAt: "2026-08-05T20:00:00Z",
  expiresAt: "2026-08-05T22:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T20:01:00Z",
});
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: {
    planSha256,
    stepId: "grant-receipts",
    action: "operator-apply",
    artifact: "grants",
    artifactSha256: artifacts.find((value) => value.id === "grants").sha256,
    namespace: { name: identity.namespace, uid: admission.namespaceUid },
  },
  observedAt: "2026-08-05T20:07:00Z",
  resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Job" ? "grant-job-uid" : `grant-resource-uid-${index}`,
  })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 8,
  stepId: "grant-receipts",
  action: "operator-apply",
  artifact: "grants",
  artifactSha256: artifacts.find((value) => value.id === "grants").sha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 9,
  stepId: "wait-grants",
  action: "operator-wait-complete",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T20:08:00Z",
};

function job({
  complete = true,
  failed = false,
  uid = "grant-job-uid",
  namespace = identity.namespace,
  generation = 1,
} = {}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-session-proof-grants", namespace, uid, generation },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 300 },
    status: {
      active: complete || failed ? 0 : 1,
      succeeded: complete ? 1 : 0,
      failed: failed ? 1 : 0,
      startTime: "2026-08-05T20:09:00Z",
      completionTime: complete ? "2026-08-05T20:09:04Z" : undefined,
      conditions: complete
        ? [{ type: "Complete", status: "True" }]
        : failed ? [{ type: "Failed", status: "True" }] : [],
    },
  };
}

function makeRunner(states) {
  const calls = [];
  let jobReads = 0;
  const runner = (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    if (file === "kubectl" && key === "config current-context") return `${target.context}\n`;
    if (file === "kubectl" && key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (file === "kubectl" && key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (file === "kubectl" && key.includes("client-certificate-data")) return certificateData;
    if (file === "kubectl" && key.startsWith(`get namespace ${identity.namespace}`)) {
      return JSON.stringify(namespaceResource());
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get") {
      const value = states[Math.min(jobReads, states.length - 1)];
      jobReads += 1;
      return JSON.stringify(value);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, get jobReads() { return jobReads; }, runner };
}

function wait(stub, overrides = {}, waitCalls = []) {
  return waitForSessionProofGrants({
    authorization,
    grantApplyReceiptSource: applyReceiptSource,
    grantApplyEvidenceSource: applyEvidenceSource,
    startedAt: "2026-08-05T20:09:00Z",
    completedAt: "2026-08-05T20:10:00Z",
    maxAttempts: 3,
    pollIntervalMs: 1000,
    ...overrides,
  }, stub.runner, (milliseconds) => waitCalls.push(milliseconds));
}

test("polls only the exact Job and receipts its stable successful identity", () => {
  const stub = makeRunner([job({ complete: false }), job(), job()]);
  const waits = [];
  const result = wait(stub, {}, waits);
  assert.equal(result.receipt.stepId, "wait-grants");
  assert.equal(result.receipt.result, "completed");
  assert.equal(JSON.parse(result.evidenceSource).job.uid, "grant-job-uid");
  assert.deepEqual(waits, [1000]);
  assert.equal(stub.jobReads, 3);
  assert.equal(stub.calls.some(({ args }) => ["create", "apply", "patch", "delete"].includes(args[2])), false);
});

test("rejects action, time, chain, or polling-bound drift before Kubernetes access", () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-wait-ready" } },
    { startedAt: "2026-08-05T20:07:59Z" },
    { maxAttempts: 121 },
    { maxAttempts: 120, pollIntervalMs: 4000 },
    { grantApplyReceiptSource: `${applyReceiptSource}\n` },
  ]) {
    const stub = makeRunner([job()]);
    assert.throws(() => wait(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("withholds completion on timeout and fails immediately on terminal Job failure", () => {
  const pending = makeRunner([job({ complete: false })]);
  const waits = [];
  assert.throws(() => wait(pending, { maxAttempts: 3 }, waits), /did not complete/);
  assert.equal(pending.jobReads, 3);
  assert.deepEqual(waits, [1000, 1000]);

  const failed = makeRunner([job({ complete: false, failed: true })]);
  assert.throws(() => wait(failed), /Job failed/);
  assert.equal(failed.jobReads, 1);
});

test("fails closed on replacement, wrong namespace, generation drift, or final status loss", () => {
  for (const states of [
    [job({ uid: "replacement-uid" })],
    [job({ namespace: "shared-dev" })],
    [job({ generation: 2 })],
    [job(), job({ complete: false })],
  ]) {
    const stub = makeRunner(states);
    assert.throws(() => wait(stub));
  }
});
