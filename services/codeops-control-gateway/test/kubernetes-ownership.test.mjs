import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertKubernetesResourceOwnership,
  createInClusterKubernetesClient as createKubernetesClient,
  kubernetesIdentityLabel,
  kubernetesResourceConfigurationDigest,
  KubernetesApiError,
  KubernetesResponseError,
  KubernetesResourceIdentityDriftError,
  isTransientKubernetesError,
} from "../dist/kubernetes.js";

const owner = JSON.stringify({
  admissionId: "11111111-1111-4111-8111-111111111111",
  childDispatchId: "44444444-4444-4444-8444-444444444444",
});
const digest = `sha256:${"a".repeat(64)}`;
const secretProofKey = "stable-test-secret-proof-key-material";
const createInClusterKubernetesClient = (input) => createKubernetesClient({
  secretProofKey, ...input,
});
const expected = { apiVersion: "v1", kind: "Secret", metadata: {
  name: "workspace-11111111111141118111111111111111-source",
  namespace: "agents-system",
  annotations: { "codeops.example/request-digest": digest,
    "codeops.example/materialization-owner": owner },
}, type: "Opaque", immutable: true, data: { "sources.json": "ZXhhY3Q=" } };

test("accepts only exact cleanup ownership and returns its Kubernetes UID fence", () => {
  const configDigest = kubernetesResourceConfigurationDigest(expected, secretProofKey);
  assert.equal(assertKubernetesResourceOwnership({ ...expected, metadata: {
    ...expected.metadata, uid: "exact-kubernetes-uid", annotations: {
      ...expected.metadata.annotations,
      "codeops.example/resource-configuration-digest": configDigest,
    }, resourceVersion: "1" } }, expected, digest, undefined, configDigest, secretProofKey),
  "exact-kubernetes-uid");
  for (const existing of [
    { ...expected, metadata: { ...expected.metadata, uid: "uid",
      annotations: { ...expected.metadata.annotations,
        "codeops.example/resource-configuration-digest": configDigest,
        "codeops.example/materialization-owner": `${owner}-foreign` } } },
    { ...expected, metadata: { ...expected.metadata, uid: "uid",
      annotations: { ...expected.metadata.annotations,
        "codeops.example/resource-configuration-digest": configDigest,
        "codeops.example/request-digest": `sha256:${"b".repeat(64)}` } } },
    { ...expected, metadata: { ...expected.metadata, uid: undefined } },
  ]) assert.throws(() => assertKubernetesResourceOwnership(
    existing, expected, digest, undefined, configDigest, secretProofKey),
    KubernetesResourceIdentityDriftError);
});


function existingResource(resource, uid = "persisted-uid") {
  return { ...structuredClone(resource), metadata: { ...structuredClone(resource.metadata), uid,
    resourceVersion: "legacy-resource-version",
    annotations: { ...resource.metadata.annotations,
      "codeops.example/resource-configuration-digest":
        kubernetesResourceConfigurationDigest(resource,
          resource.kind === "Secret" ? secretProofKey : undefined) } } };
}

test("rejects replacement UIDs and immutable PVC and Job configuration drift", () => {
  const resources = [
    { ...expected, data: { "sources.json": "ZXhhY3Q=" }, immutable: true, type: "Opaque" },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: expected.metadata,
      spec: { accessModes: ["ReadWriteOnce"], storageClassName: "fast",
        resources: { requests: { storage: "10Gi" } } } },
    { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
      spec: { template: { spec: { serviceAccountName: "runtime",
        containers: [{ name: "runtime-worker", image: `registry/worker@sha256:${"1".repeat(64)}`,
          env: [{ name: "CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN", value: "http://gateway:8080" },
            { name: "CODEOPS_MODEL_PROXY_ORIGIN", value: "http://model-proxy:8080" }],
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }] }],
        volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: "workspace" } }] } } } },
  ];
  for (const resource of resources) {
    const existing = existingResource(resource);
    const configDigest = kubernetesResourceConfigurationDigest(resource,
      resource.kind === "Secret" ? secretProofKey : undefined);
    assert.equal(assertKubernetesResourceOwnership(existing, resource, digest, "persisted-uid",
      configDigest, resource.kind === "Secret" ? secretProofKey : undefined),
      "persisted-uid");
    assert.throws(() => assertKubernetesResourceOwnership(existing, resource, digest,
      "replacement-uid", configDigest,
      resource.kind === "Secret" ? secretProofKey : undefined),
    KubernetesResourceIdentityDriftError);
  }
  const drifts = [
    [resources[1], (value) => { value.spec.resources.requests.storage = "20Gi"; }],
    [resources[1], (value) => { value.spec.storageClassName = "foreign"; }],
    [resources[2], (value) => { value.spec.template.spec.serviceAccountName = "foreign"; }],
    [resources[2], (value) => { value.spec.template.spec.containers[0].image =
      `registry/worker@sha256:${"2".repeat(64)}`; }],
    [resources[2], (value) => { value.spec.template.spec.containers[0].env[0].value =
      "http://foreign:8080"; }],
    [resources[2], (value) => { value.spec.template.spec.containers[0].volumeMounts[0].mountPath =
      "/foreign"; }],
    [resources[2], (value) => { value.spec.template.spec.volumes[0].persistentVolumeClaim.claimName =
      "foreign"; }],
  ];
  for (const [resource, mutate] of drifts) {
    const existing = existingResource(resource);
    mutate(existing);
    assert.throws(() => assertKubernetesResourceOwnership(existing, resource, digest,
      "persisted-uid"), KubernetesResourceIdentityDriftError);
  }
  const rotatedSecret = existingResource(resources[0]);
  rotatedSecret.data["sources.json"] = "cm90YXRlZA==";
  rotatedSecret.metadata.annotations["codeops.example/source-identity"] = "f".repeat(64);
  const cleanupIdentity = { apiVersion: resources[0].apiVersion, kind: resources[0].kind,
    metadata: resources[0].metadata };
  assert.throws(() => assertKubernetesResourceOwnership(rotatedSecret, cleanupIdentity, digest,
    "persisted-uid", kubernetesResourceConfigurationDigest(resources[0], secretProofKey),
    secretProofKey), KubernetesResourceIdentityDriftError);
});

test("persisted UID validation is GET-only and missing or replacement resources are permanent", async () => {
  const exact = existingResource(expected);
  for (const [response, succeeds] of [
    [{ status: 200, text: JSON.stringify(exact) }, true],
    [{ status: 404, text: "" }, false],
    [{ status: 200, text: JSON.stringify({ ...exact, metadata: {
      ...exact.metadata, uid: "replacement-uid" } }) }, false],
  ]) {
    const methods = [];
    const client = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
      request: async (method) => { methods.push(method); return response; } });
    const operation = client.ensure(expected, digest, "persisted-uid");
    if (succeeds) assert.equal((await operation).uid, "persisted-uid");
    else await assert.rejects(operation, KubernetesResourceIdentityDriftError);
    assert.deepEqual(methods, ["GET"]);
  }
});

test("cleanup uses stable ownership and the original digest, not rotated Secret content", () => {
  const original = { ...expected, immutable: true, type: "Opaque",
    data: { "sources.json": "b3JpZ2luYWw=" } };
  const originalDigest = kubernetesResourceConfigurationDigest(original, secretProofKey);
  const existing = existingResource(original);
  const cleanupIdentity = { apiVersion: original.apiVersion, kind: original.kind,
    metadata: structuredClone(original.metadata) };
  const rotated = { ...original, data: { "sources.json": "cm90YXRlZA==" } };
  assert.notEqual(kubernetesResourceConfigurationDigest(rotated, secretProofKey), originalDigest);
  assert.equal(assertKubernetesResourceOwnership(existing, cleanupIdentity, digest,
    "persisted-uid", originalDigest, secretProofKey), "persisted-uid");
});

test("a conflict adopts an exact legacy resource with a resource-version fence", async () => {
  const original = { ...expected, immutable: true, type: "Opaque",
    data: { "sources.json": "b3JpZ2luYWw=" } };
  const configDigest = kubernetesResourceConfigurationDigest(original, secretProofKey);
  const existing = existingResource(original, "created-before-upgrade");
  delete existing.metadata.annotations["codeops.example/resource-configuration-digest"];
  const adopted = { ...structuredClone(existing), metadata: { ...existing.metadata,
    annotations: { ...existing.metadata.annotations,
      "codeops.example/resource-configuration-digest": configDigest } } };
  const methods = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async (method, _path, body, _expected, contentType) => {
      methods.push(method);
      if (method === "PATCH") {
        assert.equal(contentType, "application/merge-patch+json");
        assert.deepEqual(body.metadata, { uid: "created-before-upgrade",
          resourceVersion: "legacy-resource-version", annotations: {
            "codeops.example/resource-configuration-digest": configDigest } });
        return { status: 200, text: JSON.stringify(adopted) };
      }
      return method === "POST" ? { status: 409, text: "" } :
        { status: 200, text: JSON.stringify(existing) };
    } });
  assert.deepEqual(await client.ensure(original, digest), {
    uid: "created-before-upgrade",
    configDigest,
  });
  assert.deepEqual(methods, ["POST", "GET", "PATCH"]);
});

test("pre-upgrade recovery defers exact annotation adoption to ensure", async () => {
  const original = { ...expected, immutable: true, type: "Opaque",
    data: { "sources.json": "b3JpZ2luYWw=" } };
  const configDigest = kubernetesResourceConfigurationDigest(original, secretProofKey);
  const legacy = existingResource(original, "pre-upgrade-uid");
  delete legacy.metadata.annotations["codeops.example/resource-configuration-digest"];
  const adopted = structuredClone(legacy);
  adopted.metadata.annotations["codeops.example/resource-configuration-digest"] = configDigest;
  const methods = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async (method, _path, body) => {
      methods.push(method);
      if (method === "POST") return { status: 409, text: "" };
      if (method === "PATCH") {
        assert.equal(body.metadata.uid, "pre-upgrade-uid");
        assert.equal(body.metadata.resourceVersion, "legacy-resource-version");
        return { status: 200, text: JSON.stringify(adopted) };
      }
      return { status: 200, text: JSON.stringify(legacy) };
    } });
  assert.equal(await client.recoverOwned(original, digest), null);
  assert.deepEqual(await client.ensure(original, digest), {
    uid: "pre-upgrade-uid", configDigest,
  });
  assert.deepEqual(methods, ["GET", "POST", "GET", "PATCH"]);
});

test("legacy adoption rejects extra Job configuration including an injected initContainer", async () => {
  const job = { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
    spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "worker",
      image: `registry/worker@sha256:${"1".repeat(64)}` }] } } } };
  const legacy = existingResource(job);
  delete legacy.metadata.annotations["codeops.example/resource-configuration-digest"];
  legacy.spec.template.spec.initContainers = [{ name: "injected", image:
    `registry/injected@sha256:${"2".repeat(64)}` }];
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async (method) => method === "POST" ? { status: 409, text: "" } :
      { status: 200, text: JSON.stringify(legacy) } });
  await assert.rejects(client.ensure(job, digest), KubernetesResourceIdentityDriftError);
});

test("bound resource validation rejects extra configuration after adoption", () => {
  const job = { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
    spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "worker",
      image: `registry/worker@sha256:${"1".repeat(64)}` }] } } } };
  const existing = existingResource(job);
  existing.spec.template.spec.initContainers = [{ name: "injected",
    image: `registry/injected@sha256:${"2".repeat(64)}` }];
  assert.throws(() => assertKubernetesResourceOwnership(
    existing, job, digest, "persisted-uid"), KubernetesResourceIdentityDriftError);
});

test("initial Job creation rejects mutating-admission configuration drift", async () => {
  const job = { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
    spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "worker",
      image: `registry/worker@sha256:${"1".repeat(64)}` }] } } } };
  const response = existingResource(job, "created-uid");
  response.spec.template.spec.initContainers = [{ name: "injected",
    image: `registry/injected@sha256:${"2".repeat(64)}` }];
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async () => ({ status: 201, text: JSON.stringify(response) }) });
  await assert.rejects(client.ensure(job, digest), KubernetesResourceIdentityDriftError);
});

test("accepts reviewed API-server Job defaults but rejects other added configuration", async () => {
  const job = { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
    spec: { backoffLimit: 0, template: { metadata: { labels: { app: "worker" } }, spec: {
      restartPolicy: "Never", serviceAccountName: "runtime", imagePullSecrets: [],
      containers: [{ name: "worker",
        image: `registry/worker@sha256:${"1".repeat(64)}`,
        readinessProbe: { exec: { command: ["true"] }, periodSeconds: 2,
          timeoutSeconds: 1 } }], volumes: [{ name: "workspace",
        persistentVolumeClaim: { claimName: "workspace" } }] } } } };
  const response = existingResource(job, "created-job-uid");
  delete response.spec.template.spec.imagePullSecrets;
  response.metadata.finalizers = ["batch.kubernetes.io/job-tracking"];
  Object.assign(response.spec, { completionMode: "NonIndexed", completions: 1, parallelism: 1,
    suspend: false, manualSelector: false, managedBy: "kubernetes.io/job-controller",
    podReplacementPolicy: "TerminatingOrFailed",
    selector: { matchLabels: { "batch.kubernetes.io/controller-uid": "created-job-uid" } } });
  Object.assign(response.spec.template.metadata.labels, {
    "batch.kubernetes.io/controller-uid": "created-job-uid",
    "batch.kubernetes.io/job-name": job.metadata.name,
    "controller-uid": "created-job-uid", "job-name": job.metadata.name,
  });
  Object.assign(response.spec.template.spec, { dnsPolicy: "ClusterFirst",
    schedulerName: "default-scheduler", serviceAccount: "runtime" });
  Object.assign(response.spec.template.spec.containers[0], {
    terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File",
  });
  Object.assign(response.spec.template.spec.containers[0].readinessProbe, {
    failureThreshold: 3, successThreshold: 1,
  });
  response.spec.template.spec.volumes[0].persistentVolumeClaim.readOnly = false;
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
      ({ status: 201, text: JSON.stringify(response) }) });
  assert.equal((await client.ensure(job, digest)).uid, "created-job-uid");
  const cleanupMethods = [];
  const cleanupClient = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async (method) => { cleanupMethods.push(method); return method === "GET"
      ? { status: 200, text: JSON.stringify(response) } : { status: 202,
        text: JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Success",
          details: { group: "batch", kind: "jobs", name: job.metadata.name,
            uid: "created-job-uid" } }) }; } });
  await cleanupClient.delete({ apiVersion: job.apiVersion, kind: job.kind,
    metadata: job.metadata }, digest, "created-job-uid",
  kubernetesResourceConfigurationDigest(job));
  assert.deepEqual(cleanupMethods, ["GET", "DELETE"]);
  response.spec.template.spec.hostNetwork = true;
  await assert.rejects(client.ensure(job, digest), KubernetesResourceIdentityDriftError);
  delete response.spec.template.spec.hostNetwork;
  response.spec.template.spec.imagePullSecrets = [{ name: "foreign-registry" }];
  await assert.rejects(client.ensure(job, digest), KubernetesResourceIdentityDriftError);
  response.spec.template.spec.imagePullSecrets = [];
  response.spec.template.spec.containers[0].readinessProbe.failureThreshold = 4;
  await assert.rejects(client.ensure(job, digest), KubernetesResourceIdentityDriftError);
});

test("accepts a bound PVC shape but rejects claim and storage drift", async () => {
  const pvc = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: expected.metadata,
    spec: { accessModes: ["ReadWriteOnce"], storageClassName: "fast",
      resources: { requests: { storage: "10Gi" } } } };
  const response = existingResource(pvc, "bound-pvc-uid");
  response.metadata.finalizers = ["kubernetes.io/pvc-protection"];
  Object.assign(response.metadata.annotations, {
    "pv.kubernetes.io/bind-completed": "yes",
    "pv.kubernetes.io/bound-by-controller": "yes",
    "volume.kubernetes.io/storage-provisioner": "example.csi",
    "volume.kubernetes.io/selected-node": "worker-1",
  });
  Object.assign(response.spec, { volumeName: "pvc-volume", volumeMode: "Filesystem" });
  response.status = { phase: "Bound", capacity: { storage: "10Gi" },
    accessModes: ["ReadWriteOnce"] };
  assert.equal(assertKubernetesResourceOwnership(response, pvc, digest, "bound-pvc-uid"),
    "bound-pvc-uid");
  for (const mutate of [
    (value) => { value.spec.accessModes = ["ReadOnlyMany"]; },
    (value) => { value.spec.resources.requests.storage = "20Gi"; },
    (value) => { value.spec.storageClassName = "foreign"; },
    (value) => { value.spec.dataSource = { kind: "PersistentVolumeClaim", name: "foreign" }; },
  ]) {
    const drifted = structuredClone(response); mutate(drifted);
    assert.throws(() => assertKubernetesResourceOwnership(
      drifted, pvc, digest, "bound-pvc-uid"), KubernetesResourceIdentityDriftError);
  }
});

test("normalizes only an omitted PVC storage class default", () => {
  const omitted = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: expected.metadata,
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } } };
  const defaulted = existingResource(omitted, "defaulted-pvc-uid");
  defaulted.spec.storageClassName = "cluster-default";
  assert.equal(assertKubernetesResourceOwnership(
    defaulted, omitted, digest, "defaulted-pvc-uid"), "defaulted-pvc-uid");

  const explicit = { ...structuredClone(omitted), spec: { ...structuredClone(omitted.spec),
    storageClassName: "fast" } };
  assert.equal(assertKubernetesResourceOwnership(
    existingResource(explicit), explicit, digest, "persisted-uid"), "persisted-uid");
  const drifted = existingResource(explicit);
  drifted.spec.storageClassName = "cluster-default";
  assert.throws(() => assertKubernetesResourceOwnership(
    drifted, explicit, digest, "persisted-uid"), KubernetesResourceIdentityDriftError);
});

test("initial Secret creation rejects mutated credentials, source identity, and extra data", async () => {
  const secret = { ...expected, type: "Opaque", immutable: true,
    data: { "sources.json": "ZXhhY3Q=" }, metadata: { ...expected.metadata,
      annotations: { ...expected.metadata.annotations,
        "codeops.example/source-identity": "1".repeat(64) } } };
  for (const mutate of [
    (value) => { value.data["sources.json"] = "YWx0ZXJlZA=="; },
    (value) => { value.data.extra = "ZXh0cmE="; },
    (value) => { value.metadata.annotations["codeops.example/source-identity"] = "2".repeat(64); },
  ]) {
    const response = existingResource(secret, "created-uid");
    mutate(response);
    const client = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
      request: async () => ({ status: 201, text: JSON.stringify(response) }) });
    await assert.rejects(client.ensure(secret, digest), KubernetesResourceIdentityDriftError);
  }
});

test("Secret replay proves exact immutable bytes with a resource-version and stable keyed proof", async () => {
  const secret = { ...expected, metadata: { ...expected.metadata, annotations: {
    ...expected.metadata.annotations, "codeops.example/source-identity": "1".repeat(64),
  } } };
  const proof = kubernetesResourceConfigurationDigest(secret, secretProofKey);
  const exact = existingResource(secret, "durable-secret-uid");
  const cleanupIdentity = { apiVersion: secret.apiVersion, kind: secret.kind,
    metadata: { name: secret.metadata.name, namespace: secret.metadata.namespace,
      annotations: { "codeops.example/request-digest": digest,
        "codeops.example/materialization-owner": owner } } };
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
      ({ status: 200, text: JSON.stringify(exact) }) });
  assert.deepEqual(await client.ensure(cleanupIdentity, digest, "durable-secret-uid", proof), {
    uid: "durable-secret-uid", configDigest: proof,
  });
  const mutations = [
    (value) => { delete value.metadata.resourceVersion; },
    (value) => { value.metadata.resourceVersion = " "; },
    (value) => { value.metadata.uid = "replacement-secret-uid"; },
    (value) => { value.type = "kubernetes.io/tls"; },
    (value) => { value.immutable = false; },
    (value) => { value.data["sources.json"] = "YWx0ZXJlZA=="; },
    (value) => { value.data.extra = "ZXh0cmE="; },
    (value) => { delete value.data["sources.json"]; },
  ];
  for (const mutate of mutations) {
    const drifted = structuredClone(exact); mutate(drifted);
    const driftClient = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
        ({ status: 200, text: JSON.stringify(drifted) }) });
    await assert.rejects(driftClient.ensure(
      cleanupIdentity, digest, "durable-secret-uid", proof), KubernetesResourceIdentityDriftError);
  }
  const rotatedKeyClient = createKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0),
    secretProofKey: "different-stable-secret-proof-key", request: async () =>
      ({ status: 200, text: JSON.stringify(exact) }) });
  await assert.rejects(rotatedKeyClient.ensure(
    cleanupIdentity, digest, "durable-secret-uid", proof), KubernetesResourceIdentityDriftError);
});

test("crash-window recovery accepts only the exact durable owner identity", async () => {
  const exact = existingResource(expected, "crash-window-uid");
  for (const [resource, succeeds] of [[exact, true], [{ ...exact, metadata: {
    ...exact.metadata, annotations: { ...exact.metadata.annotations,
      "codeops.example/materialization-owner": `${owner}-foreign` } } }, false]]) {
    const client = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
      request: async () => ({ status: 200, text: JSON.stringify(resource) }) });
    const operation = client.recoverOwned(expected, digest);
    if (succeeds) assert.equal((await operation).uid, "crash-window-uid");
    else await assert.rejects(operation, KubernetesResourceIdentityDriftError);
  }
});

test("Secret recovery authenticates observed bytes before reporting rotated configuration", async () => {
  const observed = { ...structuredClone(expected), metadata: { ...expected.metadata,
    annotations: { ...expected.metadata.annotations,
      "codeops.example/source-identity": "1".repeat(64) } },
  data: { "sources.json": "b2xkLWNyZWRlbnRpYWw=" } };
  const exact = existingResource(observed, "rotated-secret-uid");
  const desired = { ...structuredClone(observed), metadata: { ...observed.metadata,
    annotations: { ...observed.metadata.annotations,
      "codeops.example/source-identity": "2".repeat(64) } },
  data: { "sources.json": "bmV3LWNyZWRlbnRpYWw=" } };
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
      ({ status: 200, text: JSON.stringify(exact) }) });
  assert.deepEqual(await client.recoverOwned(desired, digest), {
    uid: "rotated-secret-uid",
    configDigest: kubernetesResourceConfigurationDigest(observed, secretProofKey),
    desiredConfigDigest: kubernetesResourceConfigurationDigest(desired, secretProofKey),
    matchesExpectedConfiguration: false,
  });

  const mutations = [
    (value) => { value.metadata.annotations["codeops.example/request-digest"] =
      `sha256:${"b".repeat(64)}`; },
    (value) => { value.metadata.annotations["codeops.example/materialization-owner"] =
      `${owner}-foreign`; },
    (value) => { delete value.metadata.uid; },
    (value) => { delete value.metadata.resourceVersion; },
    (value) => { value.data["sources.json"] = "dGFtcGVyZWQ="; },
  ];
  for (const mutate of mutations) {
    const drifted = structuredClone(exact);
    mutate(drifted);
    const driftClient = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
        ({ status: 200, text: JSON.stringify(drifted) }) });
    await assert.rejects(driftClient.recoverOwned(desired, digest), (error) =>
      error instanceof KubernetesResourceIdentityDriftError ||
      error instanceof KubernetesResponseError);
  }
});

test("recovery explicitly finds one exact legacy credential-derived name", async () => {
  const stable = { ...structuredClone(expected), metadata: { ...expected.metadata,
    labels: { "codeops.example/launch-id": "launch-0123456789abcdef01234567",
      "codeops.example/resource-role": "source-authority" } } };
  const legacyName = `${stable.metadata.name}-0123456789`;
  const legacyDesired = { ...stable, metadata: { ...stable.metadata, name: legacyName } };
  const legacy = existingResource(legacyDesired, "legacy-secret-uid");
  const paths = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async (_method, path) => {
      paths.push(path);
      return path.includes("?labelSelector=")
        ? { status: 200, text: JSON.stringify({ apiVersion: "v1", kind: "SecretList",
          items: [legacy] }) }
        : { status: 404, text: "" };
    } });
  assert.deepEqual(await client.recoverOwned(stable, digest), {
    uid: "legacy-secret-uid",
    configDigest: kubernetesResourceConfigurationDigest(legacyDesired, secretProofKey),
    desiredConfigDigest: kubernetesResourceConfigurationDigest(stable, secretProofKey),
    resourceName: legacyName,
    matchesExpectedConfiguration: false,
  });
  assert.equal(paths.length, 2);
});

test("legacy adoption rejects every ownership, content, credential, and ambiguity boundary", async () => {
  const original = { ...expected, immutable: true, type: "Opaque",
    data: { "sources.json": "b3JpZ2luYWw=" } };
  const mutations = [
    (value) => { value.metadata.uid = ""; },
    (value) => { delete value.metadata.resourceVersion; },
    (value) => { value.metadata.annotations["codeops.example/request-digest"] =
      `sha256:${"b".repeat(64)}`; },
    (value) => { value.metadata.annotations["codeops.example/materialization-owner"] =
      `${owner}-foreign`; },
    (value) => { value.metadata.annotations["foreign.example/ambiguous"] = "true"; },
    (value) => { value.metadata.labels = { "foreign.example/ambiguous": "true" }; },
    (value) => { value.data["sources.json"] = "cm90YXRlZA=="; },
    (value) => { value.data["ambiguous"] = "dW5leHBlY3RlZA=="; },
    (value) => { value.immutable = false; },
  ];
  for (const mutate of mutations) {
    const legacy = existingResource(original);
    delete legacy.metadata.annotations["codeops.example/resource-configuration-digest"];
    mutate(legacy);
    const methods = [];
    const client = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
      request: async (method) => {
        methods.push(method);
        return method === "POST" ? { status: 409, text: "" } :
          { status: 200, text: JSON.stringify(legacy) };
      } });
    await assert.rejects(client.ensure(original, digest), (error) =>
      error instanceof KubernetesResourceIdentityDriftError ||
      error instanceof KubernetesResponseError);
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("cleanup treats exact missing and delete-race 404 responses as complete", async () => {
  for (const missingBeforeDelete of [true, false]) {
    const methods = [];
    const exact = existingResource(expected);
    const client = createInClusterKubernetesClient({ namespace: "agents-system",
      host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
      request: async (method) => {
        methods.push(method);
        if (method === "GET" && !missingBeforeDelete) {
          return { status: 200, text: JSON.stringify(exact) };
        }
        return { status: 404, text: "" };
      } });
    await client.delete(expected, digest, "persisted-uid",
      kubernetesResourceConfigurationDigest(expected, secretProofKey));
    assert.deepEqual(methods, missingBeforeDelete ? ["GET"] : ["GET", "DELETE"]);
  }
});

test("cleanup never sends DELETE for a replacement UID or immutable drift", async () => {
  const job = { apiVersion: "batch/v1", kind: "Job", metadata: expected.metadata,
    spec: { backoffLimit: 0, template: { spec: { restartPolicy: "Never", containers: [{
      name: "runtime-worker", image: `registry/worker@sha256:${"1".repeat(64)}`,
    }] } } } };
  const cases = [
    [expected, (value) => { value.metadata.uid = "replacement-uid"; }],
    [expected, (value) => { value.data["sources.json"] = "YWx0ZXJlZA=="; }],
    [job, (value) => { value.spec.template.spec.containers[0].image =
      `registry/worker@sha256:${"2".repeat(64)}`; }],
  ];
  for (const [resource, mutate] of cases) {
    const existing = existingResource(resource); mutate(existing);
    const methods = [];
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async (method) => {
        methods.push(method); return { status: 200, text: JSON.stringify(existing) };
      } });
    const cleanupIdentity = { apiVersion: resource.apiVersion, kind: resource.kind,
      metadata: resource.metadata };
    await assert.rejects(client.delete(cleanupIdentity, digest, "persisted-uid",
      kubernetesResourceConfigurationDigest(resource,
        resource.kind === "Secret" ? secretProofKey : undefined)),
    KubernetesResourceIdentityDriftError);
    assert.deepEqual(methods, ["GET"]);
  }
});

test("reloads the projected token and classifies Kubernetes HTTP failures", async () => {
  const tokens = ["projected-token-before-rotation", "projected-token-after-rotation"];
  const observed = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: async () => tokens.shift(), ca: Buffer.alloc(0),
    request: async (_method, _path, _body, _expected, _contentType, token) => {
      observed.push(token); return { status: 200,
        text: JSON.stringify({ apiVersion: "v1", kind: "PodList", items: [] }) };
    } });
  await client.listRunPods("run-1");
  await client.listRunPods("run-1");
  assert.deepEqual(observed,
    ["projected-token-before-rotation", "projected-token-after-rotation"]);

  for (const status of [408, 429, 500, 503]) {
    assert.equal(isTransientKubernetesError(new KubernetesApiError("delete", status)), true);
  }
  for (const status of [400, 401, 403, 409, 422]) {
    assert.equal(isTransientKubernetesError(new KubernetesApiError("delete", status)), false);
  }
});

test("cleanup sends no request without an exact persisted binding", async () => {
  const methods = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async (method) => {
      methods.push(method); return { status: 404, text: "" };
    } });
  await assert.rejects(client.delete(expected, digest, undefined,
    kubernetesResourceConfigurationDigest(expected, secretProofKey)),
  KubernetesResourceIdentityDriftError);
  await assert.rejects(client.delete(expected, digest, "persisted-uid", undefined),
    KubernetesResourceIdentityDriftError);
  assert.deepEqual(methods, []);
});

test("Pod listing preserves raw root run labels and bounds admitted-child labels", async () => {
  const paths = [];
  const client = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0),
    request: async (_method, path) => {
      paths.push(path); return { status: 200,
        text: JSON.stringify({ apiVersion: "v1", kind: "PodList", items: [] }) };
    } });
  const runId = "run:identity-that-is-not-a-kubernetes-label";
  await client.listRunPods(runId);
  await client.listRunPods(runId, true);
  assert.equal(decodeURIComponent(paths[0]).endsWith(
    `labelSelector=codeops.example/run-id=${runId}`), true);
  assert.equal(decodeURIComponent(paths[1]).endsWith(
    `labelSelector=codeops.example/run-id=${kubernetesIdentityLabel(runId)}`), true);
});

test("malformed successful resource creation is a permanent ensure response error", async () => {
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
      ({ status: 201, text: "{" }) });
  await assert.rejects(client.ensure(expected, digest), (error) =>
    error instanceof KubernetesResponseError && error.operation === "ensure" &&
    error.status === 201 && !isTransientKubernetesError(error));
});

test("malformed successful resource and Job reads are permanent operation errors", async () => {
  const malformed = { status: 200, text: JSON.stringify({ metadata: {} }) };
  const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
    port: 443, token: "unused", ca: Buffer.alloc(0), request: async () => malformed });
  await assert.rejects(client.ensure(expected, digest, "persisted-uid",
    kubernetesResourceConfigurationDigest(expected, secretProofKey)), (error) =>
    error instanceof KubernetesResponseError && error.operation === "ensure" &&
    error.status === 200 && !isTransientKubernetesError(error));
  await assert.rejects(client.getJob("agent-job"), (error) =>
    error instanceof KubernetesResponseError && error.operation === "get-job" &&
    error.status === 200 && !isTransientKubernetesError(error));
  await assert.rejects(client.recoverOwned(expected, digest), (error) =>
    error instanceof KubernetesResponseError && error.operation === "recover" &&
    error.status === 200 && !isTransientKubernetesError(error));
});

test("successful Job reads require the exact requested API identity and UID", async () => {
  const exact = { apiVersion: "batch/v1", kind: "Job", metadata: {
    namespace: "agents-system", name: "agent-job", uid: "job-uid" } };
  const validClient = createInClusterKubernetesClient({ namespace: "agents-system",
    host: "unused", port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
      ({ status: 200, text: JSON.stringify(exact) }) });
  assert.deepEqual(await validClient.getJob("agent-job"), exact);
  for (const mutate of [
    (value) => { value.apiVersion = "v1"; },
    (value) => { value.kind = "Pod"; },
    (value) => { value.metadata.namespace = "foreign"; },
    (value) => { value.metadata.name = "foreign-job"; },
    (value) => { value.metadata.uid = ""; },
  ]) {
    const response = structuredClone(exact); mutate(response);
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
        ({ status: 200, text: JSON.stringify(response) }) });
    await assert.rejects(client.getJob("agent-job"), (error) =>
      error instanceof KubernetesResponseError && error.operation === "get-job" &&
      error.status === 200 && !isTransientKubernetesError(error));
  }
});

test("malformed successful Pod lists are permanent list response errors", async () => {
  const exactPod = { apiVersion: "v1", kind: "Pod", metadata: {
    namespace: "agents-system", name: "agent-pod", uid: "pod-uid" } };
  const malformed = [
    { items: [] },
    { apiVersion: "batch/v1", kind: "PodList", items: [] },
    { apiVersion: "v1", kind: "List", items: [] },
    { apiVersion: "v1", kind: "PodList", items: [null] },
    ...[
      (value) => { value.apiVersion = "batch/v1"; },
      (value) => { value.kind = "Job"; },
      (value) => { value.metadata.namespace = "foreign"; },
      (value) => { value.metadata.name = ""; },
      (value) => { value.metadata.uid = ""; },
    ].map((mutate) => { const pod = structuredClone(exactPod); mutate(pod);
      return { apiVersion: "v1", kind: "PodList", items: [pod] }; }),
  ];
  for (const response of malformed) {
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async () =>
        ({ status: 200, text: JSON.stringify(response) }) });
    await assert.rejects(client.listRunPods("run-1"), (error) =>
      error instanceof KubernetesResponseError && error.operation === "list-pods" &&
      error.status === 200 && !isTransientKubernetesError(error));
  }
});

test("malformed successful delete reads and replies are permanent delete response errors", async () => {
  for (const malformedDeleteReply of [false, true]) {
    const exact = existingResource(expected);
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async (method) => {
        if (method === "GET") return malformedDeleteReply
          ? { status: 200, text: JSON.stringify(exact) }
          : { status: 200, text: "not-json" };
        return { status: 202, text: "not-json" };
      } });
    await assert.rejects(client.delete(expected, digest, "persisted-uid",
      kubernetesResourceConfigurationDigest(expected, secretProofKey)), (error) =>
      error instanceof KubernetesResponseError && error.operation === "delete" &&
      error.status >= 200 && error.status < 300 && !isTransientKubernetesError(error));
  }
});

test("delete accepts only an identity-bound successful Status or exact deleted resource", async () => {
  const exact = existingResource(expected);
  const replies = [
    { apiVersion: "v1", kind: "Status", status: "Success", details: {
      kind: "secrets", name: expected.metadata.name, uid: "persisted-uid" } },
    exact,
  ];
  for (const reply of replies) {
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async (method) => method === "GET"
        ? { status: 200, text: JSON.stringify(exact) }
        : { status: 200, text: JSON.stringify(reply) } });
    await client.delete(expected, digest, "persisted-uid",
      kubernetesResourceConfigurationDigest(expected, secretProofKey));
  }

  const rejected = [
    { apiVersion: "v1", kind: "Status", status: "Failure", details: {
      kind: "secrets", name: expected.metadata.name, uid: "persisted-uid" } },
    { apiVersion: "v1", kind: "Status", status: "Success" },
    { apiVersion: "v1", kind: "Status", status: "Success", details: {
      kind: "jobs", name: expected.metadata.name, uid: "persisted-uid" } },
    { apiVersion: "v1", kind: "Status", status: "Success", details: {
      kind: "secrets", name: "foreign", uid: "persisted-uid" } },
    { apiVersion: "v1", kind: "Status", status: "Success", details: {
      kind: "secrets", name: expected.metadata.name, uid: "replacement-uid" } },
    { ...exact, metadata: { ...exact.metadata, namespace: "foreign" } },
    { ...exact, metadata: { ...exact.metadata, name: "foreign" } },
    { ...exact, metadata: { ...exact.metadata, uid: "replacement-uid" } },
  ];
  for (const reply of rejected) {
    const client = createInClusterKubernetesClient({ namespace: "agents-system", host: "unused",
      port: 443, token: "unused", ca: Buffer.alloc(0), request: async (method) => method === "GET"
        ? { status: 200, text: JSON.stringify(exact) }
        : { status: 202, text: JSON.stringify(reply) } });
    await assert.rejects(client.delete(expected, digest, "persisted-uid",
      kubernetesResourceConfigurationDigest(expected, secretProofKey)), (error) =>
      error instanceof KubernetesResponseError && error.operation === "delete" &&
      error.status === 202 && !isTransientKubernetesError(error));
  }
});
