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
  authorizeRecoveredSixthSessionProofStepFromOperatorPacket,
  persistRecoveredSessionProofGatewayMigrationWaitFromOperatorPacket,
  persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket,
  readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
  readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket,
  readRecoveredSixthSessionProofStepAuthorizationFromVerifiedGatewayApplyOutputs,
  waitForRecoveredSessionProofGatewayMigrationFromOperatorPacket,
} from "./codeops-session-proof-operator-recovery-step-authorization.mjs";

const namespace = "codeops-session-proof-video-3";
const operator = {
  username: "operator@example.com",
  uid: null,
  credentialSha256: createHash("sha256")
    .update("synthetic-client-certificate")
    .digest("hex"),
};
const target = {
  context: "proof-context",
  server: "https://cluster.example.invalid",
};
const namespaceResource = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name: namespace, uid: "namespace-uid-3" },
};
const recoveryAdmission = {
  apiVersion: "codeops.example/session-proof-recovery-admission/v1",
  planSha256: "1".repeat(64),
  identity: { namespace },
  namespaceUid: namespaceResource.metadata.uid,
  authorizedSteps: ["wait-gateway-migration"],
};
const recoveryAdmissionSource = `${JSON.stringify(recoveryAdmission, null, 2)}\n`;
const persistedAuthorization = {
  apiVersion: "codeops.example/session-proof-step-authorization/v1",
  planSha256: recoveryAdmission.planSha256,
  admission: recoveryAdmission,
  namespace: { name: namespace, uid: namespaceResource.metadata.uid },
  stepIndex: 7,
  stepId: "wait-gateway-migration",
  action: "operator-wait-ready",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: "2".repeat(64),
  authorizedAt: "2026-08-08T08:30:00Z",
};

function outputs() {
  return {
    planSource: "plan-source",
    creationReceiptSource: "creation-receipt-source",
    creationReceipt: { namespace: { name: namespace } },
    stepReceiptSource: "receipt-1",
    secondStepReceiptSource: "receipt-2",
    thirdStepReceiptSource: "receipt-3",
    fourthStepReceiptSource: "receipt-4",
    fifthStepReceiptSource: "receipt-5",
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
      return Buffer.from("synthetic-client-certificate").toString("base64");
    }
    if (file === "kubectl" && key.startsWith(`get namespace ${namespace}`)) {
      return JSON.stringify(namespaceResource);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

test("authorizes only the recovered gateway wait from canonical private inputs", () => {
  const stub = makeRunner();
  const input = { packetPath: "/proof/video.packet", observedAt: persistedAuthorization.authorizedAt };
  const gatewayApplyOutputs = outputs();
  let recoveryReads = 0;
  let authorizerCalls = 0;
  const authorization = authorizeRecoveredSixthSessionProofStepFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return gatewayApplyOutputs;
    },
    (received, runnerArgument) => {
      recoveryReads += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return { admission: recoveryAdmission, admissionSource: recoveryAdmissionSource };
    },
    (received) => {
      authorizerCalls += 1;
      assert.equal(received.planSource, gatewayApplyOutputs.planSource);
      assert.equal(received.creationReceiptSource, gatewayApplyOutputs.creationReceiptSource);
      assert.deepEqual(received.priorReceiptSources, [
        "receipt-1",
        "receipt-2",
        "receipt-3",
        "receipt-4",
        "receipt-5",
      ]);
      assert.equal(received.recoveryAdmissionSource, recoveryAdmissionSource);
      assert.deepEqual(received.namespaceResource, namespaceResource);
      assert.deepEqual(received.operator, operator);
      assert.deepEqual(received.target, target);
      assert.equal(received.observedAt, input.observedAt);
      return persistedAuthorization;
    },
  );
  assert.equal(recoveryReads, 1);
  assert.equal(authorizerCalls, 1);
  assert.deepEqual(authorization, persistedAuthorization);
  assert.equal(stub.calls.some(({ args }) => (
    args.includes("create") || args.includes("apply") || args.includes("delete")
  )), false);
});

test("persists once at mode 0600 and canonically reopens the recovered authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-recovered-sixth-auth-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveredSixthAuthorizationPath = join(
      root,
      `${namespace}.step-07-wait-gateway-migration.recovery-authorization.json`,
    );
    const input = { packetPath, recoveredSixthAuthorizationPath };
    let authorizeCalls = 0;
    const persisted = persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      undefined,
      () => {
        authorizeCalls += 1;
        return persistedAuthorization;
      },
    );
    assert.equal(authorizeCalls, 1);
    assert.equal(statSync(recoveredSixthAuthorizationPath).mode & 0o777, 0o600);
    const expectedSource = `${JSON.stringify(persistedAuthorization, null, 2)}\n`;
    assert.equal(readFileSync(recoveredSixthAuthorizationPath, "utf8"), expectedSource);
    assert.throws(() => persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      undefined,
      () => {
        authorizeCalls += 1;
        return persistedAuthorization;
      },
    ), /already exists/);
    assert.equal(authorizeCalls, 1);

    const gatewayApplyOutputs = outputs();
    const reopened = readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      undefined,
      (received) => {
        assert.equal(received.observedAt, persistedAuthorization.authorizedAt);
        return {
          authorization: persistedAuthorization,
          gatewayApplyOutputs,
          recoveryAdmission: {
            admission: recoveryAdmission,
            admissionSource: recoveryAdmissionSource,
          },
        };
      },
    );
    assert.equal(reopened.authorizationSource, expectedSource);
    assert.deepEqual(reopened.authorization, persistedAuthorization);
    assert.equal(reopened.gatewayApplyOutputs.fifthStepReceiptSource, "receipt-5");
    assert.equal(reopened.recoveryAdmission.admissionSource, recoveryAdmissionSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reopens the recovered authorization from one verified gateway-apply handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-recovered-sixth-auth-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveredSixthAuthorizationPath = join(
      root,
      `${namespace}.step-07-wait-gateway-migration.recovery-authorization.json`,
    );
    writeFileSync(
      recoveredSixthAuthorizationPath,
      `${JSON.stringify(persistedAuthorization, null, 2)}\n`,
      { mode: 0o600 },
    );
    const gatewayApplyOutputs = outputs();
    let buildCalls = 0;
    let gatewayApplyReads = 0;
    const reopened =
      readRecoveredSixthSessionProofStepAuthorizationFromVerifiedGatewayApplyOutputs(
        { packetPath, recoveredSixthAuthorizationPath },
        undefined,
        gatewayApplyOutputs,
        (received, runnerArgument, readGatewayApplyOutputs) => {
          buildCalls += 1;
          assert.equal(received.observedAt, persistedAuthorization.authorizedAt);
          assert.equal(typeof runnerArgument, "function");
          gatewayApplyReads += 1;
          assert.equal(readGatewayApplyOutputs(received, runnerArgument), gatewayApplyOutputs);
          return {
            authorization: persistedAuthorization,
            gatewayApplyOutputs,
            recoveryAdmission: {
              admission: recoveryAdmission,
              admissionSource: recoveryAdmissionSource,
            },
          };
        },
      );
    assert.equal(buildCalls, 1);
    assert.equal(gatewayApplyReads, 1);
    assert.equal(reopened.gatewayApplyOutputs, gatewayApplyOutputs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact recovered authorization and gateway apply outputs to the waiter", () => {
  const input = {
    packetPath: "/proof/video.packet",
    startedAt: "2026-08-08T08:31:00Z",
    completedAt: "2026-08-08T08:32:00Z",
    maxAttempts: 12,
    pollIntervalMs: 1000,
  };
  const gatewayApplyOutputs = {
    ...outputs(),
    fifthEvidenceSource: "gateway-apply-evidence-source",
  };
  const stub = makeRunner();
  let readCalls = 0;
  let waiterCalls = 0;
  const result = waitForRecoveredSessionProofGatewayMigrationFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      waiterCalls += 1;
      assert.equal(runnerArgument, stub.runner);
      assert.deepEqual(received, {
        authorization: persistedAuthorization,
        gatewayApplyReceiptSource: gatewayApplyOutputs.fifthStepReceiptSource,
        gatewayApplyEvidenceSource: gatewayApplyOutputs.fifthEvidenceSource,
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
        authorization: persistedAuthorization,
        authorizationSource: `${JSON.stringify(persistedAuthorization, null, 2)}\n`,
        gatewayApplyOutputs,
        recoveryAdmission: {
          admission: recoveryAdmission,
          admissionSource: recoveryAdmissionSource,
        },
      };
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(readCalls, 1);
  assert.equal(waiterCalls, 1);
  assert.equal(stub.calls.length, 0);
});

test("routes recovered gateway wait persistence and canonical readback through recovered authorization", () => {
  const input = { packetPath: "/proof/video.packet" };
  const stub = makeRunner();
  const waiter = () => ({ accepted: true });
  let persistCalls = 0;
  const persisted = persistRecoveredSessionProofGatewayMigrationWaitFromOperatorPacket(
    input,
    stub.runner,
    waiter,
    (received, runnerArgument, waiterArgument, waitFromOperatorPacket) => {
      persistCalls += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      assert.equal(waiterArgument, waiter);
      assert.equal(
        waitFromOperatorPacket,
        waitForRecoveredSessionProofGatewayMigrationFromOperatorPacket,
      );
      return { persisted: true };
    },
  );
  assert.deepEqual(persisted, { persisted: true });
  assert.equal(persistCalls, 1);

  let readCalls = 0;
  const reopened = readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument, readAuthorization) => {
      readCalls += 1;
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      assert.equal(
        readAuthorization,
        readRecoveredSixthSessionProofStepAuthorizationFromVerifiedGatewayApplyOutputs,
      );
      return { reopened: true };
    },
  );
  assert.deepEqual(reopened, { reopened: true });
  assert.equal(readCalls, 1);
  assert.equal(stub.calls.length, 0);
});

test("rejects unsafe, occupied, permissive, or byte-drifted authorization artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-recovered-sixth-auth-"));
  try {
    const packetPath = join(root, `${namespace}.packet`);
    const recoveredSixthAuthorizationPath = join(
      root,
      `${namespace}.step-07-wait-gateway-migration.recovery-authorization.json`,
    );
    let authorizeCalls = 0;
    const authorizer = () => {
      authorizeCalls += 1;
      return persistedAuthorization;
    };
    assert.throws(() => persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      recoveredSixthAuthorizationPath: join(root, "substituted.authorization.json"),
    }, undefined, authorizer), /derive exactly/);
    writeFileSync(recoveredSixthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      recoveredSixthAuthorizationPath,
    }, undefined, authorizer), /already exists/);
    assert.equal(authorizeCalls, 0);

    writeFileSync(
      recoveredSixthAuthorizationPath,
      `${JSON.stringify(persistedAuthorization, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(recoveredSixthAuthorizationPath, 0o640);
    assert.throws(() => readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
      { packetPath, recoveredSixthAuthorizationPath },
      undefined,
      () => {
        throw new Error("builder must not be reached");
      },
    ), /bounded private regular file/);
    chmodSync(recoveredSixthAuthorizationPath, 0o600);
    writeFileSync(
      recoveredSixthAuthorizationPath,
      `${JSON.stringify({
        ...persistedAuthorization,
        authorizedAt: "2026-08-08T08:30:01Z",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    assert.throws(() => readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
      { packetPath, recoveredSixthAuthorizationPath },
      undefined,
      () => ({
        authorization: persistedAuthorization,
        gatewayApplyOutputs: outputs(),
        recoveryAdmission: {
          admission: recoveryAdmission,
          admissionSource: recoveryAdmissionSource,
        },
      }),
    ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
