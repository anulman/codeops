import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { sessionProofApplyResourceIdentities } from "./codeops-session-proof-apply-evidence.mjs";
import { applySessionProofGrants } from "./codeops-session-proof-grant-apply.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "1".repeat(40),
  sessionSuffix: "video-1",
};
const manifestSource = "reviewed grants manifest\n";
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
    sha256: createHash("sha256").update(id === "grants" ? manifestSource : `${id}\n`).digest("hex"),
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
  approvedAt: "2026-08-05T18:00:00Z",
  expiresAt: "2026-08-05T21:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T18:01:00Z",
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  stepIndex: 8,
  stepId: "grant-receipts",
  action: "operator-apply",
  artifact: "grants",
  artifactSha256: artifacts.find((value) => value.id === "grants").sha256,
  previousReceiptSha256: "a".repeat(64),
  authorizedAt: "2026-08-05T18:13:00Z",
};

const typeByIdentity = new Map([
  ["batch/v1/Job", "job.batch"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/ConfigMap", "configmap"],
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
      const expected = sessionProofApplyResourceIdentities("grant-receipts").find((resource) =>
        typeByIdentity.get(`${resource.apiVersion}/${resource.kind}`) === args[3] && resource.name === args[4]);
      assert.ok(expected);
      if (!created && options.preexistingKind !== expected.kind) return "";
      if (created) postCreateInventoryReads += 1;
      if (created && options.missingAfterCreate === expected.kind) return "";
      const round = Math.floor((postCreateInventoryReads - 1) / 4);
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
  return applySessionProofGrants({
    authorization,
    manifestSource,
    startedAt: "2026-08-05T18:14:00Z",
    completedAt: "2026-08-05T18:15:00Z",
    ...overrides,
  }, stub.runner);
}

test("creates only the reviewed grant package and receipts four stable server UIDs", () => {
  const stub = makeRunner();
  const result = apply(stub);
  assert.equal(result.receipt.stepId, "grant-receipts");
  assert.equal(result.receipt.result, "completed");
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.artifactSha256, authorization.artifactSha256);
  assert.equal(evidence.resourceInventory.length, 4);
  const mutations = stub.calls.filter(({ args }) => args[2] === "create");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, [
    "-n", identity.namespace, "create", "--filename", "-", "--request-timeout=30s",
  ]);
});

test("rejects manifest, action, or timestamp drift before any Kubernetes call", () => {
  for (const overrides of [
    { manifestSource: `${manifestSource}\n` },
    { authorization: { ...authorization, artifact: "gateway" } },
    { startedAt: "2026-08-05T18:12:59Z" },
  ]) {
    const stub = makeRunner();
    assert.throws(() => apply(stub, overrides));
    assert.equal(stub.calls.length, 0);
  }
});

test("refuses any pre-existing grant resource before mutation", () => {
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
