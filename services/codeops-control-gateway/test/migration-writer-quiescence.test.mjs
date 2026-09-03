import assert from "node:assert/strict";
import test from "node:test";

import { quiesceMigrationWriterDeployments } from
  "../dist/migration-writer-quiescence.js";
import { MigrationKubernetesResponseError } from
  "../dist/migration-writer-quiescence.js";

const namespace = "team-a";
const names = ["team-a-session-gateway", "team-a-control-gateway"];

function deployment(name, replicas) {
  return { apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace, uid: `uid-${name}` }, spec: { replicas } };
}

function scale(name) { return { apiVersion: "autoscaling/v1", kind: "Scale",
  metadata: { name, namespace, uid: `uid-${name}` }, spec: { replicas: 0 } }; }

test("quiesces both admission writers and waits for every Pod to disappear", async () => {
  const replicas = new Map(names.map((name) => [name, 2]));
  const podScans = new Map(names.map((name) => [name, 0]));
  const calls = [];
  let now = 0;
  const request = async (method, path, body, contentType) => {
    calls.push({ method, path, body, contentType });
    const name = names.find((candidate) => path.includes(candidate));
    if (path.includes("/pods?")) {
      const decoded = decodeURIComponent(path);
      const podName = names.find((candidate) => decoded.endsWith(`=${candidate}`));
      const scan = podScans.get(podName) ?? 0;
      podScans.set(podName, scan + 1);
      return { status: 200, text: JSON.stringify({ apiVersion: "v1", kind: "PodList",
        items: scan === 0 ? [{ apiVersion: "v1", kind: "Pod",
          metadata: { name: `pod-${podName}`, namespace, uid: `pod-uid-${podName}` } }] : [] }) };
    }
    if (method === "PATCH") {
      assert.deepEqual(body, { metadata: { uid: `uid-${name}` }, spec: { replicas: 0 } });
      assert.equal(contentType, "application/merge-patch+json");
      replicas.set(name, 0);
      return { status: 200, text: JSON.stringify(scale(name)) };
    }
    return { status: 200, text: JSON.stringify(deployment(name, replicas.get(name))) };
  };
  await quiesceMigrationWriterDeployments({ namespace, deploymentNames: names,
    request, timeoutMs: 1_000, pollMs: 10,
    clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } } });
  assert.equal(calls.filter(({ method }) => method === "PATCH").length, 2);
  assert.equal(calls.filter(({ path }) => path.includes("/pods?")).length, 4);
});

test("fails closed on identity drift, partial quiescence, or a resumed writer", async () => {
  await assert.rejects(quiesceMigrationWriterDeployments({ namespace,
    deploymentNames: names, request: async () => ({ status: 200,
      text: JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment",
        metadata: { name: "other", namespace, uid: "uid" } }) }) }),
  /get-deployment returned an invalid HTTP 200 response/);

  let patches = 0;
  await assert.rejects(quiesceMigrationWriterDeployments({ namespace,
    deploymentNames: names, timeoutMs: 1_000, pollMs: 10,
    clock: { now: () => 1_000, sleep: async () => {} },
    request: async (method, path) => {
      const name = names.find((candidate) => path.includes(candidate));
      if (method === "PATCH") { patches += 1; return { status: 200,
        text: JSON.stringify(scale(name)) }; }
      if (path.includes("/pods?")) return { status: 200,
        text: JSON.stringify({ apiVersion: "v1", kind: "PodList", items: [{
          apiVersion: "v1", kind: "Pod",
          metadata: { name: "remaining", namespace, uid: "pod-uid" } }] }) };
      return { status: 200, text: JSON.stringify(deployment(name,
        patches >= names.length ? 1 : 2)) };
    } }), /resumed during quiescence/);
});

test("classifies every malformed successful migration identity as permanent", async () => {
  const cases = [
    { operation: "get-deployment", response: { apiVersion: "v1", kind: "Deployment",
      metadata: { name: names[0], namespace, uid: `uid-${names[0]}` } } },
    { operation: "scale-deployment", response: { apiVersion: "apps/v1", kind: "Scale",
      metadata: { name: names[0], namespace, uid: `uid-${names[0]}` },
      spec: { replicas: 0 } } },
    { operation: "list-pods", response: { apiVersion: "v1", kind: "PodList", items: [{
      apiVersion: "v1", kind: "Job", metadata: { name: "unrelated", namespace,
        uid: "unrelated-uid" } }] } },
  ];
  for (const item of cases) {
    await assert.rejects(quiesceMigrationWriterDeployments({ namespace,
      deploymentNames: [names[0]], timeoutMs: 1_000, pollMs: 10,
      request: async (method, path) => {
        if (item.operation === "get-deployment" ||
            (item.operation === "scale-deployment" && method === "PATCH") ||
            (item.operation === "list-pods" && path.includes("/pods?"))) {
          return { status: 200, text: JSON.stringify(item.response) };
        }
        if (method === "PATCH") return { status: 200, text: JSON.stringify(scale(names[0])) };
        return { status: 200, text: JSON.stringify(deployment(names[0], 0)) };
      } }), (error) => error instanceof MigrationKubernetesResponseError &&
        error.permanent === true && error.operation === item.operation && error.status === 200);
  }
});

test("rejects non-string Deployment, Scale, and Pod identity metadata", async () => {
  const resources = [
    { operation: "get-deployment", create: () => deployment(names[0], 2) },
    { operation: "scale-deployment", create: () => scale(names[0]) },
    { operation: "list-pods", create: () => ({ apiVersion: "v1", kind: "Pod",
      metadata: { name: "remaining", namespace, uid: "pod-uid" } }) },
  ];
  for (const { operation, create } of resources) {
    for (const field of ["name", "namespace", "uid"]) {
      const malformed = create();
      malformed.metadata[field] = 123;
      const response = operation === "list-pods"
        ? { apiVersion: "v1", kind: "PodList", items: [malformed] }
        : malformed;
      await assert.rejects(quiesceMigrationWriterDeployments({ namespace,
        deploymentNames: [names[0]], timeoutMs: 1_000, pollMs: 10,
        request: async (method, path) => {
          if (operation === "get-deployment" ||
              (operation === "scale-deployment" && method === "PATCH") ||
              (operation === "list-pods" && path.includes("/pods?"))) {
            return { status: 200, text: JSON.stringify(response) };
          }
          if (method === "PATCH") {
            return { status: 200, text: JSON.stringify(scale(names[0])) };
          }
          return { status: 200, text: JSON.stringify(deployment(names[0], 0)) };
        } }), (error) => error instanceof MigrationKubernetesResponseError &&
          error.permanent === true && error.operation === operation && error.status === 200);
    }
  }
});
