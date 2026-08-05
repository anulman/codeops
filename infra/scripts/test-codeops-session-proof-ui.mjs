import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofUiManifest } from "./codeops-session-proof-ui-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-template.yaml", import.meta.url),
  "utf8",
);
const input = {
  agentsUiDigest: `sha256:${"a".repeat(64)}`,
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
};
const resources = (source = template, overrides = {}) =>
  parseAllDocuments(
    renderSessionProofUiManifest(source, { ...input, ...overrides }),
  ).map((document) => document.toJS());

test("binds the immutable UI to the exact proof namespace and run", () => {
  const values = resources();
  assert.deepEqual(
    values.map((resource) => resource.kind).sort(),
    ["Deployment", "NetworkPolicy", "Service", "ServiceAccount"],
  );
  for (const resource of values) {
    assert.equal(resource.metadata.namespace, input.namespace);
    assert.equal(
      resource.metadata.labels["app.kubernetes.io/part-of"],
      "codeops-session-proof",
    );
    assert.equal(
      resource.metadata.labels["codeops.renoconcierge.ca/proof-run"],
      input.runId,
    );
  }
});

test("mounts only distinct broker read and write capabilities", () => {
  const pod = resources().find((resource) => resource.kind === "Deployment")
    .spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(
    pod.volumes
      .filter((volume) => volume.secret)
      .map((volume) => volume.secret.secretName),
    [
      "codeops-session-broker-read-auth",
      "codeops-session-broker-write-auth",
    ],
  );
  assert.equal(JSON.stringify(pod).includes("codeops-session-broker-database"), false);
});

test("has no cluster ingress and reaches only proof gateway plus DNS", () => {
  const policy = resources().find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(
    policy.spec.egress
      .flatMap((rule) => rule.ports.map((port) => port.port))
      .sort((a, b) => Number(a) - Number(b)),
    [53, 53, 8080],
  );
  assert.equal(
    policy.spec.egress[0].to[0].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-control-gateway",
  );
  assert.equal(resources().some((resource) => resource.kind === "Ingress"), false);
});

test("keeps Access enforcement and a cluster-internal Service", () => {
  const values = resources();
  const deployment = values.find((resource) => resource.kind === "Deployment");
  const service = values.find((resource) => resource.kind === "Service");
  const env = Object.fromEntries(
    deployment.spec.template.spec.containers[0].env.map((entry) => [
      entry.name,
      entry.value,
    ]),
  );
  assert.equal(env.AGENTS_UI_ACCESS_REQUIRED, "true");
  assert.equal(service.spec.type, "ClusterIP");
});

test("rejects namespace, image, credential, and exposure drift", () => {
  for (const overrides of [
    { namespace: "codeops-session-proof-other" },
    { runId: "UPPER" },
    { agentsUiDigest: "latest" },
  ]) {
    assert.throws(() => resources(template, overrides));
  }
  for (const drifted of [
    template.replace(
      "secretName: codeops-session-broker-write-auth",
      "secretName: codeops-session-broker-read-auth",
    ),
    template.replace("type: ClusterIP", "type: LoadBalancer"),
    `${template}\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: { name: broader }\n`,
  ]) {
    assert.throws(() => renderSessionProofUiManifest(drifted, input));
  }
});
