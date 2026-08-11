import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../k8s/codeops/trial0/", import.meta.url);
const lock = JSON.parse(await readFile(new URL("plane-chart.lock.json", root), "utf8"));
const valuesText = await readFile(new URL("plane-values.yaml", root), "utf8");
const values = parse(valuesText);
const readme = await readFile(new URL("README.md", root), "utf8");
const limitRange = parse(
  await readFile(new URL("plane-limit-range.yaml", root), "utf8"),
);

test("pins the official Plane CE chart and application", () => {
  assert.deepEqual(lock, {
    repository: "https://helm.plane.so/",
    chart: "plane-ce",
    chartVersion: "1.6.0",
    appVersion: "1.3.1",
    archiveSha256:
      "1ba78bfd4c2cc8870815d0dbb61623c1783a067c3c7beeaeec803a38f5ee7bf6",
  });
  assert.equal(values.planeVersion, `v${lock.appVersion}`);
});

test("uses the existing preview ingress and TLS boundary", () => {
  assert.equal(values.ingress.enabled, true);
  assert.equal(values.ingress.ingressClass, "nginx");
  assert.equal(
    values.ingress.appHost,
    "plane-candidate.preview.codeops.example",
  );
  assert.equal(values.ssl.tls_secret_name, "codeops-preview-wildcard-tls");
  assert.equal(values.ssl.createIssuer, false);
  assert.equal(values.ssl.generateCerts, false);
});

test("places every Plane workload only on the admitted CodeOps node", () => {
  for (const component of [
    "redis",
    "postgres",
    "rabbitmq",
    "minio",
    "web",
    "space",
    "admin",
    "live",
    "api",
    "worker",
    "beatworker",
  ]) {
    assert.deepEqual(values[component].nodeSelector, {
      "codeops.example/codeops": "true",
    });
    assert.equal(values[component].pullPolicy, "IfNotPresent");
  }
});

test("uses bounded persistent storage for Trial 0 state", () => {
  for (const component of ["redis", "postgres", "rabbitmq", "minio"]) {
    assert.equal(values[component].local_setup, true);
    assert.equal(values[component].storageClass, "csi-cinder-high-speed");
    assert.match(values[component].volumeSize, /^[1-9][0-9]*Gi$/);
  }
});

test("references externally generated secrets without literal secret values", () => {
  assert.deepEqual(values.external_secrets, {
    rabbitmq_existingSecret: "codeops-plane-rabbitmq",
    pgdb_existingSecret: "codeops-plane-postgres",
    doc_store_existingSecret: "codeops-plane-object-store",
    app_env_existingSecret: "codeops-plane-app",
    live_env_existingSecret: "codeops-plane-live",
  });
  for (const forbidden of [
    "default_password:",
    "pgdb_password:",
    "root_password:",
    "secret_key:",
    "live_server_secret_key:",
  ]) {
    assert.equal(valuesText.includes(forbidden), false, `literal ${forbidden}`);
  }
  assert.match(
    readme,
    /`codeops-plane-live`: `REDIS_URL`, `LIVE_SERVER_SECRET_KEY`/,
  );
});

test("defaults resources for chart workloads that expose no resource values", () => {
  assert.equal(limitRange.kind, "LimitRange");
  assert.deepEqual(limitRange.spec.limits, [
    {
      type: "Container",
      defaultRequest: { cpu: "100m", memory: "256Mi" },
      default: { cpu: "500m", memory: "1Gi" },
    },
  ]);
});
