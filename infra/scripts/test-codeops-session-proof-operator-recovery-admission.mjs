import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  persistSessionProofRecoveryAdmissionFromOperatorPacket,
  readSessionProofRecoveryAdmissionFromOperatorPacket,
} from "./codeops-session-proof-operator-recovery-admission.mjs";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
} from "./codeops-session-proof-admission.mjs";
import { createHash } from "node:crypto";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const namespace = "codeops-session-proof-video-3";
const certificateData = Buffer.from("test-client-certificate").toString("base64");
const operator = {
  username: "operator@example.com",
  uid: null,
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
};
const target = { context: "production", server: "https://cluster.example.invalid" };

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
    artifacts: ["namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime"]
      .map((id, index) => ({ id, sha256: `${index}`.repeat(64) })),
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
  return {
    creationReceipt: {
      proceed: true,
      namespace: { name: namespace, uid: "namespace-uid-3" },
      admission: bound,
    },
    fifthStepReceiptSource: `${JSON.stringify({
      apiVersion: "codeops.example/session-proof-step-receipt/v1",
      result: "completed",
      proceed: true,
      checkedAt: "2026-08-08T06:00:00.000Z",
      planSha256: bound.planSha256,
      namespace: { name: namespace, uid: "namespace-uid-3" },
      stepIndex: 6,
      stepId: "start-gateway",
      action: "operator-apply",
      artifact: "gateway",
      artifactSha256: "a".repeat(64),
      previousReceiptSha256: "b".repeat(64),
      evidenceSha256: "c".repeat(64),
    }, null, 2)}\n`,
  };
}

function runner(file, args) {
  if (file === "kubectl" && args.includes("config") && args.includes("current-context")) {
    return `${target.context}\n`;
  }
  if (file === "kubectl" && args.some((arg) => arg.startsWith("jsonpath="))) {
    return certificateData;
  }
  if (file === "kubectl" && args.includes("view")) {
    return JSON.stringify({
      clusters: [{ cluster: { server: target.server } }],
      users: [{ name: operator.username, user: {} }],
      contexts: [{ context: { user: operator.username } }],
      "current-context": target.context,
    });
  }
  if (file === "kubectl" && args.includes("auth") && args.includes("whoami")) {
    return JSON.stringify({ status: { userInfo: { username: operator.username, uid: null } } });
  }
  if (file === "kubectl" && args.includes("get") && args.includes("namespace")) {
    return JSON.stringify(namespaceResource());
  }
  throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
}

test("persists one private recovery admission and canonically replays its predecessor chain", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-recovery-admission-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveryAdmissionPath = join(root, `${namespace}.recovery-admission.json`);
    let reads = 0;
    const readOutputs = () => {
      reads += 1;
      return fixtureOutputs();
    };
    const input = {
      packetPath,
      recoveryAdmissionPath,
      approvedAt: "2026-08-08T07:45:00.000Z",
      expiresAt: "2026-08-08T08:45:00.000Z",
    };
    const persisted = persistSessionProofRecoveryAdmissionFromOperatorPacket(
      input,
      runner,
      readOutputs,
    );
    assert.equal(reads, 1);
    assert.equal(statSync(recoveryAdmissionPath).mode & 0o777, 0o600);
    assert.deepEqual(persisted.admission.authorizedSteps[0], "wait-gateway-migration");
    assert.equal(readFileSync(recoveryAdmissionPath, "utf8"), persisted.admissionSource);
    assert.throws(() => persistSessionProofRecoveryAdmissionFromOperatorPacket(
      input,
      runner,
      readOutputs,
    ), /already exists/);

    const reopened = readSessionProofRecoveryAdmissionFromOperatorPacket(
      input,
      runner,
      readOutputs,
    );
    assert.equal(reads, 2);
    assert.deepEqual(reopened, persisted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on path, mode, bytes, or canonical predecessor drift", () => {
  const root = mkdtempSync(join(tmpdir(), "codeops-recovery-admission-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveryAdmissionPath = join(root, `${namespace}.recovery-admission.json`);
    const input = {
      packetPath,
      recoveryAdmissionPath,
      approvedAt: "2026-08-08T07:45:00.000Z",
      expiresAt: "2026-08-08T08:45:00.000Z",
    };
    assert.throws(() => persistSessionProofRecoveryAdmissionFromOperatorPacket({
      ...input,
      recoveryAdmissionPath: join(root, "other.json"),
    }, runner, fixtureOutputs), /derive exactly/);
    persistSessionProofRecoveryAdmissionFromOperatorPacket(input, runner, fixtureOutputs);
    chmodSync(recoveryAdmissionPath, 0o644);
    assert.throws(() => readSessionProofRecoveryAdmissionFromOperatorPacket(
      input,
      runner,
      fixtureOutputs,
    ), /private regular file/);
    chmodSync(recoveryAdmissionPath, 0o600);
    writeFileSync(recoveryAdmissionPath, `${readFileSync(recoveryAdmissionPath, "utf8")} `, { mode: 0o600 });
    assert.throws(() => readSessionProofRecoveryAdmissionFromOperatorPacket(
      input,
      runner,
      fixtureOutputs,
    ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
