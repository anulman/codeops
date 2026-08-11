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
  authorizeSessionProofRecoveryContinuationFromOperatorPacket,
  persistSessionProofRecoveryContinuationFromOperatorPacket,
  readSessionProofRecoveryContinuationFromOperatorPacket,
} from "./codeops-session-proof-operator-recovery-continuation.mjs";
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
  const sixthStepReceiptSource = `${JSON.stringify({
    apiVersion: "codeops.example/session-proof-step-receipt/v1",
    result: "completed",
    proceed: true,
    checkedAt: "2026-08-08T10:15:00.000Z",
    planSha256: bound.planSha256,
    namespace: { name: namespace, uid: bound.namespaceUid },
    stepIndex: 7,
    stepId: "wait-gateway-migration",
    action: "operator-wait-ready",
    artifact: null,
    artifactSha256: null,
    previousReceiptSha256: "b".repeat(64),
    evidenceSha256: "c".repeat(64),
  }, null, 2)}\n`;
  return {
    creationReceipt: {
      proceed: true,
      namespace: { name: namespace, uid: bound.namespaceUid },
      admission: bound,
    },
    sixthStepReceiptSource,
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

test("continues only from the exact completed recovered gateway wait", () => {
  const outputs = fixtureOutputs();
  const stub = makeRunner();
  let reads = 0;
  const result = authorizeSessionProofRecoveryContinuationFromOperatorPacket({
    packetPath: "/proof/video.packet",
    approvedAt: "2026-08-08T11:45:00.000Z",
    expiresAt: "2026-08-08T12:45:00.000Z",
  }, stub.runner, (input, runner) => {
    reads += 1;
    assert.equal(input.packetPath, "/proof/video.packet");
    assert.equal(runner, stub.runner);
    return outputs;
  });

  assert.equal(reads, 1);
  assert.equal(result.admission.state, "approved-bound");
  assert.equal(result.admission.namespaceUid, "namespace-uid-3");
  assert.equal(result.admission.recovery.predecessorStepId, "wait-gateway-migration");
  assert.equal(
    result.admission.recovery.predecessorReceiptSha256,
    createHash("sha256").update(outputs.sixthStepReceiptSource).digest("hex"),
  );
  assert.equal(result.admission.authorizedSteps[0], "grant-receipts");
  assert.equal(result.admissionSource, `${JSON.stringify(result.admission, null, 2)}\n`);
  assert.equal(stub.calls.length, 5);
  assert.equal(stub.calls.some(({ args }) => (
    args.includes("create") || args.includes("apply") || args.includes("delete")
  )), false);
});

test("rejects a continuation that does not begin at receipt grants", () => {
  const outputs = fixtureOutputs();
  const stub = makeRunner();
  assert.throws(() => authorizeSessionProofRecoveryContinuationFromOperatorPacket({
    approvedAt: "2026-08-08T11:45:00.000Z",
    expiresAt: "2026-08-08T12:45:00.000Z",
  }, stub.runner, () => outputs, () => ({
    ...outputs.creationReceipt.admission,
    authorizedSteps: ["wait-gateway-migration"],
  })), /did not begin at receipt grants/);
});

test("persists one private recovery continuation and canonically replays step 7", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-recovery-continuation-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveryContinuationPath = join(
      root,
      `${namespace}.recovery-continuation.json`,
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
      recoveryContinuationPath,
      approvedAt: "2026-08-08T11:45:00.000Z",
      expiresAt: "2026-08-08T12:45:00.000Z",
    };
    const persisted = persistSessionProofRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      readOutputs,
    );
    assert.equal(reads, 1);
    assert.equal(statSync(recoveryContinuationPath).mode & 0o777, 0o600);
    assert.equal(persisted.admission.authorizedSteps[0], "grant-receipts");
    assert.equal(
      readFileSync(recoveryContinuationPath, "utf8"),
      persisted.admissionSource,
    );
    assert.throws(() => persistSessionProofRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      readOutputs,
    ), /already exists/);

    const reopened = readSessionProofRecoveryContinuationFromOperatorPacket(
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

test("fails closed on recovery-continuation path, mode, or byte drift", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-recovery-continuation-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveryContinuationPath = join(
      root,
      `${namespace}.recovery-continuation.json`,
    );
    const outputs = fixtureOutputs();
    const stub = makeRunner();
    const input = {
      packetPath,
      recoveryContinuationPath,
      approvedAt: "2026-08-08T11:45:00.000Z",
      expiresAt: "2026-08-08T12:45:00.000Z",
    };
    assert.throws(() => persistSessionProofRecoveryContinuationFromOperatorPacket({
      ...input,
      recoveryContinuationPath: join(root, "other.json"),
    }, stub.runner, () => outputs), /derive exactly/);
    persistSessionProofRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      () => outputs,
    );
    chmodSync(recoveryContinuationPath, 0o644);
    assert.throws(() => readSessionProofRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      () => outputs,
    ), /private regular file/);
    chmodSync(recoveryContinuationPath, 0o600);
    writeFileSync(
      recoveryContinuationPath,
      `${readFileSync(recoveryContinuationPath, "utf8")} `,
      { mode: 0o600 },
    );
    assert.throws(() => readSessionProofRecoveryContinuationFromOperatorPacket(
      input,
      stub.runner,
      () => outputs,
    ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
