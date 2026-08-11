import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
} from "./codeops-session-proof-admission.mjs";
import {
  authorizeSessionProofGrantRecoveryContinuationFromOperatorPacket,
  persistSessionProofGrantRecoveryContinuationFromOperatorPacket,
  readSessionProofGrantRecoveryContinuationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-recovery-continuation.mjs";
import {
  authorizeEighthSessionProofStepFromOperatorPacket,
  persistEighthSessionProofStepAuthorizationFromOperatorPacket,
  readEighthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait-authorization.mjs";
import {
  waitForSessionProofGrantsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const namespace = "codeops-session-proof-video-3";
const certificate = Buffer.from("synthetic-client-certificate");
const operator = {
  username: "operator@example.com",
  uid: null,
  credentialSha256: createHash("sha256").update(certificate).digest("hex"),
};
const target = {
  context: "proof-context",
  server: "https://cluster.example.invalid",
};

function namespaceResource() {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "namespace-uid-3",
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.example/proof-run": "video-3",
        "codeops.example/base-sha": "a".repeat(40),
      },
    },
  };
}

function fixtureOutputs() {
  const planSource = JSON.stringify({
    apiVersion: "codeops.example/session-proof-plan/v1",
    admission: "closed",
    execution: "render-and-review-only",
    identity: {
      namespace,
      runId: "video-3",
      baseSha: "a".repeat(40),
      sessionSuffix: "video-3",
    },
    artifacts: [
      "namespace", "database", "gateway", "grants",
      "codex-login", "codex-smoke", "ui", "runtime",
    ].map((id, index) => ({ id, sha256: `${index}`.repeat(64) })),
    sequence: sessionProofSequence(),
  });
  const unbound = createSessionProofAdmission({
    planSource,
    reviewedPlanSha256: createHash("sha256").update(planSource).digest("hex"),
    operator,
    target,
    approvedAt: "2026-08-08T02:30:00.000Z",
    expiresAt: "2026-08-08T06:30:00.000Z",
  });
  const bound = bindSessionProofNamespace(unbound, {
    namespaceResource: namespaceResource(),
    operator,
    target,
    observedAt: "2026-08-08T02:31:00.000Z",
  });
  const seventhStepReceiptSource = `${JSON.stringify({
    apiVersion: "codeops.example/session-proof-step-receipt/v1",
    result: "completed",
    proceed: true,
    checkedAt: "2026-08-08T12:58:00.000Z",
    planSha256: bound.planSha256,
    namespace: { name: namespace, uid: bound.namespaceUid },
    stepIndex: 8,
    stepId: "grant-receipts",
    action: "operator-apply",
    artifact: "grants",
    artifactSha256: "d".repeat(64),
    previousReceiptSha256: "b".repeat(64),
    evidenceSha256: "c".repeat(64),
  }, null, 2)}\n`;
  return {
    creationReceipt: {
      proceed: true,
      namespace: { name: namespace, uid: bound.namespaceUid },
      admission: bound,
    },
    seventhStepReceiptSource,
  };
}

function makeRunner() {
  const calls = [];
  const runner = (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    if (file === "kubectl" && key === "config current-context") {
      return `${target.context}\n`;
    }
    if (file === "kubectl" && key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (file === "kubectl" && key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (file === "kubectl" && key.includes("client-certificate-data")) {
      return certificate.toString("base64");
    }
    if (file === "kubectl" && key.startsWith(`get namespace ${namespace}`)) {
      return JSON.stringify(namespaceResource());
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

test("continues only from the exact completed grant apply", () => {
  const outputs = fixtureOutputs();
  const stub = makeRunner();
  let reads = 0;
  const result = authorizeSessionProofGrantRecoveryContinuationFromOperatorPacket({
    packetPath: "/proof/video.packet",
    approvedAt: "2026-08-08T14:50:00.000Z",
    expiresAt: "2026-08-08T15:50:00.000Z",
  }, stub.runner, (input, runner) => {
    reads += 1;
    assert.equal(input.packetPath, "/proof/video.packet");
    assert.equal(typeof runner, "function");
    return outputs;
  });

  assert.equal(reads, 1);
  assert.equal(result.admission.state, "approved-bound");
  assert.equal(result.admission.namespaceUid, "namespace-uid-3");
  assert.equal(result.admission.recovery.predecessorStepId, "grant-receipts");
  assert.equal(
    result.admission.recovery.predecessorReceiptSha256,
    createHash("sha256").update(outputs.seventhStepReceiptSource).digest("hex"),
  );
  assert.equal(result.admission.authorizedSteps[0], "wait-grants");
  assert.equal(result.admissionSource, `${JSON.stringify(result.admission, null, 2)}\n`);
  assert.equal(stub.calls.length, 5);
  assert.equal(stub.calls.some(({ args }) => (
    args.includes("create") || args.includes("apply") || args.includes("delete")
  )), false);
});

test("rejects a continuation that does not begin at grant completion wait", () => {
  const outputs = fixtureOutputs();
  const stub = makeRunner();
  assert.throws(() => authorizeSessionProofGrantRecoveryContinuationFromOperatorPacket({
    approvedAt: "2026-08-08T14:50:00.000Z",
    expiresAt: "2026-08-08T15:50:00.000Z",
  }, stub.runner, () => outputs, () => ({
    ...outputs.creationReceipt.admission,
    authorizedSteps: ["grant-receipts"],
  })), /did not begin at grant completion wait/);
});

test("rejects a grant continuation when Namespace creation is incomplete", () => {
  const outputs = fixtureOutputs();
  outputs.creationReceipt.proceed = false;
  const stub = makeRunner();
  assert.throws(() => authorizeSessionProofGrantRecoveryContinuationFromOperatorPacket({
    approvedAt: "2026-08-08T14:50:00.000Z",
    expiresAt: "2026-08-08T15:50:00.000Z",
  }, stub.runner, () => outputs), /Namespace creation did not complete/);
  assert.equal(stub.calls.length, 0);
});

test("persists one private grant recovery continuation and canonically replays step 8", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-grant-recovery-continuation-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const grantRecoveryContinuationPath = join(
      root,
      `${namespace}.grant-recovery-continuation.json`,
    );
    const outputs = fixtureOutputs();
    const stub = makeRunner();
    let reads = 0;
    const readOutputs = () => {
      reads += 1;
      return outputs;
    };
    const input = {
      packetPath,
      grantRecoveryContinuationPath,
      approvedAt: "2026-08-08T14:50:00.000Z",
      expiresAt: "2026-08-08T15:50:00.000Z",
    };
    const persisted =
      persistSessionProofGrantRecoveryContinuationFromOperatorPacket(
        input,
        stub.runner,
        readOutputs,
      );
    assert.equal(reads, 1);
    assert.equal(statSync(grantRecoveryContinuationPath).mode & 0o777, 0o600);
    assert.equal(persisted.admission.authorizedSteps[0], "wait-grants");
    assert.equal(
      readFileSync(grantRecoveryContinuationPath, "utf8"),
      persisted.admissionSource,
    );
    assert.throws(() =>
      persistSessionProofGrantRecoveryContinuationFromOperatorPacket(
        input,
        stub.runner,
        readOutputs,
      ), /already exists/);
    assert.equal(reads, 1);

    const reopened =
      readSessionProofGrantRecoveryContinuationFromOperatorPacket(
        input,
        stub.runner,
        readOutputs,
      );
    assert.equal(reads, 2);
    assert.deepEqual(reopened, persisted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on grant recovery-continuation path, mode, or byte drift", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-grant-recovery-continuation-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const grantRecoveryContinuationPath = join(
      root,
      `${namespace}.grant-recovery-continuation.json`,
    );
    const outputs = fixtureOutputs();
    const stub = makeRunner();
    const input = {
      packetPath,
      grantRecoveryContinuationPath,
      approvedAt: "2026-08-08T14:50:00.000Z",
      expiresAt: "2026-08-08T15:50:00.000Z",
    };
    assert.throws(() =>
      persistSessionProofGrantRecoveryContinuationFromOperatorPacket({
        ...input,
        grantRecoveryContinuationPath: join(root, "other.json"),
      }, stub.runner, () => outputs), /derive exactly/);
    persistSessionProofGrantRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      () => outputs,
    );
    chmodSync(grantRecoveryContinuationPath, 0o644);
    assert.throws(() =>
      readSessionProofGrantRecoveryContinuationFromOperatorPacket(
        input,
        stub.runner,
        () => outputs,
      ), /private regular file/);
    chmodSync(grantRecoveryContinuationPath, 0o600);
    writeFileSync(
      grantRecoveryContinuationPath,
      `${readFileSync(grantRecoveryContinuationPath, "utf8")} `,
      { mode: 0o600 },
    );
    assert.throws(() =>
      readSessionProofGrantRecoveryContinuationFromOperatorPacket(
        input,
        stub.runner,
        () => outputs,
      ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands the exact persisted grant recovery continuation to step 9", () => {
  const outputs = fixtureOutputs();
  const stub = makeRunner();
  const recoveryContinuation = {
    admissionSource: "exact-grant-recovery-continuation\n",
  };
  const expected = {
    apiVersion: "codeops.example/session-proof-step-authorization/v1",
    namespace: { name: namespace, uid: "namespace-uid-3" },
    stepIndex: 9,
    stepId: "wait-grants",
    admission: {
      apiVersion: "codeops.example/session-proof-recovery-admission/v1",
    },
  };
  let outputReads = 0;
  let continuationReads = 0;
  let authorizationCalls = 0;
  const authorization = authorizeEighthSessionProofStepFromOperatorPacket({
    packetPath: "/proof/video.packet",
    grantRecoveryContinuationPath: "/proof/grant-recovery.json",
    observedAt: "2026-08-08T15:30:00.000Z",
  }, stub.runner, (input, runner) => {
    outputReads += 1;
    assert.equal(input.grantRecoveryContinuationPath, "/proof/grant-recovery.json");
    assert.notEqual(runner, stub.runner);
    return outputs;
  }, (input, runner, readGrantApplyOutputs) => {
    continuationReads += 1;
    assert.equal(input.grantRecoveryContinuationPath, "/proof/grant-recovery.json");
    assert.notEqual(runner, stub.runner);
    assert.equal(readGrantApplyOutputs(), outputs);
    return recoveryContinuation;
  }, (input) => {
    authorizationCalls += 1;
    assert.equal(input.recoveryAdmissionSource, recoveryContinuation.admissionSource);
    assert.equal(input.priorReceiptSources.at(-1), outputs.seventhStepReceiptSource);
    assert.equal(input.observedAt, "2026-08-08T15:30:00.000Z");
    return expected;
  });
  assert.equal(authorization, expected);
  assert.equal(outputReads, 1);
  assert.equal(continuationReads, 1);
  assert.equal(authorizationCalls, 1);
  assert.equal(stub.calls.length, 5);
});

test("persists and canonically reopens only the recovered step-9 authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-grant-recovery-authorization-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const eighthAuthorizationPath = join(
      root,
      `${namespace}.step-09-wait-grants.authorization.json`,
    );
    const grantRecoveryContinuationPath = join(
      root,
      `${namespace}.grant-recovery-continuation.json`,
    );
    const authorization = {
      apiVersion: "codeops.example/session-proof-step-authorization/v1",
      namespace: { name: namespace, uid: "namespace-uid-3" },
      stepIndex: 9,
      stepId: "wait-grants",
      admission: {
        apiVersion: "codeops.example/session-proof-recovery-admission/v1",
      },
      authorizedAt: "2026-08-08T15:30:00.000Z",
    };
    const input = {
      packetPath,
      eighthAuthorizationPath,
      grantRecoveryContinuationPath,
      observedAt: authorization.authorizedAt,
    };
    let authorizationCalls = 0;
    const persisted = persistEighthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      () => {
        throw new Error("live read must be injected");
      },
      () => {
        authorizationCalls += 1;
        return authorization;
      },
    );
    assert.equal(persisted, authorization);
    assert.equal(authorizationCalls, 1);
    assert.equal(statSync(eighthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(eighthAuthorizationPath, "utf8")), authorization);

    let buildCalls = 0;
    const grantApplyOutputs = fixtureOutputs();
    const recoveryContinuation = { admissionSource: "persisted-recovery\n" };
    const reopened = readEighthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      () => {
        throw new Error("live read must be injected");
      },
      (received) => {
        buildCalls += 1;
        assert.equal(received.observedAt, authorization.authorizedAt);
        return { authorization, grantApplyOutputs, recoveryContinuation };
      },
    );
    assert.equal(buildCalls, 1);
    assert.deepEqual(reopened.authorization, authorization);
    assert.equal(reopened.grantApplyOutputs, grantApplyOutputs);
    assert.equal(reopened.recoveryContinuation, recoveryContinuation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted recovered authorization and grant outputs to the waiter", () => {
  const input = {
    packetPath: "/proof/video.packet",
    startedAt: "2026-08-08T15:31:00.000Z",
    completedAt: "2026-08-08T15:32:00.000Z",
    maxAttempts: 12,
    pollIntervalMs: 1000,
  };
  const grantApplyOutputs = {
    ...fixtureOutputs(),
    seventhEvidenceSource: "grant-apply-evidence-source",
  };
  const authorization = {
    apiVersion: "codeops.example/session-proof-step-authorization/v1",
    namespace: { name: namespace, uid: "namespace-uid-3" },
    stepIndex: 9,
    stepId: "wait-grants",
    admission: {
      apiVersion: "codeops.example/session-proof-recovery-admission/v1",
    },
  };
  const stub = makeRunner();
  let readCalls = 0;
  let waiterCalls = 0;
  const result = waitForSessionProofGrantsFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      waiterCalls += 1;
      assert.equal(runnerArgument, stub.runner);
      assert.deepEqual(received, {
        authorization,
        grantApplyReceiptSource: grantApplyOutputs.seventhStepReceiptSource,
        grantApplyEvidenceSource: grantApplyOutputs.seventhEvidenceSource,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        maxAttempts: input.maxAttempts,
        pollIntervalMs: input.pollIntervalMs,
      });
      return { accepted: true };
    },
    (received, runnerArgument) => {
      readCalls += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return {
        authorization,
        authorizationSource: `${JSON.stringify(authorization, null, 2)}\n`,
        grantApplyOutputs,
        recoveryContinuation: { admissionSource: "persisted-recovery\n" },
      };
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(readCalls, 1);
  assert.equal(waiterCalls, 1);
  assert.equal(stub.calls.length, 0);
});
