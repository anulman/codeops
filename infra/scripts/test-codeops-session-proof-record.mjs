import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
} from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { completeSessionProofRecording } from "./codeops-session-proof-record.mjs";
import { buildSessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
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
  credentialSha256: digest(Buffer.from(certificateData, "base64")),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
    .map((id) => ({ id, sha256: digest(`${id}\n`) })),
  sequence: sessionProofSequence(),
});
const planSha256 = digest(planSource);

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
  approvedAt: "2026-08-05T22:00:00Z",
  expiresAt: "2026-08-06T02:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T22:01:00Z",
});
const namespace = { name: identity.namespace, uid: admission.namespaceUid };
const applyAuthorization = {
  planSha256,
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: digest("runtime\n"),
  namespace,
  admission,
};
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:20:00Z",
  resources: sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
    .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
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
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
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
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace,
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(runtimeReceiptSource),
  authorizedAt: "2026-08-05T22:21:30Z",
};
const inspection = {
  legible: true,
  completeOperationCoverage: true,
  correctFinalLifecycleState: true,
  syntheticOwnedContentOnly: true,
  sensitiveMaterialAbsent: true,
};
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function makeCapture() {
  const root = mkdtempSync(join(tmpdir(), "codeops-proof-record-"));
  roots.push(root);
  mkdirSync(join(root, "browser", "video"), { recursive: true });
  mkdirSync(join(root, "session"));
  writeFileSync(join(root, "browser", "video", "raw.webm"), "canonical raw video");
  writeFileSync(join(root, "browser", "trace.zip"), "playwright trace");
  writeFileSync(join(root, "session", "export.json"), '{"sessions":[]}\n');
  writeFileSync(join(root, "assertions.json"), '{"result":"passed"}\n');
  return root;
}

function makeRunner(options = {}) {
  const calls = [];
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
      return JSON.stringify(namespaceResource(options.replacementNamespace ? "replacement-uid" : undefined));
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

function complete(root, stub, overrides = {}) {
  return completeSessionProofRecording({
    authorization,
    runtimeReadinessReceiptSource: runtimeReceiptSource,
    runtimeReadinessEvidenceSource: runtimeEvidenceSource,
    captureDirectory: root,
    startedAt: "2026-08-05T22:22:00Z",
    finishedAt: "2026-08-05T22:30:00Z",
    completedAt: "2026-08-05T22:31:00Z",
    inspection,
    ...overrides,
  }, stub.runner);
}

test("receipts the exact off-cluster artifact tree without a Kubernetes mutation", () => {
  const root = makeCapture();
  const stub = makeRunner();
  const result = complete(root, stub);
  assert.equal(result.receipt.stepId, "record-proof");
  assert.equal(JSON.parse(result.evidenceSource).capture.artifacts.length, 4);
  assert.equal(stub.calls.some(({ args }) => args.includes("create") || args.includes("apply") || args.includes("delete")), false);
});

test("rejects missing, extra, symbolic-link, empty, or oversized artifacts before live access", () => {
  const cases = [
    (root) => rmSync(join(root, "browser", "trace.zip")),
    (root) => writeFileSync(join(root, "extra.txt"), "extra"),
    (root) => {
      rmSync(join(root, "assertions.json"));
      symlinkSync(join(root, "session", "export.json"), join(root, "assertions.json"));
    },
    (root) => writeFileSync(join(root, "assertions.json"), ""),
    (root) => truncateSync(join(root, "assertions.json"), 1_000_001),
  ];
  for (const mutate of cases) {
    const root = makeCapture();
    mutate(root);
    const stub = makeRunner();
    assert.throws(() => complete(root, stub));
    assert.equal(stub.calls.length, 0);
  }
});

test("rejects chain, inspection, timestamp, or final Namespace identity drift", () => {
  const root = makeCapture();
  for (const overrides of [
    { runtimeReadinessReceiptSource: `${runtimeReceiptSource}\n` },
    { inspection: { ...inspection, sensitiveMaterialAbsent: false } },
    { startedAt: "2026-08-05T22:20:00Z" },
  ]) {
    const stub = makeRunner();
    assert.throws(() => complete(root, stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
  const replaced = makeRunner({ replacementNamespace: true });
  assert.throws(() => complete(root, replaced), /Namespace UID/);
});
