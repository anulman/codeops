import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofGatewayManifest } from "./codeops-session-proof-gateway-render.mjs";

const template = await readFile(new URL("../k8s/codeops/trial0/session-proof-gateway-template.yaml", import.meta.url), "utf8");
const digest = `sha256:${"a".repeat(64)}`;

function resources(source = template) {
  return parseAllDocuments(renderSessionProofGatewayManifest(source, digest)).map((document) => document.toJS());
}

test("packages only the standalone session control gateway", () => {
  const values = resources();
  const deployment = values.find((resource) => resource.kind === "Deployment");
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.containers[0].image.endsWith(`@${digest}`), true);
  assert.equal(values.some((resource) => resource.kind === "Role" || resource.kind === "RoleBinding"), false);
});

test("mounts five distinct proof-only authorities", () => {
  const pod = resources().find((resource) => resource.kind === "Deployment").spec.template.spec;
  const secrets = pod.volumes.filter((volume) => volume.secret).map((volume) => volume.secret.secretName);
  assert.equal(secrets.length, 5);
  assert.equal(new Set(secrets).size, 5);
  assert.equal(JSON.stringify(pod).includes("repository-read-token"), false);
  assert.equal(JSON.stringify(pod).includes("kubeconfig"), false);
});

test("admits only the UI and runtime worker and reaches only proof database plus DNS", () => {
  const policy = resources().find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress[0].from.map((source) => source.podSelector.matchLabels["app.kubernetes.io/name"]), ["codeops-agents-ui", "codeops-session-runtime-worker"]);
  assert.deepEqual(policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b)), [53, 53, 5432]);
  assert.equal(JSON.stringify(policy).includes("0.0.0.0/0"), false);
});

test("rejects mutable images and authority or exposure drift", () => {
  for (const invalid of ["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => renderSessionProofGatewayManifest(template, invalid));
  }
  for (const drifted of [
    template.replace("automountServiceAccountToken: false", "automountServiceAccountToken: true"),
    template.replace("secretName: codeops-session-broker-write-auth", "secretName: codeops-session-broker-read-auth"),
    template.replace("app.kubernetes.io/name: codeops-session-proof-database", "app.kubernetes.io/name: codeops-control-gateway"),
    `${template}\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata: { name: broader }\n`,
  ]) assert.throws(() => renderSessionProofGatewayManifest(drifted, digest));
});
