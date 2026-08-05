import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProofPlan } from "./codeops-session-proof-plan.mjs";
import { buildSessionProofOperatorItinerary } from "./codeops-session-proof-operator-itinerary.mjs";
import { stringify } from "yaml";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
function resource(kind, name, namespace) {
  return { apiVersion: "v1", kind, metadata: { name, ...(namespace ? { namespace } : {}) } };
}
function manifest(resources) { return resources.map((value) => stringify(value)).join("---\n"); }
function sources() {
  const namespace = resource("Namespace", identity.namespace);
  namespace.metadata.labels = {
    "app.kubernetes.io/part-of": "codeops-session-proof",
    "codeops.renoconcierge.ca/proof-run": identity.runId,
    "codeops.renoconcierge.ca/base-sha": identity.baseSha,
  };
  const targeted = (rows) => manifest(rows.map(([kind, name]) => resource(kind, name)));
  const explicit = (rows) => manifest(rows.map(([kind, name]) => resource(kind, name, identity.namespace)));
  return {
    namespace: manifest([namespace, resource("LimitRange", "codeops-session-proof", identity.namespace), resource("ResourceQuota", "codeops-session-proof", identity.namespace), resource("NetworkPolicy", "default-deny", identity.namespace)]),
    database: targeted([["ServiceAccount", "codeops-session-proof-database"], ["ConfigMap", "codeops-session-proof-database-init"], ["Deployment", "codeops-session-proof-database"], ["Service", "codeops-session-proof-database"], ["NetworkPolicy", "codeops-session-proof-database"]]),
    gateway: targeted([["ServiceAccount", "codeops-control-gateway"], ["Deployment", "codeops-control-gateway"], ["Service", "codeops-control-gateway"], ["NetworkPolicy", "codeops-control-gateway"]]),
    grants: targeted([["ServiceAccount", "codeops-session-proof-grants"], ["ConfigMap", "codeops-session-proof-grants"], ["Job", "codeops-session-proof-grants"], ["NetworkPolicy", "codeops-session-proof-grants"]]),
    "codex-login": explicit([["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"], ["Job", "codeops-codex-auth-login"], ["NetworkPolicy", "codeops-codex-auth"]]),
    "codex-smoke": explicit([["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"], ["Job", "codeops-codex-auth-smoke"], ["NetworkPolicy", "codeops-codex-auth"]]),
    ui: explicit([["ServiceAccount", "codeops-agents-ui"], ["Deployment", "codeops-agents-ui"], ["Service", "codeops-agents-ui"], ["NetworkPolicy", "codeops-agents-ui"]]),
    runtime: targeted([["ServiceAccount", "codeops-session-runtime-video-1"], ["Job", "codeops-session-runtime-video-1"], ["NetworkPolicy", "codeops-session-runtime-video-1"]]),
  };
}
function fixture() {
  const artifactSources = sources();
  const files = Object.fromEntries(Object.entries(artifactSources).map(([id, source]) => [id, { path: `/tmp/${id}.yaml`, source }]));
  const planSource = JSON.stringify(buildSessionProofPlan({ ...identity, files }));
  return { planSource, artifactSources };
}

test("wires every closed proof step and exact byte source without invoking an adapter", () => {
  const result = buildSessionProofOperatorItinerary(fixture());
  assert.equal(result.mode, "closed-rehearsal");
  assert.equal(result.liveAccess, false);
  assert.equal(result.mutation, false);
  assert.equal(result.adapterInvocation, false);
  assert.equal(result.steps.length, 23);
  assert.equal(result.steps.filter((step) => step.adapter !== null).length, 21);
  assert.equal(result.steps.at(-1).emittedByStepId, "delete-namespace");
  assert.deepEqual(
    result.steps.find((step) => step.stepId === "record-proof").inputs.externalArtifacts,
    result.externalInputs.slice(1),
  );
  assert.ok(Object.values(result.artifacts).every((artifact) => artifact.bytes > 1));
  assert.deepEqual(result.finalOutputs, ["receipt:verify-teardown", "evidence:verify-teardown"]);
});

test("binds the revocation, deletion, and final-absence handoff exactly", () => {
  const result = buildSessionProofOperatorItinerary(fixture());
  const deletion = result.steps.find((step) => step.stepId === "delete-namespace");
  const teardown = result.steps.find((step) => step.stepId === "verify-teardown");
  assert.ok(deletion.inputs.priorReceiptSources.includes("receipt:revoke-capabilities"));
  assert.ok(deletion.inputs.priorEvidenceSources.includes("evidence:revoke-capabilities"));
  assert.ok(teardown.inputs.priorReceiptSources.includes("receipt:delete-namespace"));
  assert.ok(teardown.inputs.priorEvidenceSources.includes("evidence:delete-namespace"));
});

test("rejects artifact bytes, artifact sets, and plan sequence drift", () => {
  const changed = fixture();
  changed.artifactSources.ui += "\n";
  assert.throws(() => buildSessionProofOperatorItinerary(changed), /artifact bytes drifted/);
  const missing = fixture();
  delete missing.artifactSources.runtime;
  assert.throws(() => buildSessionProofOperatorItinerary(missing), /source set drifted/);
  const drifted = fixture();
  const plan = JSON.parse(drifted.planSource);
  plan.sequence.reverse();
  drifted.planSource = JSON.stringify(plan);
  assert.throws(() => buildSessionProofOperatorItinerary(drifted), /exact closed sequence/);
});
