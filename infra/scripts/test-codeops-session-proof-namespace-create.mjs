import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
const namespaceManifestSource = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: codeops-session-proof-video-1\n";
const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const operator = {
  username: "kubernetes-admin",
  uid: null,
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: artifactIds.map((id, index) => ({
    id,
    sha256: id === "namespace"
      ? createHash("sha256").update(namespaceManifestSource).digest("hex")
      : `${index}`.repeat(64),
  })),
  sequence: sessionProofSequence(),
});
const admission = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: createHash("sha256").update(planSource).digest("hex"),
  operator,
  target,
  approvedAt: "2026-08-05T05:00:00Z",
  expiresAt: "2026-08-05T08:00:00Z",
});

function namespace() {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid: "namespace-uid-1",
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.renoconcierge.ca/proof-run": identity.runId,
        "codeops.renoconcierge.ca/base-sha": identity.baseSha,
      },
    },
  };
}

function runner(initiallyPresent = false, failCreateAfterNamespace = false) {
  let created = initiallyPresent;
  const calls = [];
  const execute = (_file, args, options = {}) => {
    calls.push({ args, options });
    const key = args.join(" ");
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (key.includes("jsonpath={.users[0].user.client-certificate-data}")) return certificateData;
    if (key.startsWith("get namespace ")) return created ? JSON.stringify(namespace()) : "";
    if (key === "create --filename - --request-timeout=30s") {
      assert.equal(options.input, namespaceManifestSource);
      created = true;
      if (failCreateAfterNamespace) throw new Error("synthetic partial create");
      return "created\n";
    }
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  return { calls, execute };
}

test("creates only the reviewed namespace package after live preflight and binds its UID", () => {
  const stub = runner();
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "created-and-uid-bound");
  assert.equal(result.namespace.uid, "namespace-uid-1");
  assert.equal(result.admission.state, "approved-bound");
  assert.equal(result.proceed, true);
  const mutations = stub.calls.filter(({ args }) => args[0] === "create");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, ["create", "--filename", "-", "--request-timeout=30s"]);
});

test("returns a UID-bound non-proceed receipt after partial package creation", () => {
  const stub = runner(false, true);
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "namespace-uid-bound-create-incomplete");
  assert.equal(result.proceed, false);
  assert.equal(result.admission.namespaceUid, "namespace-uid-1");
});

test("rejects manifest drift or an existing namespace before create", () => {
  const drift = runner();
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource: `${namespaceManifestSource}\n`,
    observedAt: "2026-08-05T06:00:00Z",
  }, drift.execute));
  assert.equal(drift.calls.length, 0);
  const existing = runner(true);
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, existing.execute));
  assert.equal(existing.calls.some(({ args }) => args[0] === "create"), false);
});
