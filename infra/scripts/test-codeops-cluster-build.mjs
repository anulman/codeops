import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import {
  renderClusterImageBuilderManifest,
  renderClusterRegistryManifest,
} from "./codeops-cluster-build-render.mjs";

const root = new URL("../k8s/codeops/trial0/", import.meta.url);
const registryTemplate = await readFile(
  new URL("cluster-registry-template.yaml", root),
  "utf8",
);
const builderTemplate = await readFile(
  new URL("cluster-image-builder-template.yaml", root),
  "utf8",
);
const lock = JSON.parse(
  await readFile(new URL("cluster-build-images.lock.json", root), "utf8"),
);
const baseSha = "a".repeat(40);
const registryInput = {
  baseSha,
  registryHost: `registry-${"a".repeat(12)}.preview.codeops.example`,
};

test("locks the registry, rootless BuildKit, and source Git images", () => {
  assert.deepEqual(lock, {
    platform: "linux/amd64",
    registry: {
      repository: "docker.io/library/registry",
      tag: "2.8.3",
      digest:
        "sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278",
    },
    buildkit: {
      repository: "docker.io/moby/buildkit",
      tag: "v0.25.2-rootless",
      digest:
        "sha256:d947144c3dc4f827f8dacaaf98d622f0143465740075fa9790991bc381761dc9",
    },
    git: {
      repository: "docker.io/alpine/git",
      tag: "v2.49.1",
      digest:
        "sha256:53a6239398162098fed2f49a46512f9cbba9e3f31b9f2cea4fa90129ee069a99",
    },
  });
});

test("renders a bounded authenticated single-writer registry", () => {
  const rendered = renderClusterRegistryManifest(
    registryTemplate,
    registryInput,
  );
  const resources = parseAllDocuments(rendered).map((document) =>
    document.toJS(),
  );
  assert.deepEqual(
    resources.map((resource) => resource.kind),
    [
      "ServiceAccount",
      "PersistentVolumeClaim",
      "Deployment",
      "Service",
      "Ingress",
      "NetworkPolicy",
    ],
  );
  const deployment = resources.find(
    (resource) => resource.kind === "Deployment",
  );
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "auth",
    ).secret.secretName,
    "codeops-registry-auth",
  );
  const ingress = resources.find((resource) => resource.kind === "Ingress");
  assert.equal(ingress.spec.rules[0].host, registryInput.registryHost);
  assert.equal(
    ingress.spec.tls[0].secretName,
    "codeops-preview-wildcard-tls",
  );
});

for (const imageKind of ["orchestrator", "plane-controller"]) {
  test(`renders a bounded exact-SHA ${imageKind} build`, () => {
    const buildId = `build-${imageKind}-${baseSha.slice(0, 12)}`;
    const rendered = renderClusterImageBuilderManifest(builderTemplate, {
      baseSha,
      buildId,
      imageKind,
    });
    const resources = parseAllDocuments(rendered).map((document) =>
      document.toJS(),
    );
    const job = resources.find((resource) => resource.kind === "Job");
    const pod = job.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(job.spec.activeDeadlineSeconds, 3600);
    assert.equal(
      pod.initContainers[0].env.find(
        (entry) => entry.name === "CODEOPS_BASE_SHA",
      ).value,
      baseSha,
    );
    assert.match(
      pod.containers[0].args.at(-1),
      new RegExp(`candidate-${baseSha}`),
    );
    assert.equal(
      pod.containers[0].securityContext.seccompProfile.type,
      "Unconfined",
    );
    assert.equal(
      pod.containers[0].securityContext.appArmorProfile.type,
      "Unconfined",
    );
  });
}

test("fails closed on identity, host, image kind, or template drift", () => {
  for (const patch of [
    { baseSha: "abc" },
    { registryHost: "registry.preview.codeops.example" },
  ]) {
    assert.throws(() =>
      renderClusterRegistryManifest(registryTemplate, {
        ...registryInput,
        ...patch,
      }),
    );
  }
  assert.throws(() =>
    renderClusterRegistryManifest(
      registryTemplate.replace("type: Recreate", "type: RollingUpdate"),
      registryInput,
    ),
  );
  assert.throws(() =>
    renderClusterImageBuilderManifest(builderTemplate, {
      baseSha,
      buildId: `build-orchestrator-${baseSha.slice(0, 12)}`,
      imageKind: "database",
    }),
  );
  assert.throws(() =>
    renderClusterImageBuilderManifest(
      builderTemplate.replace("automountServiceAccountToken: false", "automountServiceAccountToken: true"),
      {
        baseSha,
        buildId: `build-orchestrator-${baseSha.slice(0, 12)}`,
        imageKind: "orchestrator",
      },
    ),
  );
});
