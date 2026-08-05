import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { issueSessionProofCredentials } from "./codeops-session-proof-credential-issuer.mjs";
import { buildSessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import { authorizeSessionProofStep, completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

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
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({ id, sha256: createHash("sha256").update(`${id}\n`).digest("hex") }));
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts,
  sequence: sessionProofSequence(),
});
const planSha256 = createHash("sha256").update(planSource).digest("hex");
const namespaceResource = (uid = "namespace-uid-1") => ({
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
});
const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: planSha256,
  operator,
  target,
  approvedAt: "2026-08-05T18:00:00Z",
  expiresAt: "2026-08-05T20:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T18:01:00Z",
});
const creationReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-create/v1",
  result: "created-and-uid-bound",
  checkedAt: "2026-08-05T18:01:00Z",
  planSha256,
  namespaceManifestSha256: artifacts.find((value) => value.id === "namespace").sha256,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  proceed: true,
  admission,
});

function authorize(priorReceiptSources = []) {
  return authorizeSessionProofStep({
    planSource,
    creationReceiptSource,
    priorReceiptSources,
    namespaceResource: namespaceResource(),
    operator,
    target,
    observedAt: "2026-08-05T18:02:00Z",
  });
}

const brokerContracts = {
  "codeops-session-proof-database-owner": ["database", "password", "username"],
  "codeops-session-broker-database": ["database-url"],
  "codeops-session-broker-read-auth": ["token"],
  "codeops-session-broker-write-auth": ["token"],
  "codeops-session-runtime-worker-auth": ["token"],
  "codeops-session-job-initialization-auth": ["token"],
  "codeops-session-runtime-worker-database": ["database-url", "password"],
};
const runtimeContracts = {
  "ghcr-renoconcierge": [".dockerconfigjson"],
  "codeops-agent-source-credentials": ["repository-read-token"],
};

function secretMetadata(name, runtime = false) {
  const keys = (runtime ? runtimeContracts : brokerContracts)[name];
  return [
    `secret-uid-${name}`,
    name === "ghcr-renoconcierge" ? "kubernetes.io/dockerconfigjson" : "Opaque",
    "codeops-session-proof",
    runtime ? "session-video-proof-runtime" : "session-video-proof",
    ...keys,
    "",
  ].join("\n");
}

function makeRunner(options = {}) {
  let issued = false;
  let namespaceReadsAfterIssue = 0;
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
      if (issued) namespaceReadsAfterIssue += 1;
      return JSON.stringify(namespaceResource(
        options.replaceNamespaceAfterIssue && namespaceReadsAfterIssue > 0
          ? "replacement-uid"
          : "namespace-uid-1",
      ));
    }
    if (file.endsWith("issue-codeops-session-proof-secrets.sh")) {
      issued = true;
      return "issued\n";
    }
    if (file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")) {
      issued = true;
      return "issued\n";
    }
    if (file === "kubectl" && args[2] === "get" && args[3] === "secret") {
      assert.equal(issued, true);
      assert.match(args[6], /^go-template=/);
      assert.equal(args[6].includes("{{$key}}"), true);
      assert.equal(args[6].includes("{{$value}}"), false);
      return secretMetadata(args[4], options.runtime);
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner };
}

function brokerReceiptSource() {
  const authorization = authorize();
  const evidenceSource = JSON.stringify(buildSessionProofCredentialEvidence({
    authorization,
    observedAt: "2026-08-05T18:03:00Z",
    secrets: Object.keys(brokerContracts).map((name) => {
      const [uid, type, partOf, scope, ...keys] = secretMetadata(name).split("\n");
      return {
        name,
        namespace: identity.namespace,
        uid,
        type,
        dataKeys: keys.filter(Boolean),
        labels: {
          "app.kubernetes.io/part-of": partOf,
          "codeops.renoconcierge.ca/credential-scope": scope,
        },
      };
    }),
  }));
  return JSON.stringify(completeSessionProofStep(authorization, {
    namespaceResource: namespaceResource(),
    operator,
    target,
    completedAt: "2026-08-05T18:03:00Z",
    evidenceSource,
  }));
}

test("issues broker credentials only after live authorization and receipts metadata-only evidence", () => {
  const authorization = authorize();
  const stub = makeRunner();
  const result = issueSessionProofCredentials({
    authorization,
    startedAt: "2026-08-05T18:03:00Z",
    completedAt: "2026-08-05T18:04:00Z",
  }, stub.runner);
  assert.equal(result.receipt.stepId, "issue-broker-capabilities");
  assert.equal(result.receipt.result, "completed");
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.credentialInventory.length, 7);
  assert.equal(JSON.stringify(evidence).includes('"data"'), false);
  const issuerCall = stub.calls.find(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh"));
  assert.deepEqual(issuerCall.args, ["--namespace", identity.namespace]);
});

test("passes only exact input paths to the runtime credential issuer", () => {
  const authorization = authorize([brokerReceiptSource()]);
  const stub = makeRunner({ runtime: true });
  const result = issueSessionProofCredentials({
    authorization,
    registryConfigFile: "/private/registry.json",
    repositoryTokenFile: "/private/repository-token",
    startedAt: "2026-08-05T18:05:00Z",
    completedAt: "2026-08-05T18:06:00Z",
  }, stub.runner);
  assert.equal(result.receipt.stepId, "issue-runtime-capabilities");
  const issuerCall = stub.calls.find(({ file }) =>
    file.endsWith("issue-codeops-session-proof-runtime-credentials.sh"));
  assert.deepEqual(issuerCall.args, [
    "--namespace", identity.namespace,
    "--registry-config-file", "/private/registry.json",
    "--repository-token-file", "/private/repository-token",
  ]);
});

test("rejects relative runtime credential paths before mutation", () => {
  const stub = makeRunner({ runtime: true });
  assert.throws(() => issueSessionProofCredentials({
    authorization: authorize([brokerReceiptSource()]),
    registryConfigFile: "registry.json",
    repositoryTokenFile: "/private/repository-token",
    startedAt: "2026-08-05T18:05:00Z",
    completedAt: "2026-08-05T18:06:00Z",
  }, stub.runner), /bounded absolute/);
  assert.equal(stub.calls.length, 0);
});

test("rejects authorization drift before invoking an issuer", () => {
  const stub = makeRunner();
  assert.throws(() => issueSessionProofCredentials({
    authorization: { ...authorize(), action: "operator-apply" },
    startedAt: "2026-08-05T18:03:00Z",
    completedAt: "2026-08-05T18:04:00Z",
  }, stub.runner), /authorization drifted/);
  assert.equal(stub.calls.length, 0);
});

test("rejects missing or non-monotonic execution timestamps before mutation", () => {
  for (const [startedAt, completedAt] of [
    [undefined, "2026-08-05T18:04:00Z"],
    ["2026-08-05T18:03:00Z", "2026-08-05T18:02:59Z"],
  ]) {
    const stub = makeRunner();
    assert.throws(() => issueSessionProofCredentials({
      authorization: authorize(),
      startedAt,
      completedAt,
    }, stub.runner), /timestamps drifted/);
    assert.equal(stub.calls.length, 0);
  }
});

test("withholds a completion receipt when the Namespace UID changes after issuance", () => {
  const stub = makeRunner({ replaceNamespaceAfterIssue: true });
  assert.throws(() => issueSessionProofCredentials({
    authorization: authorize(),
    startedAt: "2026-08-05T18:03:00Z",
    completedAt: "2026-08-05T18:04:00Z",
  }, stub.runner), /Namespace UID drifted/);
  assert.equal(stub.calls.some(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")), true);
});
