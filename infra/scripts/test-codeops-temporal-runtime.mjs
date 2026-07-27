import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderOrchestratorManifest } from "./codeops-runtime-render.mjs";

const root = new URL("../k8s/codeops/trial0/", import.meta.url);
const temporalText = await readFile(new URL("temporal.yaml", root), "utf8");
const template = await readFile(
  new URL("orchestrator-template.yaml", root),
  "utf8",
);
const lock = JSON.parse(
  await readFile(new URL("temporal-image.lock.json", root), "utf8"),
);
const resources = parseAllDocuments(temporalText).map((document) =>
  document.toJS(),
);
const byKind = (kind) => resources.filter((resource) => resource.kind === kind);

test("pins the verified Temporal CLI/server/UI image by platform digest", () => {
  assert.deepEqual(lock, {
    repository: "docker.io/temporalio/admin-tools",
    tag: "1.31.2",
    platform: "linux/amd64",
    digest:
      "sha256:7e5820112475b3490f011b28d86ca9fd8348f1640b8dd04c62adb906e6b28cb2",
    cliVersion: "1.7.3",
    serverVersion: "1.31.2",
    uiVersion: "2.49.1",
  });
  const container = byKind("Deployment")[0].spec.template.spec.containers[0];
  assert.equal(container.image, `${lock.repository}@${lock.digest}`);
});

test("persists Temporal state and creates the CodeOps namespace", () => {
  const deployment = byKind("Deployment")[0];
  const args = deployment.spec.template.spec.containers[0].args;
  assert.deepEqual(args.slice(0, 3), ["temporal", "server", "start-dev"]);
  assert.ok(args.includes("/var/lib/temporal/temporal.db"));
  assert.ok(args.includes("codeops"));
  assert.equal(byKind("PersistentVolumeClaim")[0].spec.resources.requests.storage, "2Gi");
});

test("keeps Temporal UI and gRPC cluster-internal", () => {
  assert.equal(byKind("Ingress").length, 0);
  const service = byKind("Service")[0];
  assert.equal(service.spec.type, undefined);
  assert.deepEqual(
    service.spec.ports.map((port) => port.name),
    ["grpc", "ui", "metrics"],
  );
});

test("places and bounds the Temporal process on the admitted CodeOps node", () => {
  const pod = byKind("Deployment")[0].spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { "renoconcierge.ca/codeops": "true" });
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.containers[0].resources, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "2Gi" },
  });
});

test("allows Temporal gRPC only from the orchestrator and Plane controller", () => {
  const policy = byKind("NetworkPolicy")[0];
  assert.equal(policy.spec.ingress.length, 1);
  const grpcRule = policy.spec.ingress.find((rule) =>
    rule.ports.some((port) => port.port === 7233),
  );
  assert.deepEqual(grpcRule.from, [
    {
      podSelector: {
        matchLabels: { "app.kubernetes.io/name": "codeops-orchestrator" },
      },
    },
    {
      podSelector: {
        matchLabels: { "app.kubernetes.io/name": "codeops-plane-controller" },
      },
    },
  ]);
});

test("renders exactly one immutable orchestrator image", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const rendered = renderOrchestratorManifest(template, digest);
  const deployment = parseAllDocuments(rendered)
    .map((document) => document.toJS())
    .find((resource) => resource.kind === "Deployment");
  assert.equal(rendered.includes("CODEOPS_ORCHESTRATOR_DIGEST"), false);
  assert.deepEqual(deployment.spec.template.spec.imagePullSecrets, [
    { name: "ghcr-renoconcierge" },
  ]);
  assert.ok(
    rendered.includes(
      `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-orchestrator@${digest}`,
    ),
  );
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  const dispatchOrigin = pod.containers[0].env.find(
    (entry) => entry.name === "CODEOPS_AGENT_DISPATCH_ORIGIN",
  );
  assert.equal(dispatchOrigin.value, "http://codeops-control-gateway:8080");
  assert.equal(
    pod.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_RESEARCH_PROJECTION_ORIGIN",
    ).value,
    "http://codeops-plane-controller:8080",
  );
  assert.deepEqual(pod.volumes, [
    {
      name: "dispatch-auth",
      secret: {
        secretName: "codeops-agent-dispatch-auth",
        defaultMode: 256,
      },
    },
    {
      name: "projection-auth",
      secret: {
        secretName: "codeops-research-projection-auth",
        defaultMode: 256,
      },
    },
  ]);
});

test("allows the tokenless orchestrator to reach only Temporal, gateway, controller, and DNS", () => {
  const rendered = renderOrchestratorManifest(
    template,
    `sha256:${"a".repeat(64)}`,
  );
  const policy = parseAllDocuments(rendered)
    .map((document) => document.toJS())
    .find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(
    policy.spec.egress
      .flatMap((rule) => rule.ports.map((port) => port.port))
      .sort((a, b) => Number(a) - Number(b)),
    [53, 53, 7233, 8080, 8080],
  );
});

test("rejects missing, mutable, malformed, or ambiguous orchestrator images", () => {
  for (const digest of ["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => renderOrchestratorManifest(template, digest));
  }
  assert.throws(() =>
    renderOrchestratorManifest(
      template.replace(
        "imagePullPolicy:",
        "image: duplicate@CODEOPS_ORCHESTRATOR_DIGEST\n          imagePullPolicy:",
      ),
      `sha256:${"a".repeat(64)}`,
    ),
  );
});
