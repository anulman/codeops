import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import {
  completeSessionProofRecordingFromOperatorPacket,
  persistSessionProofRecordingFromOperatorPacket,
  readSessionProofRecordingOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-record.mjs";
import {
  authorizeEighteenthSessionProofStepFromOperatorPacket,
  persistEighteenthSessionProofStepAuthorizationFromOperatorPacket,
  readEighteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-stop-authorization.mjs";
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

test("hands the exact persisted authorization and runtime readiness outputs to the recorder", () => {
  const input = {
    packetPath: "/private/codeops-session-proof-video-1.packet",
    seventeenthAuthorizationPath:
      "/private/codeops-session-proof-video-1.step-21-record-proof.authorization.json",
    captureDirectory: "/private/capture",
    startedAt: "2026-08-05T22:22:00Z",
    finishedAt: "2026-08-05T22:30:00Z",
    completedAt: "2026-08-05T22:31:00Z",
    inspection,
  };
  const stub = makeRunner();
  let readCalls = 0;
  let recordCalls = 0;
  const result = completeSessionProofRecordingFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      recordCalls += 1;
      assert.equal(runnerArgument, stub.runner);
      assert.deepEqual(received, {
        authorization,
        runtimeReadinessReceiptSource: runtimeReceiptSource,
        runtimeReadinessEvidenceSource: runtimeEvidenceSource,
        captureDirectory: input.captureDirectory,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        completedAt: input.completedAt,
        inspection,
      });
      return { evidenceSource: "recording-evidence", receipt: { stepId: "record-proof" } };
    },
    (received, runnerArgument) => {
      readCalls += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization,
        authorizationSource: "private authorization bytes",
        runtimeWaitOutputs: {
          sixteenthStepReceiptSource: runtimeReceiptSource,
          sixteenthEvidenceSource: runtimeEvidenceSource,
          unrelatedPrivatePredecessor: "must not cross the recorder boundary",
        },
      };
    },
  );
  assert.equal(readCalls, 1);
  assert.equal(recordCalls, 1);
  assert.deepEqual(result, {
    evidenceSource: "recording-evidence",
    receipt: { stepId: "record-proof" },
  });
  assert.equal(stub.calls.length, 0);
});

test("authorization readback drift fails before the recorder can be reached", () => {
  const stub = makeRunner();
  let recordCalls = 0;
  assert.throws(() => completeSessionProofRecordingFromOperatorPacket(
    { packetPath: "/private/codeops-session-proof-video-1.packet" },
    stub.runner,
    () => {
      recordCalls += 1;
    },
    () => {
      throw new Error("proof record authorization drifted");
    },
  ), /authorization drifted/);
  assert.equal(recordCalls, 0);
  assert.equal(stub.calls.length, 0);
});

test("durably persists exact private recording evidence and its canonical receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-output-"));
  roots.push(root);
  const input = {
    packetPath: join(root, `${identity.namespace}.packet`),
    seventeenthEvidencePath: join(
      root,
      `${identity.namespace}.step-21-record-proof.evidence.json`,
    ),
    seventeenthStepReceiptPath: join(
      root,
      `${identity.namespace}.step-21-record-proof.receipt.json`,
    ),
  };
  const stub = makeRunner();
  const evidenceSource = '{"recording":"verified"}';
  const receipt = { stepId: "record-proof", checkedAt: "2026-08-05T22:31:00Z" };
  let completionCalls = 0;
  const result = persistSessionProofRecordingFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      completionCalls += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      assert.equal(statSync(input.seventeenthEvidencePath).size, 0);
      assert.equal(statSync(input.seventeenthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(input.seventeenthStepReceiptPath).size, 0);
      assert.equal(statSync(input.seventeenthStepReceiptPath).mode & 0o777, 0o600);
      return { evidenceSource, receipt };
    },
  );
  const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`;
  assert.equal(completionCalls, 1);
  assert.equal(result.evidenceSource, evidenceSource);
  assert.equal(result.receiptSource, receiptSource);
  assert.deepEqual(result.receipt, receipt);
  assert.equal(readFileSync(input.seventeenthEvidencePath, "utf8"), evidenceSource);
  assert.equal(readFileSync(input.seventeenthStepReceiptPath, "utf8"), receiptSource);
  assert.equal(statSync(input.seventeenthEvidencePath).mode & 0o777, 0o600);
  assert.equal(statSync(input.seventeenthStepReceiptPath).mode & 0o777, 0o600);
  assert.equal(stub.calls.length, 0);
});

test("unsafe or occupied recording outputs fail before completion", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-output-"));
  roots.push(root);
  const packetPath = join(root, `${identity.namespace}.packet`);
  const seventeenthEvidencePath = join(
    root,
    `${identity.namespace}.step-21-record-proof.evidence.json`,
  );
  const seventeenthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-21-record-proof.receipt.json`,
  );
  let completionCalls = 0;
  const completion = () => {
    completionCalls += 1;
  };
  assert.throws(() => persistSessionProofRecordingFromOperatorPacket({
    packetPath,
    seventeenthEvidencePath: join(root, "substituted.evidence.json"),
    seventeenthStepReceiptPath,
  }, undefined, completion), /derive exactly/);
  writeFileSync(seventeenthStepReceiptPath, "occupied\n", { mode: 0o600 });
  assert.throws(() => persistSessionProofRecordingFromOperatorPacket({
    packetPath,
    seventeenthEvidencePath,
    seventeenthStepReceiptPath,
  }, undefined, completion), /already exists/);
  assert.equal(completionCalls, 0);
});

test("reopens exact private recording outputs and reconstructs the canonical receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-output-"));
  roots.push(root);
  const captureDirectory = makeCapture();
  const stub = makeRunner();
  const completed = complete(captureDirectory, stub);
  const input = {
    packetPath: join(root, `${identity.namespace}.packet`),
    seventeenthEvidencePath: join(
      root,
      `${identity.namespace}.step-21-record-proof.evidence.json`,
    ),
    seventeenthStepReceiptPath: join(
      root,
      `${identity.namespace}.step-21-record-proof.receipt.json`,
    ),
  };
  const receiptSource = `${JSON.stringify(completed.receipt, null, 2)}\n`;
  writeFileSync(input.seventeenthEvidencePath, completed.evidenceSource, { mode: 0o600 });
  writeFileSync(input.seventeenthStepReceiptPath, receiptSource, { mode: 0o600 });
  const readAuthorization = () => ({
    authorization,
    runtimeWaitOutputs: { marker: "private-runtime-readiness-chain" },
  });
  const reopened = readSessionProofRecordingOutputsFromOperatorPacket(
    input,
    stub.runner,
    readAuthorization,
  );
  assert.equal(reopened.marker, "private-runtime-readiness-chain");
  assert.deepEqual(reopened.seventeenthAuthorization, authorization);
  assert.equal(reopened.seventeenthEvidenceSource, completed.evidenceSource);
  assert.equal(reopened.seventeenthStepReceiptSource, receiptSource);

  chmodSync(input.seventeenthEvidencePath, 0o640);
  assert.throws(() => readSessionProofRecordingOutputsFromOperatorPacket(
    input,
    stub.runner,
    readAuthorization,
  ), /private regular file/);
  chmodSync(input.seventeenthEvidencePath, 0o600);
  writeFileSync(
    input.seventeenthStepReceiptPath,
    `${JSON.stringify({ ...completed.receipt, extra: true }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.throws(() => readSessionProofRecordingOutputsFromOperatorPacket(
    input,
    stub.runner,
    readAuthorization,
  ), /exact persisted artifact/);
});

test("authorizes stop-runtime from the exact persisted recording predecessor chain", () => {
  const stub = makeRunner();
  const plan = JSON.parse(planSource);
  const creationReceipt = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-create/v1",
    result: "created-and-uid-bound",
    checkedAt: "2026-08-05T22:01:00Z",
    planSha256,
    namespaceManifestSha256: plan.artifacts.find((value) => value.id === "namespace").sha256,
    namespace,
    proceed: true,
    admission,
  };
  const creationReceiptSource = JSON.stringify(creationReceipt);
  let previousReceiptSha256 = digest(creationReceiptSource);
  const receiptSources = plan.sequence.slice(2, 19).map((step, offset) => {
    const stepIndex = offset + 2;
    const source = JSON.stringify({
      apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
      result: "completed",
      proceed: true,
      checkedAt: `2026-08-05T22:${String(stepIndex + 1).padStart(2, "0")}:00Z`,
      planSha256,
      namespace,
      stepIndex,
      stepId: step.id,
      action: step.action,
      artifact: step.artifact ?? null,
      artifactSha256: step.artifact
        ? plan.artifacts.find((value) => value.id === step.artifact).sha256
        : null,
      previousReceiptSha256,
      evidenceSha256: digest(`evidence-${step.id}`),
    });
    previousReceiptSha256 = digest(source);
    return source;
  });
  const outputs = {
    planSource,
    creationReceiptSource,
    creationReceipt,
    stepReceiptSource: receiptSources[0],
    secondStepReceiptSource: receiptSources[1],
    thirdStepReceiptSource: receiptSources[2],
    fourthStepReceiptSource: receiptSources[3],
    fifthStepReceiptSource: receiptSources[4],
    sixthStepReceiptSource: receiptSources[5],
    seventhStepReceiptSource: receiptSources[6],
    eighthStepReceiptSource: receiptSources[7],
    ninthStepReceiptSource: receiptSources[8],
    tenthStepReceiptSource: receiptSources[9],
    eleventhStepReceiptSource: receiptSources[10],
    twelfthStepReceiptSource: receiptSources[11],
    thirteenthStepReceiptSource: receiptSources[12],
    fourteenthStepReceiptSource: receiptSources[13],
    fifteenthStepReceiptSource: receiptSources[14],
    sixteenthStepReceiptSource: receiptSources[15],
    seventeenthStepReceiptSource: receiptSources[16],
  };
  let readCalls = 0;
  const result = authorizeEighteenthSessionProofStepFromOperatorPacket(
    { observedAt: "2026-08-05T22:31:30Z" },
    stub.runner,
    (input, runnerArgument) => {
      readCalls += 1;
      assert.equal(input.observedAt, "2026-08-05T22:31:30Z");
      assert.equal(runnerArgument, stub.runner);
      return outputs;
    },
  );
  assert.equal(readCalls, 1);
  assert.equal(result.stepIndex, 19);
  assert.equal(result.stepId, "stop-runtime");
  assert.equal(result.action, "operator-delete-exact-runtime-job");
  assert.equal(result.artifact, null);
  assert.equal(result.artifactSha256, null);
  assert.equal(result.previousReceiptSha256, digest(receiptSources[16]));
  assert.equal(result.authorizedAt, "2026-08-05T22:31:30Z");
  assert.equal(
    stub.calls.some(({ args }) => args.includes("create") || args.includes("apply") || args.includes("delete")),
    false,
  );
});

test("recording output drift fails before stop-runtime authorization", () => {
  const stub = makeRunner();
  let authorizeCalls = 0;
  assert.throws(() => authorizeEighteenthSessionProofStepFromOperatorPacket(
    { observedAt: "2026-08-05T22:31:30Z" },
    stub.runner,
    () => {
      throw new Error("proof recording receipt drifted");
    },
    () => {
      authorizeCalls += 1;
    },
  ), /recording receipt drifted/);
  assert.equal(authorizeCalls, 0);
  assert.equal(stub.calls.length, 0);
});

test("persists and reopens the exact private stop-runtime authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-stop-auth-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const eighteenthAuthorizationPath = join(
      root,
      `${identity.namespace}.step-22-stop-runtime.authorization.json`,
    );
    const authorization = {
      apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
      planSha256,
      admission,
      namespace,
      stepIndex: 19,
      stepId: "stop-runtime",
      action: "operator-delete-exact-runtime-job",
      artifact: null,
      artifactSha256: null,
      previousReceiptSha256: "f".repeat(64),
      authorizedAt: "2026-08-05T22:31:30Z",
    };
    const stub = makeRunner();
    let builds = 0;
    const buildAuthorization = (input, runnerArgument) => {
      builds += 1;
      assert.equal(input.observedAt, authorization.authorizedAt);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization,
        recordingOutputs: { marker: "private-recording-chain" },
      };
    };
    const persisted = persistEighteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      eighteenthAuthorizationPath,
      observedAt: authorization.authorizedAt,
    }, stub.runner, (input, runnerArgument) =>
      buildAuthorization(input, runnerArgument).authorization);
    assert.deepEqual(persisted, authorization);
    assert.equal(statSync(eighteenthAuthorizationPath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(eighteenthAuthorizationPath, "utf8"),
      `${JSON.stringify(authorization, null, 2)}\n`,
    );
    const reopened = readEighteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      eighteenthAuthorizationPath,
    }, stub.runner, buildAuthorization);
    assert.deepEqual(reopened.authorization, authorization);
    assert.equal(reopened.authorizationSource, readFileSync(eighteenthAuthorizationPath, "utf8"));
    assert.equal(reopened.recordingOutputs.marker, "private-recording-chain");
    assert.equal(builds, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe stop-runtime authorization targets before authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-stop-auth-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const eighteenthAuthorizationPath = join(
      root,
      `${identity.namespace}.step-22-stop-runtime.authorization.json`,
    );
    let authorizeCalls = 0;
    const authorizeStep = () => {
      authorizeCalls += 1;
      throw new Error("authorization must not run");
    };
    assert.throws(() => persistEighteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      eighteenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T22:31:30Z",
    }, undefined, authorizeStep), /derive exactly/);
    writeFileSync(eighteenthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistEighteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      eighteenthAuthorizationPath,
      observedAt: "2026-08-05T22:31:30Z",
    }, undefined, authorizeStep), /already exists/);
    assert.equal(authorizeCalls, 0);

    chmodSync(eighteenthAuthorizationPath, 0o644);
    assert.throws(() => readEighteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      eighteenthAuthorizationPath,
    }, undefined, authorizeStep), /bounded private regular file/);
    assert.equal(authorizeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
