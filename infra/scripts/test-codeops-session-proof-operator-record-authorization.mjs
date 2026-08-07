import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authorizeSeventeenthSessionProofStepFromOperatorPacket,
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
