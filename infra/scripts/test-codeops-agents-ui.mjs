import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderAgentsUiManifest } from "./codeops-agents-ui-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-template.yaml", import.meta.url),
  "utf8",
);
const digest = `sha256:${"a".repeat(64)}`;

function resources(source = template) {
  return parseAllDocuments(renderAgentsUiManifest(source, digest)).map(
    (document) => document.toJS(),
  );
}

test("packages one immutable tokenless internal UI", () => {
  const values = resources();
  const deployment = values.find((resource) => resource.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(pod.serviceAccountName, "codeops-agents-ui");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(
    pod.containers[0].image,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-agents-ui@${digest}`,
  );
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
});

test("mounts only distinct session read and write capabilities", () => {
  const pod = resources().find((resource) => resource.kind === "Deployment")
    .spec.template.spec;
  assert.equal(pod.volumes.length, 3);
  const read = pod.volumes.find((volume) => volume.name === "session-broker-read-auth");
  const write = pod.volumes.find((volume) => volume.name === "session-broker-write-auth");
  assert.equal(read.secret.secretName, "codeops-session-broker-read-auth");
  assert.equal(write.secret.secretName, "codeops-session-broker-write-auth");
  assert.notEqual(read.secret.secretName, write.secret.secretName);
  assert.deepEqual(read.secret.items, [{ key: "token", path: "token" }]);
  assert.deepEqual(write.secret.items, [{ key: "token", path: "token" }]);
  assert.equal(JSON.stringify(pod).includes("codeops-agent-dispatch-auth"), false);
  assert.equal(JSON.stringify(pod).includes("codeops-session-broker-database"), false);
});

test("stays cluster-internal until the Access-owned ingress is added", () => {
  const values = resources();
  const service = values.find((resource) => resource.kind === "Service");
  assert.equal(service.spec.type, "ClusterIP");
  assert.deepEqual(service.spec.selector, {
    "app.kubernetes.io/name": "codeops-agents-ui",
  });
  assert.deepEqual(service.spec.ports, [
    { name: "http", protocol: "TCP", port: 3000, targetPort: "http" },
  ]);
  assert.equal(values.some((resource) => resource.kind === "Ingress"), false);
  assert.equal(
    values.find((resource) => resource.kind === "ServiceAccount")
      .automountServiceAccountToken,
    false,
  );
});

test("admits only ingress-nginx and reaches only the gateway and DNS", () => {
  const policy = resources().find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(policy.spec.podSelector.matchLabels, {
    "app.kubernetes.io/name": "codeops-agents-ui",
  });
  assert.equal(
    policy.spec.ingress[0].from[0].namespaceSelector.matchLabels[
      "kubernetes.io/metadata.name"
    ],
    "ingress-nginx",
  );
  assert.deepEqual(
    policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b)),
    [53, 53, 8080],
  );
  assert.equal(JSON.stringify(policy).includes("0.0.0.0/0"), false);
});

test("rejects mutable images and credential or exposure drift", () => {
  for (const invalid of ["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => renderAgentsUiManifest(template, invalid));
  }
  for (const drifted of [
    template.replace("kind: NetworkPolicy", "kind: ConfigMap"),
    template.replace("secretName: codeops-session-broker-write-auth", "secretName: codeops-session-broker-read-auth"),
    template.replace("type: ClusterIP", "type: LoadBalancer"),
    template.replace(
      "selector:\n    app.kubernetes.io/name: codeops-agents-ui\n  ports:",
      "selector:\n    app.kubernetes.io/name: codeops-control-gateway\n  ports:",
    ),
    template.replace(
      "podSelector:\n    matchLabels:\n      app.kubernetes.io/name: codeops-agents-ui\n  policyTypes:",
      "podSelector:\n    matchLabels:\n      app.kubernetes.io/name: codeops-control-gateway\n  policyTypes:",
    ),
    `${template}\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: codeops-agents-ui\n`,
  ]) {
    assert.throws(() => renderAgentsUiManifest(drifted, digest));
  }
});
