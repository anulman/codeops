import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderPlaneControllerManifest } from "./codeops-plane-controller-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/plane-controller-template.yaml",
    import.meta.url,
  ),
  "utf8",
);
const input = {
  controllerDigest: `sha256:${"a".repeat(64)}`,
  baseSha: "b".repeat(40),
  controllerHost: `research-${"b".repeat(12)}.preview.renoconcierge.ca`,
  workspaceSlug: "reno-concierge",
  allowedHumanActorIds:
    "123e4567-e89b-12d3-a456-426614174000,223e4567-e89b-12d3-a456-426614174001",
};

function resources(rendered = renderPlaneControllerManifest(template, input)) {
  return parseAllDocuments(rendered).map((document) => document.toJS());
}

test("renders one immutable tokenless single-writer controller", () => {
  const manifests = resources();
  assert.deepEqual(
    manifests.map((resource) => resource.kind),
    [
      "ServiceAccount",
      "PersistentVolumeClaim",
      "Deployment",
      "Service",
      "Ingress",
      "NetworkPolicy",
    ],
  );
  const deployment = manifests.find(
    (resource) => resource.kind === "Deployment",
  );
  const pod = deployment.spec.template.spec;
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(
    pod.containers[0].image,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-plane-controller@${input.controllerDigest}`,
  );
  assert.deepEqual(pod.imagePullSecrets, [{ name: "ghcr-renoconcierge" }]);
  assert.deepEqual(pod.nodeSelector, {
    "renoconcierge.ca/codeops": "true",
  });
});

test("keeps credentials in mounted files and the ledger on a private RWO claim", () => {
  const manifests = resources();
  const claim = manifests.find(
    (resource) => resource.kind === "PersistentVolumeClaim",
  );
  const deployment = manifests.find(
    (resource) => resource.kind === "Deployment",
  );
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(claim.spec.resources.requests.storage, "1Gi");
  assert.equal(
    pod.volumes.find((volume) => volume.name === "ledger")
      .persistentVolumeClaim.claimName,
    "codeops-plane-controller-ledger",
  );
  assert.equal(
    pod.volumes.find((volume) => volume.name === "controller-secrets").secret
      .secretName,
    "codeops-plane-controller-secrets",
  );
  assert.equal(
    container.env.find(
      (entry) => entry.name === "CODEOPS_PLANE_API_KEY_FILE",
    ).value,
    "/var/run/secrets/codeops/plane-api-key",
  );
  assert.equal(container.env.some((entry) => entry.valueFrom), false);
  assert.equal(JSON.stringify(manifests).includes("value: sk-"), false);
});

test("exposes only the exact signed webhook and keeps liveness private", () => {
  const manifests = resources();
  const service = manifests.find((resource) => resource.kind === "Service");
  const ingress = manifests.find((resource) => resource.kind === "Ingress");
  assert.equal(service.spec.type, undefined);
  assert.equal(ingress.spec.rules[0].host, input.controllerHost);
  assert.deepEqual(
    ingress.spec.rules[0].http.paths.map((path) => [
      path.path,
      path.pathType,
    ]),
    [["/webhooks/plane", "Exact"]],
  );
  assert.equal(JSON.stringify(ingress).includes("/healthz"), false);
});

test("allows only ingress-nginx, Temporal, DNS, and public HTTPS", () => {
  const policy = resources().find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal(
    policy.spec.ingress[0].from[0].namespaceSelector.matchLabels[
      "kubernetes.io/metadata.name"
    ],
    "ingress-nginx",
  );
  const publicHttps = policy.spec.egress.find((rule) =>
    rule.ports?.some((port) => port.port === 443),
  );
  assert.equal(publicHttps.to[0].ipBlock.cidr, "0.0.0.0/0");
  assert.ok(publicHttps.to[0].ipBlock.except.includes("10.0.0.0/8"));
  assert.ok(publicHttps.to[0].ipBlock.except.includes("169.254.0.0/16"));
});

test("fails closed on malformed identity, image, host, or resource drift", () => {
  for (const patch of [
    { controllerDigest: "latest" },
    { baseSha: "abc" },
    { workspaceSlug: "Upper" },
    { allowedHumanActorIds: "" },
    {
      allowedHumanActorIds:
        "123e4567-e89b-12d3-a456-426614174000,123e4567-e89b-12d3-a456-426614174000",
    },
    { controllerHost: "research.preview.renoconcierge.ca" },
  ]) {
    assert.throws(() =>
      renderPlaneControllerManifest(template, { ...input, ...patch }),
    );
  }
  assert.throws(() =>
    renderPlaneControllerManifest(
      template.replace("kind: NetworkPolicy", "kind: ConfigMap"),
      input,
    ),
  );
  assert.throws(() =>
    renderPlaneControllerManifest(
      template.replace("type: Recreate", "type: RollingUpdate"),
      input,
    ),
  );
  assert.throws(() =>
    renderPlaneControllerManifest(
      template.replace("pathType: Exact", "pathType: Prefix"),
      input,
    ),
  );
});
