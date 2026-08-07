import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  readSessionProofRuntimeApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-apply.mjs";
import {
  authorizeSixteenthSessionProofStepFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait-authorization.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import { applySessionProofRuntime } from "./codeops-session-proof-runtime-apply.mjs";
import { completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "1".repeat(40),
  sessionSuffix: "video-1",
};
const manifestSource = "reviewed runtime manifest\n";
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
  .map((id) => ({
    id,
    sha256: createHash("sha256").update(id === "runtime" ? manifestSource : `${id}\n`).digest("hex"),
  }));
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
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: artifacts.find((value) => value.id === "runtime").sha256,
  previousReceiptSha256: "a".repeat(64),
  authorizedAt: "2026-08-05T22:19:00Z",
};

const typeByIdentity = new Map([
  ["batch/v1/Job", "job.batch"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function makeRunner(options = {}) {
  let created = false;
  let namespaceReadsAfterCreate = 0;
  let postCreateInventoryReads = 0;
  const calls = [];
  const runner = (file, args, executionOptions = {}) => {
    calls.push({ file, args, options: executionOptions });
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
      if (created) namespaceReadsAfterCreate += 1;
      return JSON.stringify(namespaceResource(
        options.replaceNamespaceAfterCreate && namespaceReadsAfterCreate > 0
          ? "replacement-uid"
          : "namespace-uid-1",
      ));
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "create") {
      assert.equal(executionOptions.input, manifestSource);
      created = true;
      if (options.failCreate) throw new Error("synthetic partial create");
      return "created\n";
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get") {
      const expected = sessionProofApplyResourceIdentities("start-runtime", authorization)
        .find((resource) =>
          typeByIdentity.get(`${resource.apiVersion}/${resource.kind}`) === args[3] &&
          resource.name === args[4]);
      assert.ok(expected);
      if (!created && options.preexistingKind !== expected.kind) return "";
      if (created) postCreateInventoryReads += 1;
      if (created && options.missingAfterCreate === expected.kind) return "";
      const round = Math.floor((postCreateInventoryReads - 1) / 3);
      const uid = options.replaceResourceAfterCreate && round > 0 && expected.kind === "Job"
        ? "replacement-resource-uid"
        : `resource-uid-${expected.kind}`;
      return JSON.stringify({
        apiVersion: expected.apiVersion,
        kind: expected.kind,
        metadata: { name: expected.name, namespace: identity.namespace, uid },
      });
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

function apply(stub, overrides = {}) {
  return applySessionProofRuntime({
    authorization,
    manifestSource,
    startedAt: "2026-08-05T22:20:00Z",
    completedAt: "2026-08-05T22:21:00Z",
    ...overrides,
  }, stub.runner);
}

test("creates only the reviewed runtime package and receipts three stable server UIDs", () => {
  const stub = makeRunner();
  const result = apply(stub);
  assert.equal(result.receipt.stepId, "start-runtime");
  assert.equal(result.receipt.result, "completed");
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.artifactSha256, authorization.artifactSha256);
  assert.equal(evidence.resourceInventory.length, 3);
  assert.ok(evidence.resourceInventory.every((resource) =>
    resource.name === "codeops-session-runtime-video-1"));
  const mutations = stub.calls.filter(({ args }) => args[2] === "create");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, [
    "-n", identity.namespace, "create", "--filename", "-", "--request-timeout=30s",
  ]);
});

test("reopens the exact private runtime apply evidence and canonical receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-apply-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const fifteenthEvidencePath = join(
      root,
      `${identity.namespace}.step-18-start-runtime.evidence.json`,
    );
    const fifteenthStepReceiptPath = join(
      root,
      `${identity.namespace}.step-18-start-runtime.receipt.json`,
    );
    const completedAt = "2026-08-05T22:21:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt: completedAt,
      resources: sessionProofApplyResourceIdentities("start-runtime", authorization)
        .map((resource, index) => ({ ...resource, uid: `resource-uid-${index}` })),
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespaceResource(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`;
    writeFileSync(fifteenthEvidencePath, evidenceSource, { mode: 0o600 });
    writeFileSync(fifteenthStepReceiptPath, receiptSource, { mode: 0o600 });
    const stub = makeRunner();
    const readAuthorization = (received, runnerArgument) => {
      assert.equal(received.packetPath, packetPath);
      assert.equal(runnerArgument, stub.runner);
      return { authorization, uiReadinessOutputs: { marker: "private-chain" } };
    };
    const reopened = readSessionProofRuntimeApplyOutputsFromOperatorPacket({
      packetPath,
      fifteenthEvidencePath,
      fifteenthStepReceiptPath,
    }, stub.runner, readAuthorization);
    assert.equal(reopened.marker, "private-chain");
    assert.deepEqual(reopened.fifteenthAuthorization, authorization);
    assert.equal(reopened.fifteenthEvidenceSource, evidenceSource);
    assert.equal(reopened.fifteenthStepReceiptSource, receiptSource);
    assert.equal(statSync(fifteenthEvidencePath).mode & 0o777, 0o600);
    assert.equal(readFileSync(fifteenthStepReceiptPath, "utf8"), receiptSource);

    chmodSync(fifteenthEvidencePath, 0o640);
    assert.throws(() => readSessionProofRuntimeApplyOutputsFromOperatorPacket({
      packetPath,
      fifteenthEvidencePath,
      fifteenthStepReceiptPath,
    }, stub.runner, readAuthorization), /private regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only runtime readiness from the exact persisted runtime outputs", () => {
  const receiptSources = Array.from({ length: 15 }, (_, index) =>
    `receipt-${index + 1}\n`);
  const outputs = {
    planSource,
    creationReceiptSource: "creation-receipt\n",
    creationReceipt: { namespace: { name: identity.namespace } },
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
  };
  const stub = makeRunner();
  let readCalls = 0;
  let authorizeCalls = 0;
  const result = authorizeSixteenthSessionProofStepFromOperatorPacket({
    packetPath: "/private/operator.packet",
    observedAt: "2026-08-05T22:22:00Z",
  }, stub.runner, (input, runnerArgument) => {
    readCalls += 1;
    assert.equal(input.packetPath, "/private/operator.packet");
    assert.equal(runnerArgument, stub.runner);
    return outputs;
  }, (input) => {
    authorizeCalls += 1;
    assert.equal(input.planSource, planSource);
    assert.equal(input.creationReceiptSource, outputs.creationReceiptSource);
    assert.deepEqual(input.priorReceiptSources, receiptSources);
    assert.deepEqual(input.namespaceResource, namespaceResource());
    assert.deepEqual(input.operator, operator);
    assert.deepEqual(input.target, target);
    assert.equal(input.observedAt, "2026-08-05T22:22:00Z");
    assert.equal(Object.hasOwn(input, "artifactSource"), false);
    return { stepIndex: 17, stepId: "wait-runtime", action: "operator-wait-ready" };
  });
  assert.equal(readCalls, 1);
  assert.equal(authorizeCalls, 1);
  assert.deepEqual(result, {
    stepIndex: 17,
    stepId: "wait-runtime",
    action: "operator-wait-ready",
  });
  assert.equal(stub.calls.some(({ args }) => args.includes("job.batch")), false);
});

test("runtime apply output drift fails before runtime readiness authorization", () => {
  const stub = makeRunner();
  let authorizeCalls = 0;
  assert.throws(() => authorizeSixteenthSessionProofStepFromOperatorPacket({
    observedAt: "2026-08-05T22:22:00Z",
  }, stub.runner, () => {
    throw new Error("proof runtime apply evidence drifted");
  }, () => {
    authorizeCalls += 1;
  }), /runtime apply evidence drifted/);
  assert.equal(authorizeCalls, 0);
  assert.equal(stub.calls.length, 0);
});

test("rejects manifest, action, or timestamp drift before any Kubernetes call", () => {
  for (const overrides of [
    { manifestSource: `${manifestSource}\n` },
    { authorization: { ...authorization, artifact: "ui" } },
    { startedAt: "2026-08-05T22:18:59Z" },
  ]) {
    const stub = makeRunner();
    assert.throws(() => apply(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("refuses any pre-existing runtime resource before mutation", () => {
  const stub = makeRunner({ preexistingKind: "Job" });
  assert.throws(() => apply(stub), /already exist/);
  assert.equal(stub.calls.some(({ args }) => args[2] === "create"), false);
});

test("withholds a receipt after partial create, missing resources, or identity replacement", () => {
  for (const options of [
    { failCreate: true },
    { missingAfterCreate: "ServiceAccount" },
    { replaceNamespaceAfterCreate: true },
    { replaceResourceAfterCreate: true },
  ]) {
    const stub = makeRunner(options);
    assert.throws(() => apply(stub));
    assert.equal(stub.calls.some(({ args }) => args[2] === "create"), true);
  }
});
