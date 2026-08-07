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
  authorizeSeventeenthSessionProofStepFromOperatorPacket,
  persistSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
  readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-record-authorization.mjs";

const operator = {
  username: "kubernetes-admin",
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
  metadata: { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" },
};
const persistedAuthorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256: "1".repeat(64),
  admission: {
    planSha256: "1".repeat(64),
    identity: { namespace: namespaceResource.metadata.name },
    namespaceUid: namespaceResource.metadata.uid,
  },
  namespace: {
    name: namespaceResource.metadata.name,
    uid: namespaceResource.metadata.uid,
  },
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: "2".repeat(64),
  authorizedAt: "2026-08-07T07:42:00Z",
};

function makeRunner() {
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
    if (file === "kubectl" && key.includes("client-certificate-data")) {
      return Buffer.from("synthetic-client-certificate").toString("base64");
    }
    if (file === "kubectl" && key.startsWith("get namespace codeops-session-proof-video-1")) {
      return JSON.stringify(namespaceResource);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

function outputs() {
  const result = {
    planSource: "plan-source",
    creationReceiptSource: "creation-receipt-source",
    creationReceipt: { namespace: { name: namespaceResource.metadata.name } },
  };
  [
    "stepReceiptSource",
    "secondStepReceiptSource",
    "thirdStepReceiptSource",
    "fourthStepReceiptSource",
    "fifthStepReceiptSource",
    "sixthStepReceiptSource",
    "seventhStepReceiptSource",
    "eighthStepReceiptSource",
    "ninthStepReceiptSource",
    "tenthStepReceiptSource",
    "eleventhStepReceiptSource",
    "twelfthStepReceiptSource",
    "thirteenthStepReceiptSource",
    "fourteenthStepReceiptSource",
    "fifteenthStepReceiptSource",
    "sixteenthStepReceiptSource",
  ].forEach((key, index) => {
    result[key] = `receipt-${index + 1}`;
  });
  result.sixteenthEvidenceSource = "runtime-readiness-evidence";
  return result;
}

test("authorizes record-proof from the exact runtime readiness predecessor chain", () => {
  const stub = makeRunner();
  const input = { packetPath: "/proof/video.packet", observedAt: "2026-08-07T07:20:00Z" };
  const predecessorOutputs = outputs();
  let authorizerCalls = 0;
  const authorization = authorizeSeventeenthSessionProofStepFromOperatorPacket(
    input,
    stub.runner,
    (received, runnerArgument) => {
      assert.equal(received, input);
      assert.equal(runnerArgument, stub.runner);
      return predecessorOutputs;
    },
    (received) => {
      authorizerCalls += 1;
      assert.equal(received.planSource, predecessorOutputs.planSource);
      assert.equal(received.creationReceiptSource, predecessorOutputs.creationReceiptSource);
      assert.deepEqual(received.priorReceiptSources, Array.from(
        { length: 16 },
        (_, index) => `receipt-${index + 1}`,
      ));
      assert.deepEqual(received.namespaceResource, namespaceResource);
      assert.deepEqual(received.operator, operator);
      assert.deepEqual(received.target, target);
      assert.equal(received.observedAt, input.observedAt);
      assert.equal("artifactSource" in received, false);
      return { stepId: "record-proof", action: "operator-record-and-export-evidence" };
    },
  );
  assert.equal(authorizerCalls, 1);
  assert.deepEqual(authorization, {
    stepId: "record-proof",
    action: "operator-record-and-export-evidence",
  });
  assert.equal(stub.calls.some(({ args }) => (
    args.includes("create") || args.includes("apply") || args.includes("delete")
  )), false);
});

test("runtime readiness readback failure stops before live identity or authorization", () => {
  const stub = makeRunner();
  let authorizerCalls = 0;
  assert.throws(() => authorizeSeventeenthSessionProofStepFromOperatorPacket(
    { packetPath: "/proof/video.packet", observedAt: "2026-08-07T07:20:00Z" },
    stub.runner,
    () => {
      throw new Error("runtime readiness drifted");
    },
    () => {
      authorizerCalls += 1;
    },
  ), /runtime readiness drifted/);
  assert.equal(authorizerCalls, 0);
  assert.equal(stub.calls.length, 0);
});

test("durably persists and canonically reopens private record-proof authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-auth-"));
  try {
    const packetPath = join(root, `${namespaceResource.metadata.name}.packet`);
    const seventeenthAuthorizationPath = join(
      root,
      `${namespaceResource.metadata.name}.step-21-record-proof.authorization.json`,
    );
    const input = { packetPath, seventeenthAuthorizationPath };
    const stub = makeRunner();
    let authorizerCalls = 0;
    const persisted = persistSeventeenthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      stub.runner,
      (received, runnerArgument) => {
        authorizerCalls += 1;
        assert.equal(received, input);
        assert.equal(runnerArgument, stub.runner);
        return persistedAuthorization;
      },
    );
    assert.equal(authorizerCalls, 1);
    assert.deepEqual(persisted, persistedAuthorization);
    assert.equal(statSync(seventeenthAuthorizationPath).mode & 0o777, 0o600);
    const expectedSource = `${JSON.stringify(persistedAuthorization, null, 2)}\n`;
    assert.equal(readFileSync(seventeenthAuthorizationPath, "utf8"), expectedSource);

    const predecessorOutputs = outputs();
    let builderCalls = 0;
    const reopened = readSeventeenthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      stub.runner,
      (received, runnerArgument) => {
        builderCalls += 1;
        assert.equal(received.observedAt, persistedAuthorization.authorizedAt);
        assert.equal(runnerArgument, stub.runner);
        return {
          authorization: persistedAuthorization,
          runtimeWaitOutputs: predecessorOutputs,
        };
      },
    );
    assert.equal(builderCalls, 1);
    assert.deepEqual(reopened.authorization, persistedAuthorization);
    assert.equal(reopened.authorizationSource, expectedSource);
    assert.equal(
      reopened.runtimeWaitOutputs.sixteenthEvidenceSource,
      predecessorOutputs.sixteenthEvidenceSource,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe or occupied record-proof authorization paths before authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-auth-"));
  try {
    const packetPath = join(root, `${namespaceResource.metadata.name}.packet`);
    const seventeenthAuthorizationPath = join(
      root,
      `${namespaceResource.metadata.name}.step-21-record-proof.authorization.json`,
    );
    let authorizerCalls = 0;
    const authorizer = () => {
      authorizerCalls += 1;
      return persistedAuthorization;
    };
    assert.throws(() => persistSeventeenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      seventeenthAuthorizationPath: join(root, "substituted.authorization.json"),
    }, undefined, authorizer), /derive exactly/);
    writeFileSync(seventeenthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSeventeenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath,
      seventeenthAuthorizationPath,
    }, undefined, authorizer), /already exists/);
    assert.equal(authorizerCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record-proof authorization permission or canonical byte drift fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-record-auth-"));
  try {
    const input = {
      packetPath: join(root, `${namespaceResource.metadata.name}.packet`),
      seventeenthAuthorizationPath: join(
        root,
        `${namespaceResource.metadata.name}.step-21-record-proof.authorization.json`,
      ),
    };
    const stub = makeRunner();
    writeFileSync(
      input.seventeenthAuthorizationPath,
      `${JSON.stringify(persistedAuthorization, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(input.seventeenthAuthorizationPath, 0o640);
    assert.throws(() => readSeventeenthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      stub.runner,
      () => {
        throw new Error("builder must not be reached");
      },
    ), /bounded private regular file/);
    chmodSync(input.seventeenthAuthorizationPath, 0o600);
    writeFileSync(
      input.seventeenthAuthorizationPath,
      `${JSON.stringify({
        ...persistedAuthorization,
        authorizedAt: "2026-08-07T07:42:01Z",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    assert.throws(() => readSeventeenthSessionProofStepAuthorizationFromOperatorPacket(
      input,
      stub.runner,
      () => ({ authorization: persistedAuthorization, runtimeWaitOutputs: outputs() }),
    ), /exact persisted artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
