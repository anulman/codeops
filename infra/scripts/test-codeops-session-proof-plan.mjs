import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { buildSessionProofPlan } from "./codeops-session-proof-plan.mjs";

const input = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};

function resource(kind, name, namespace) {
  return {
    apiVersion: "v1",
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}) },
  };
}
function manifest(resources) {
  return resources.map((value) => stringify(value)).join("---\n");
}
function files() {
  const ns = resource("Namespace", input.namespace);
  ns.metadata.labels = {
    "app.kubernetes.io/part-of": "codeops-session-proof",
    "codeops.renoconcierge.ca/proof-run": input.runId,
    "codeops.renoconcierge.ca/base-sha": input.baseSha,
  };
  const targeted = (values) => manifest(values.map(([kind, name]) => resource(kind, name)));
  const explicit = (values) => manifest(values.map(([kind, name]) => resource(kind, name, input.namespace)));
  return {
    namespace: { path: "/tmp/namespace.yaml", source: manifest([
      ns,
      resource("LimitRange", "codeops-session-proof", input.namespace),
      resource("ResourceQuota", "codeops-session-proof", input.namespace),
      resource("NetworkPolicy", "default-deny", input.namespace),
    ]) },
    database: { path: "/tmp/database.yaml", source: targeted([
      ["ServiceAccount", "codeops-session-proof-database"],
      ["ConfigMap", "codeops-session-proof-database-init"],
      ["Deployment", "codeops-session-proof-database"],
      ["Service", "codeops-session-proof-database"],
      ["NetworkPolicy", "codeops-session-proof-database"],
    ]) },
    gateway: { path: "/tmp/gateway.yaml", source: targeted([
      ["ServiceAccount", "codeops-control-gateway"], ["Deployment", "codeops-control-gateway"],
      ["Service", "codeops-control-gateway"], ["NetworkPolicy", "codeops-control-gateway"],
    ]) },
    grants: { path: "/tmp/grants.yaml", source: targeted([
      ["ServiceAccount", "codeops-session-proof-grants"], ["ConfigMap", "codeops-session-proof-grants"],
      ["Job", "codeops-session-proof-grants"], ["NetworkPolicy", "codeops-session-proof-grants"],
    ]) },
    "codex-login": { path: "/tmp/login.yaml", source: explicit([
      ["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"],
      ["Job", "codeops-codex-auth-login"], ["NetworkPolicy", "codeops-codex-auth"],
    ]) },
    "codex-smoke": { path: "/tmp/smoke.yaml", source: explicit([
      ["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"],
      ["Job", "codeops-codex-auth-smoke"], ["NetworkPolicy", "codeops-codex-auth"],
    ]) },
    ui: { path: "/tmp/ui.yaml", source: explicit([
      ["ServiceAccount", "codeops-agents-ui"], ["Deployment", "codeops-agents-ui"],
      ["Service", "codeops-agents-ui"], ["NetworkPolicy", "codeops-agents-ui"],
    ]) },
    runtime: { path: "/tmp/runtime.yaml", source: targeted([
      ["ServiceAccount", "codeops-session-runtime-video-1"],
      ["Job", "codeops-session-runtime-video-1"],
      ["NetworkPolicy", "codeops-session-runtime-video-1"],
    ]) },
  };
}

test("binds every exact artifact into one closed-admission plan", () => {
  const plan = buildSessionProofPlan({ ...input, files: files() });
  assert.equal(plan.admission, "closed");
  assert.equal(plan.execution, "render-and-review-only");
  assert.equal(plan.artifacts.length, 8);
  assert.ok(
    plan.artifacts.every(
      (artifact) => artifact.targetNamespace === input.namespace,
    ),
  );
  assert.ok(plan.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)));
});

test("orders readiness, auth, runtime, evidence, revocation, and namespace deletion", () => {
  const sequence = buildSessionProofPlan({ ...input, files: files() }).sequence;
  const ids = sequence.map((step) => step.id);
  assert.ok(ids.indexOf("wait-grants") < ids.indexOf("codex-login"));
  assert.ok(ids.indexOf("wait-codex-smoke") < ids.indexOf("start-runtime"));
  assert.ok(ids.indexOf("record-proof") < ids.indexOf("stop-runtime"));
  assert.deepEqual(ids.slice(-3), ["revoke-capabilities", "delete-namespace", "verify-teardown"]);
});

test("rejects missing, extra, wrong-namespace, secret, and identity drift", () => {
  const missing = files();
  delete missing.ui;
  assert.throws(() => buildSessionProofPlan({ ...input, files: missing }));
  const extra = { ...files(), extra: { path: "/tmp/x", source: "" } };
  assert.throws(() => buildSessionProofPlan({ ...input, files: extra }));
  const wrongNamespace = files();
  wrongNamespace.ui.source = wrongNamespace.ui.source.replaceAll(input.namespace, "other");
  assert.throws(() => buildSessionProofPlan({ ...input, files: wrongNamespace }));
  const secret = files();
  secret.runtime.source = secret.runtime.source.replace("kind: ServiceAccount", "kind: Secret");
  assert.throws(() => buildSessionProofPlan({ ...input, files: secret }));
  assert.throws(() => buildSessionProofPlan({ ...input, namespace: "other", files: files() }));
});
