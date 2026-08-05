import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofNamespaceManifest } from "./codeops-session-proof-namespace-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/session-proof-namespace-template.yaml", import.meta.url),
  "utf8",
);
const input = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
};
const resources = (source = template, values = input) => parseAllDocuments(
  renderSessionProofNamespaceManifest(source, values),
).map((document) => document.toJS());

test("binds one restricted disposable namespace to the exact run and SHA", () => {
  const values = resources();
  assert.deepEqual(values.map((resource) => resource.kind).sort(), [
    "LimitRange", "Namespace", "NetworkPolicy", "ResourceQuota",
  ]);
  const namespace = values.find((resource) => resource.kind === "Namespace");
  assert.equal(namespace.metadata.name, input.namespace);
  assert.equal(namespace.metadata.labels["codeops.renoconcierge.ca/proof-run"], input.runId);
  assert.equal(namespace.metadata.labels["codeops.renoconcierge.ca/base-sha"], input.baseSha);
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
});

test("caps proof resources without granting Kubernetes authority", () => {
  const values = resources();
  const quota = values.find((resource) => resource.kind === "ResourceQuota");
  assert.equal(quota.spec.hard.pods, "12");
  assert.equal(quota.spec.hard["count/jobs.batch"], "8");
  assert.equal(quota.spec.hard["count/persistentvolumeclaims"], "1");
  assert.equal(quota.spec.hard["limits.memory"], "24Gi");
  assert.equal(JSON.stringify(values).includes("Role"), false);
});

test("default-denies ingress and egress before workload-specific policies", () => {
  const policy = resources().find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.podSelector, {});
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(policy.spec.egress, []);
});

test("rejects identity, resource, network, and authority drift", () => {
  for (const invalid of [
    { ...input, namespace: "codeops-session-proof-other" },
    { ...input, runId: "UPPER" },
    { ...input, baseSha: "abc" },
  ]) assert.throws(() => renderSessionProofNamespaceManifest(template, invalid));
  for (const drifted of [
    template.replace('pods: "12"', 'pods: "20"'),
    template.replace("ingress: []", "ingress: [{}]"),
    template.replace("pod-security.kubernetes.io/enforce: restricted", "pod-security.kubernetes.io/enforce: privileged"),
    `${template}\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata: { name: forbidden }\n`,
  ]) assert.throws(() => renderSessionProofNamespaceManifest(drifted, input));
});
