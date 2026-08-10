import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderControlGatewayManifest } from "./codeops-control-gateway-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/control-gateway-template.yaml",
    import.meta.url,
  ),
  "utf8",
);
const input = {
  controlGatewayDigest: `sha256:${"a".repeat(64)}`,
  modelProxyDigest: `sha256:${"d".repeat(64)}`,
  agentDigest: `sha256:${"b".repeat(64)}`,
  sessionGatewayDigest: `sha256:${"c".repeat(64)}`,
  kubernetesApiCidr: "10.3.0.1/32",
};

function resources() {
  return parseAllDocuments(renderControlGatewayManifest(template, input)).map(
    (document) => document.toJS(),
  );
}

test("renders one namespace-scoped authenticated gateway", () => {
  const values = resources();
  const deployment = values.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "codeops-control-gateway",
  );
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(
    deployment.spec.template.spec.serviceAccountName,
    "codeops-control-gateway",
  );
  assert.equal(
    deployment.spec.template.spec.containers[0].image,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-control-gateway@${input.controlGatewayDigest}`,
  );
  assert.equal(
    JSON.stringify(deployment).includes("codeops-agent-source-credentials"),
    true,
  );
  assert.equal(
    JSON.stringify(deployment).includes("codeops-repository-head-auth"),
    true,
  );
  assert.notEqual(
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "dispatch-auth",
    ).secret.secretName,
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "repository-head-auth",
    ).secret.secretName,
  );
  assert.equal(
    JSON.stringify(deployment).includes("CODEOPS_MODEL_API_KEY_FILE"),
    false,
  );
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_MODEL_PROXY_ORIGIN",
    ).value,
    "http://codeops-model-proxy:8080",
  );
  const proxy = values.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "codeops-model-proxy",
  );
  assert.equal(
    proxy.spec.template.spec.containers[0].image,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-model-proxy@${input.modelProxyDigest}`,
  );
  assert.equal(proxy.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    proxy.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "OPENAI_API_KEY",
    ).valueFrom.secretKeyRef.name,
    "codeops-model-proxy-credentials",
  );
});

test("grants only fixed run-resource and log operations", () => {
  const role = resources().find((resource) => resource.kind === "Role");
  assert.deepEqual(
    [...new Set(role.rules.flatMap((rule) => rule.verbs))].sort(),
    ["create", "delete", "get", "list"],
  );
  assert.equal(
    role.rules.some((rule) => rule.resources.includes("deployments")),
    false,
  );
  const secretRule = role.rules.find((rule) =>
    rule.resources.includes("secrets"),
  );
  assert.deepEqual(secretRule.verbs, ["create", "delete"]);
});

test("admits only the orchestrator/controller and exact API /32", () => {
  const policy = resources().find(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.name === "codeops-control-gateway",
  );
  assert.equal(
    policy.spec.ingress[0].from[0].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-orchestrator",
  );
  assert.equal(
    policy.spec.ingress[0].from[1].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-plane-controller",
  );
  assert.equal(policy.spec.egress[0].to[0].ipBlock.cidr, "10.3.0.1/32");
  assert.deepEqual(policy.spec.egress[0].ports, [
    { protocol: "TCP", port: 443 },
    { protocol: "TCP", port: 6443 },
  ]);
});

test("fails closed on mutable images, broad API CIDRs, or template drift", () => {
  for (const patch of [
    { controlGatewayDigest: "latest" },
    { modelProxyDigest: "latest" },
    { agentDigest: `sha256:${"B".repeat(64)}` },
    { kubernetesApiCidr: "10.3.0.0/24" },
  ]) {
    assert.throws(() =>
      renderControlGatewayManifest(template, { ...input, ...patch }),
    );
  }
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace("kind: Role", "kind: ClusterRole"),
      input,
    ),
  );
});
