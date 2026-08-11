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
  persistSixteenthSessionProofStepAuthorizationFromOperatorPacket,
  readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait-authorization.mjs";
import {
  persistSessionProofRuntimeWaitFromOperatorPacket,
  readSessionProofRuntimeWaitOutputsFromOperatorPacket,
  waitForSessionProofRuntimeFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import { applySessionProofRuntime } from "./codeops-session-proof-runtime-apply.mjs";
import {
  buildSessionProofRuntimeReadinessEvidence,
} from "./codeops-session-proof-runtime-readiness-evidence.mjs";
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
  apiVersion: "codeops.example/session-proof-plan/v1",
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
        "codeops.example/proof-run": identity.runId,
        "codeops.example/base-sha": identity.baseSha,
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
  apiVersion: "codeops.example/session-proof-step-authorization/v1",
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
const runtimeWaitAuthorization = {
  ...authorization,
  stepIndex: 17,
  stepId: "wait-runtime",
  action: "operator-wait-ready",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: "b".repeat(64),
  authorizedAt: "2026-08-05T22:22:00Z",
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

test("persists and reopens the exact private runtime readiness authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-wait-auth-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const sixteenthAuthorizationPath = join(
      root,
      `${identity.namespace}.step-19-wait-runtime.authorization.json`,
    );
    const stub = makeRunner();
    let authorizeCalls = 0;
    const buildAuthorization = (input, runnerArgument) => {
      authorizeCalls += 1;
      assert.equal(input.observedAt, runtimeWaitAuthorization.authorizedAt);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization: runtimeWaitAuthorization,
        runtimeApplyOutputs: { marker: "private-runtime-apply-chain" },
      };
    };
    const result = persistSixteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      sixteenthAuthorizationPath,
      observedAt: runtimeWaitAuthorization.authorizedAt,
    }, stub.runner, (input, runnerArgument) =>
      buildAuthorization(input, runnerArgument).authorization);
    assert.deepEqual(result, runtimeWaitAuthorization);
    assert.equal(statSync(sixteenthAuthorizationPath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(sixteenthAuthorizationPath, "utf8"),
      `${JSON.stringify(runtimeWaitAuthorization, null, 2)}\n`,
    );
    const reopened = readSixteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      sixteenthAuthorizationPath,
    }, stub.runner, buildAuthorization);
    assert.deepEqual(reopened.authorization, runtimeWaitAuthorization);
    assert.equal(reopened.authorizationSource, readFileSync(sixteenthAuthorizationPath, "utf8"));
    assert.equal(reopened.runtimeApplyOutputs.marker, "private-runtime-apply-chain");
    assert.equal(authorizeCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe runtime readiness authorization targets before authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-wait-auth-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const sixteenthAuthorizationPath = join(
      root,
      `${identity.namespace}.step-19-wait-runtime.authorization.json`,
    );
    let authorizeCalls = 0;
    const authorizeStep = () => {
      authorizeCalls += 1;
      return runtimeWaitAuthorization;
    };
    assert.throws(() => persistSixteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      sixteenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: runtimeWaitAuthorization.authorizedAt,
    }, undefined, authorizeStep), /derive exactly/);
    writeFileSync(sixteenthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSixteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      sixteenthAuthorizationPath,
      observedAt: runtimeWaitAuthorization.authorizedAt,
    }, undefined, authorizeStep), /already exists/);
    assert.equal(authorizeCalls, 0);

    chmodSync(sixteenthAuthorizationPath, 0o644);
    assert.throws(() => readSixteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      sixteenthAuthorizationPath,
    }, undefined, authorizeStep), /bounded private regular file/);
    assert.equal(authorizeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted runtime authorization and apply outputs to the waiter", () => {
  const stub = makeRunner();
  const input = {
    packetPath: "/private/operator.packet",
    startedAt: "2026-08-05T22:23:00Z",
    completedAt: "2026-08-05T22:24:00Z",
    maxAttempts: 120,
    pollIntervalMs: 1000,
  };
  const fifteenthEvidenceSource = "runtime-apply-evidence";
  const fifteenthStepReceiptSource = "runtime-apply-receipt\n";
  let authorizationReads = 0;
  let received;
  const result = waitForSessionProofRuntimeFromOperatorPacket(
    input,
    stub.runner,
    (waitInput, runnerArgument) => {
      received = waitInput;
      assert.equal(runnerArgument, stub.runner);
      return { accepted: true };
    },
    (readInput, runnerArgument) => {
      authorizationReads += 1;
      assert.equal(readInput, input);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization: runtimeWaitAuthorization,
        runtimeApplyOutputs: { fifteenthEvidenceSource, fifteenthStepReceiptSource },
      };
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(authorizationReads, 1);
  assert.deepEqual(received, {
    authorization: runtimeWaitAuthorization,
    runtimeApplyReceiptSource: fifteenthStepReceiptSource,
    runtimeApplyEvidenceSource: fifteenthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  });
  assert.equal(stub.calls.length, 0);
});

test("persisted runtime authorization or apply drift fails before the waiter is reached", () => {
  const input = {
    packetPath: "/private/operator.packet",
    startedAt: "2026-08-05T22:23:00Z",
    completedAt: "2026-08-05T22:24:00Z",
    maxAttempts: 120,
    pollIntervalMs: 1000,
  };
  for (const driftTarget of ["authorization", "apply outputs"]) {
    let waiterCalls = 0;
    assert.throws(() => waitForSessionProofRuntimeFromOperatorPacket(
      input,
      undefined,
      () => {
        waiterCalls += 1;
      },
      () => {
        if (driftTarget === "authorization") throw new Error("authorization drifted");
        return {
          authorization: runtimeWaitAuthorization,
          get runtimeApplyOutputs() {
            throw new Error("apply outputs drifted");
          },
        };
      },
    ), /drifted/);
    assert.equal(waiterCalls, 0);
  }
});

function runtimeWaitFixture() {
  const runtimeApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: "2026-08-05T22:21:00Z",
    resources: sessionProofApplyResourceIdentities("start-runtime", authorization)
      .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
  }));
  const runtimeApplyReceipt = completeSessionProofStep(authorization, {
    namespaceResource: namespaceResource(),
    operator,
    target,
    completedAt: "2026-08-05T22:21:00Z",
    evidenceSource: runtimeApplyEvidenceSource,
  });
  const runtimeApplyReceiptSource = `${JSON.stringify(runtimeApplyReceipt, null, 2)}\n`;
  const waitAuthorization = {
    ...runtimeWaitAuthorization,
    previousReceiptSha256: createHash("sha256").update(runtimeApplyReceiptSource).digest("hex"),
  };
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: "codeops-session-runtime-video-1",
      uid: "runtime-resource-uid-0",
      generation: 1,
    },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: 1, startTime: "2026-08-05T22:23:00Z" },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-abcde",
      uid: "runtime-pod-uid",
      labels: { "job-name": "codeops-session-runtime-video-1" },
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "Job",
        uid: "runtime-resource-uid-0",
        controller: true,
      }],
    },
    status: {
      phase: "Running",
      startTime: "2026-08-05T22:23:01Z",
      conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"]
        .map((type) => ({ type, status: "True" })),
      initContainerStatuses: [{
        name: "workspace-builder",
        restartCount: 0,
        state: { terminated: { exitCode: 0 } },
      }],
      containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({
        name,
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: "2026-08-05T22:23:02Z" } },
      })),
    },
  };
  const completedAt = "2026-08-05T22:24:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofRuntimeReadinessEvidence({
    authorization: waitAuthorization,
    runtimeApplyReceiptSource,
    runtimeApplyEvidenceSource,
    job,
    pod,
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(waitAuthorization, {
    namespaceResource: namespaceResource(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  return {
    waitAuthorization,
    runtimeApplyEvidenceSource,
    runtimeApplyReceiptSource,
    evidenceSource,
    receipt,
    completedAt,
  };
}

test("durably persists and reopens exact private runtime readiness outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-wait-"));
  try {
    const fixture = runtimeWaitFixture();
    const packetPath = join(root, `${identity.namespace}.packet`);
    const sixteenthEvidencePath = join(
      root,
      `${identity.namespace}.step-20-wait-runtime.evidence.json`,
    );
    const sixteenthStepReceiptPath = join(
      root,
      `${identity.namespace}.step-20-wait-runtime.receipt.json`,
    );
    const input = {
      packetPath,
      sixteenthEvidencePath,
      sixteenthStepReceiptPath,
      startedAt: "2026-08-05T22:23:00Z",
      completedAt: fixture.completedAt,
      maxAttempts: 120,
      pollIntervalMs: 1000,
    };
    const stub = makeRunner();
    const readAuthorization = (received, runnerArgument) => {
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization: fixture.waitAuthorization,
        runtimeApplyOutputs: {
          fifteenthEvidenceSource: fixture.runtimeApplyEvidenceSource,
          fifteenthStepReceiptSource: fixture.runtimeApplyReceiptSource,
        },
      };
    };
    let waiterCalls = 0;
    const result = persistSessionProofRuntimeWaitFromOperatorPacket(
      input,
      stub.runner,
      (received, runnerArgument) => {
        waiterCalls += 1;
        assert.equal(runnerArgument, stub.runner);
        assert.deepEqual(received.authorization, fixture.waitAuthorization);
        assert.equal(received.runtimeApplyEvidenceSource, fixture.runtimeApplyEvidenceSource);
        assert.equal(received.runtimeApplyReceiptSource, fixture.runtimeApplyReceiptSource);
        assert.equal(statSync(sixteenthEvidencePath).mode & 0o777, 0o600);
        assert.equal(statSync(sixteenthStepReceiptPath).mode & 0o777, 0o600);
        assert.equal(statSync(sixteenthEvidencePath).size, 0);
        assert.equal(statSync(sixteenthStepReceiptPath).size, 0);
        return { evidenceSource: fixture.evidenceSource, receipt: fixture.receipt };
      },
      readAuthorization,
    );
    assert.equal(waiterCalls, 1);
    assert.equal(readFileSync(sixteenthEvidencePath, "utf8"), fixture.evidenceSource);
    assert.equal(readFileSync(sixteenthStepReceiptPath, "utf8"), result.receiptSource);
    const reopened = readSessionProofRuntimeWaitOutputsFromOperatorPacket(
      input,
      stub.runner,
      readAuthorization,
    );
    assert.deepEqual(reopened.sixteenthAuthorization, fixture.waitAuthorization);
    assert.equal(reopened.sixteenthEvidenceSource, fixture.evidenceSource);
    assert.equal(reopened.sixteenthStepReceiptSource, result.receiptSource);
    assert.equal(reopened.fifteenthEvidenceSource, fixture.runtimeApplyEvidenceSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe or occupied runtime readiness output paths before the waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-wait-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const sixteenthEvidencePath = join(
      root,
      `${identity.namespace}.step-20-wait-runtime.evidence.json`,
    );
    const sixteenthStepReceiptPath = join(
      root,
      `${identity.namespace}.step-20-wait-runtime.receipt.json`,
    );
    let waiterCalls = 0;
    const waiter = () => {
      waiterCalls += 1;
    };
    assert.throws(() => persistSessionProofRuntimeWaitFromOperatorPacket({
      packetPath,
      sixteenthEvidencePath: join(root, "substituted.evidence.json"),
      sixteenthStepReceiptPath,
    }, undefined, waiter), /derive exactly/);
    writeFileSync(sixteenthEvidencePath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofRuntimeWaitFromOperatorPacket({
      packetPath,
      sixteenthEvidencePath,
      sixteenthStepReceiptPath,
    }, undefined, waiter), /already exists/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime readiness output permission or canonical receipt drift fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-wait-"));
  try {
    const fixture = runtimeWaitFixture();
    const input = {
      packetPath: join(root, `${identity.namespace}.packet`),
      sixteenthEvidencePath: join(
        root,
        `${identity.namespace}.step-20-wait-runtime.evidence.json`,
      ),
      sixteenthStepReceiptPath: join(
        root,
        `${identity.namespace}.step-20-wait-runtime.receipt.json`,
      ),
    };
    const stub = makeRunner();
    const readAuthorization = () => ({
      authorization: fixture.waitAuthorization,
      runtimeApplyOutputs: {},
    });
    writeFileSync(input.sixteenthEvidencePath, fixture.evidenceSource, { mode: 0o600 });
    writeFileSync(
      input.sixteenthStepReceiptPath,
      `${JSON.stringify(fixture.receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(input.sixteenthEvidencePath, 0o640);
    assert.throws(() => readSessionProofRuntimeWaitOutputsFromOperatorPacket(
      input,
      stub.runner,
      readAuthorization,
    ), /private regular file/);
    chmodSync(input.sixteenthEvidencePath, 0o600);
    writeFileSync(input.sixteenthStepReceiptPath, `${JSON.stringify({
      ...fixture.receipt,
      proceed: false,
    }, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => readSessionProofRuntimeWaitOutputsFromOperatorPacket(
      input,
      stub.runner,
      readAuthorization,
    ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
