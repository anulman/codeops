import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofApplyEvidence, sessionProofApplyResourceIdentities } from "./codeops-session-proof-apply-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import { waitForSessionProofRuntime } from "./codeops-session-proof-runtime-wait.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
const identity = { namespace: "codeops-session-proof-video-1", runId: "video-1", baseSha: "1".repeat(40), sessionSuffix: "video-1" };
const certificateData = Buffer.from("synthetic").toString("base64");
const operator = { username: "kubernetes-admin", uid: null, credentialSha256: digest(Buffer.from(certificateData, "base64")) };
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({ id, sha256: digest(`${id}\n`) }));
const planSource = JSON.stringify({ apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1", admission: "closed", execution: "render-and-review-only", identity, artifacts, sequence: sessionProofSequence() });
const planSha256 = digest(planSource);

function namespaceResource(uid = "namespace-uid-1") {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name: identity.namespace, uid, labels: {
    "app.kubernetes.io/part-of": "codeops-session-proof",
    "codeops.renoconcierge.ca/proof-run": identity.runId,
    "codeops.renoconcierge.ca/base-sha": identity.baseSha,
  } } };
}

const admission = bindSessionProofNamespace(createSessionProofAdmission({
  planSource, reviewedPlanSha256: planSha256, operator, target,
  approvedAt: "2026-08-05T21:00:00Z", expiresAt: "2026-08-05T23:00:00Z",
}), { namespaceResource: namespaceResource(), operator, target, observedAt: "2026-08-05T21:01:00Z" });
const applyAuthorization = { planSha256, stepIndex: 16, stepId: "start-runtime", action: "operator-apply", artifact: "runtime", artifactSha256: artifacts.find((value) => value.id === "runtime").sha256, namespace: { name: identity.namespace, uid: admission.namespaceUid }, admission };
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization, observedAt: "2026-08-05T22:19:30Z",
  resources: sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
    .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1", result: "completed", proceed: true,
  planSha256, namespace: applyAuthorization.namespace, stepIndex: 16, stepId: "start-runtime", action: "operator-apply",
  artifact: "runtime", artifactSha256: applyAuthorization.artifactSha256, evidenceSha256: digest(applyEvidenceSource),
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256, admission, namespace: applyAuthorization.namespace, stepIndex: 17,
  stepId: "wait-runtime", action: "operator-wait-ready", artifact: null, artifactSha256: null,
  previousReceiptSha256: digest(applyReceiptSource), authorizedAt: "2026-08-05T22:19:45Z",
};

function rawJob(ready, uid = "runtime-resource-uid-0") {
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: "codeops-session-runtime-video-1", namespace: identity.namespace, uid, generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: ready ? 1 : 0, startTime: "2026-08-05T22:20:00Z" },
  };
}

function rawPod(ready, ownerUid = "runtime-resource-uid-0") {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-abcde", namespace: identity.namespace, uid: "runtime-pod-uid",
      labels: { "job-name": "codeops-session-runtime-video-1" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", uid: ownerUid, controller: true }],
    },
    status: {
      phase: "Running", startTime: "2026-08-05T22:20:01Z",
      conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"].map((type) => ({ type, status: ready ? "True" : type === "PodScheduled" ? "True" : "False" })),
      initContainerStatuses: ready ? [{ name: "workspace-builder", restartCount: 0, state: { terminated: { exitCode: 0 } } }] : [],
      containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({ name, ready, restartCount: 0, state: { running: { startedAt: "2026-08-05T22:20:02Z" } } })),
    },
  };
}

function makeRunner(options = {}) {
  let jobReads = 0;
  let namespaceReads = 0;
  const calls = [];
  const runner = (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    if (key === "auth whoami -o json") return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    if (key.includes("client-certificate-data")) return certificateData;
    if (key.startsWith(`get namespace ${identity.namespace}`)) {
      namespaceReads += 1;
      return JSON.stringify(namespaceResource(options.replaceNamespace && namespaceReads > 1 ? "replacement" : "namespace-uid-1"));
    }
    if (args[2] === "get" && args[3] === "job.batch") {
      jobReads += 1;
      if (options.terminalFailure) {
        const value = rawJob(false); value.status = { failed: 1, startTime: "2026-08-05T22:20:00Z", conditions: [{ type: "Failed", status: "True" }] }; return JSON.stringify(value);
      }
      return JSON.stringify(rawJob(jobReads > (options.readyAfter ?? 1), options.replaceJob && jobReads > 1 ? "replacement" : undefined));
    }
    if (args[2] === "get" && args[3] === "pods") {
      const ready = jobReads > (options.readyAfter ?? 1);
      if (options.noPod) return JSON.stringify({ apiVersion: "v1", kind: "List", items: [] });
      return JSON.stringify({ apiVersion: "v1", kind: "List", items: [rawPod(ready, options.replacePodOwner ? "replacement" : undefined)] });
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

function wait(stub, overrides = {}) {
  const waits = [];
  const result = waitForSessionProofRuntime({
    authorization, runtimeApplyReceiptSource: applyReceiptSource, runtimeApplyEvidenceSource: applyEvidenceSource,
    startedAt: "2026-08-05T22:20:00Z", completedAt: "2026-08-05T22:21:00Z",
    maxAttempts: 3, pollIntervalMs: 1, ...overrides,
  }, stub.runner, (milliseconds) => waits.push(milliseconds));
  return { result, waits };
}

test("polls the exact Job and Pod until initialized readiness is stable", () => {
  const stub = makeRunner();
  const { result, waits } = wait(stub);
  assert.equal(result.receipt.stepId, "wait-runtime");
  assert.deepEqual(waits, [1]);
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.job.uid, "runtime-resource-uid-0");
  assert.equal(evidence.pod.ownerJobUid, evidence.job.uid);
  assert.equal(stub.calls.some(({ args }) => args.includes("logs")), false);
});

test("rejects action, chain, time, or polling drift before Kubernetes access", () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-apply" } },
    { runtimeApplyReceiptSource: `${applyReceiptSource}\n` },
    { startedAt: "2026-08-05T22:19:44Z" },
    { maxAttempts: 301 },
    { maxAttempts: 32, pollIntervalMs: 10_000 },
  ]) {
    const stub = makeRunner();
    assert.throws(() => wait(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("times out when no Pod becomes ready and fails immediately on terminal Job failure", () => {
  const missing = makeRunner({ noPod: true });
  assert.throws(() => wait(missing), /did not become ready/);
  const failed = makeRunner({ terminalFailure: true });
  assert.throws(() => wait(failed), /terminal failure/);
});

test("fails closed on Job, Pod owner, Namespace, or final-state replacement", () => {
  for (const options of [
    { replaceJob: true, readyAfter: 0 },
    { replacePodOwner: true, readyAfter: 0 },
    { replaceNamespace: true, readyAfter: 0 },
  ]) assert.throws(() => wait(makeRunner(options)));
});
