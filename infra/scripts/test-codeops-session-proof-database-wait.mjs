import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { waitForSessionProofDatabase } from "./codeops-session-proof-database-wait.mjs";
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
  approvedAt: "2026-08-05T18:00:00Z",
  expiresAt: "2026-08-05T20:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T18:01:00Z",
});
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: {
    planSha256,
    stepId: "start-database",
    action: "operator-apply",
    artifact: "database",
    artifactSha256: artifacts.find((value) => value.id === "database").sha256,
    namespace: { name: identity.namespace, uid: admission.namespaceUid },
  },
  observedAt: "2026-08-05T18:06:00Z",
  resources: sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
    ...resource,
    uid: resource.kind === "Deployment" ? "database-deployment-uid" : `database-resource-uid-${index}`,
  })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 4,
  stepId: "start-database",
  action: "operator-apply",
  artifact: "database",
  artifactSha256: artifacts.find((value) => value.id === "database").sha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 5,
  stepId: "wait-database",
  action: "operator-wait-ready",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T18:07:00Z",
};

function deployment({
  ready = true,
  uid = "database-deployment-uid",
  namespace = identity.namespace,
  generation = 1,
} = {}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "codeops-session-proof-database", namespace, uid, generation },
    spec: { replicas: 1 },
    status: {
      observedGeneration: generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: ready ? 1 : 0,
      availableReplicas: ready ? 1 : 0,
      unavailableReplicas: ready ? 0 : 1,
      conditions: [
        { type: "Available", status: ready ? "True" : "False" },
        { type: "Progressing", status: "True" },
      ],
    },
  };
}

function makeRunner(states) {
  const calls = [];
  let deploymentReads = 0;
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
      const value = states[Math.min(deploymentReads, states.length - 1)];
      deploymentReads += 1;
      return JSON.stringify(value);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, get deploymentReads() { return deploymentReads; }, runner };
}

function wait(stub, overrides = {}, waitCalls = []) {
  return waitForSessionProofDatabase({
    authorization,
    databaseApplyReceiptSource: applyReceiptSource,
    databaseApplyEvidenceSource: applyEvidenceSource,
    startedAt: "2026-08-05T18:08:00Z",
    completedAt: "2026-08-05T18:09:00Z",
    maxAttempts: 3,
    pollIntervalMs: 1000,
    ...overrides,
  }, stub.runner, (milliseconds) => waitCalls.push(milliseconds));
}

test("polls only the exact Deployment and receipts its stable ready identity", () => {
  const stub = makeRunner([deployment({ ready: false }), deployment(), deployment()]);
  const waits = [];
  const result = wait(stub, {}, waits);
  assert.equal(result.receipt.stepId, "wait-database");
  assert.equal(result.receipt.result, "completed");
  assert.equal(JSON.parse(result.evidenceSource).deployment.uid, "database-deployment-uid");
  assert.deepEqual(waits, [1000]);
  assert.equal(stub.deploymentReads, 3);
  assert.equal(stub.calls.some(({ args }) => ["create", "apply", "patch", "delete"].includes(args[2])), false);
});

test("rejects action, time, chain, or polling-bound drift before Kubernetes access", () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-apply" } },
    { startedAt: "2026-08-05T18:06:59Z" },
    { maxAttempts: 121 },
    { maxAttempts: 120, pollIntervalMs: 10_000 },
    { databaseApplyReceiptSource: `${applyReceiptSource}\n` },
  ]) {
    const stub = makeRunner([deployment()]);
    assert.throws(() => wait(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("withholds completion on timeout within the exact reviewed attempt bound", () => {
  const stub = makeRunner([deployment({ ready: false })]);
  const waits = [];
  assert.throws(() => wait(stub, { maxAttempts: 3 }, waits), /did not become ready/);
  assert.equal(stub.deploymentReads, 3);
  assert.deepEqual(waits, [1000, 1000]);
});

test("fails closed on replacement, wrong namespace, or final readiness drift", () => {
  for (const states of [
    [deployment({ uid: "replacement-uid" })],
    [deployment({ namespace: "shared-dev" })],
    [deployment({ generation: 2 })],
    [deployment(), deployment({ ready: false })],
  ]) {
    const stub = makeRunner(states);
    assert.throws(() => wait(stub));
  }
});
