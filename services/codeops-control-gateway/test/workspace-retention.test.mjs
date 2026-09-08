import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedCheckpointOperator } from "../dist/checkpoint-recovery.js";
import { nextWorkspaceReclamationStep, prepareWorkspaceRetention,
  reconcileWorkspaceRetention, workspaceRetentionMetrics } from "../dist/workspace-retention.js";
import { createWorkspaceRetentionResources } from "../dist/workspace-retention-resources.js";
import { createInClusterKubernetesClient, kubernetesResourceConfigurationDigest } from "../dist/kubernetes.js";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";

const uid = n => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const digest = `sha256:${"a".repeat(64)}`;
const resource = (kind, name, n) => ({ kind, name, uid: uid(n), configDigest: digest });
const target = { namespace: "test", sessionId: "ses_test", generation: 1,
  leaseId: uid(8), launchId: "launch-test", requestDigest: digest,
  job: resource("Job", "workspace-job", 1), pods: [resource("Pod", "workspace-pod", 2)],
  pvc: resource("PersistentVolumeClaim", "workspace-pvc", 3),
  pv: { name: "workspace-pv", uid: uid(4), driver: "csi.example", volumeHandle: "volume-1" } };
const capacity = { workspaceVolumes: 1, providerVolumes: 10, volumeQuota: 12, releasedPvs: 0 };
const inventory = overrides => ({ observedAt: "2026-09-07T12:00:00.000Z", capacity,
  jobs: [target.job], pods: target.pods, pvc: target.pvc, pv: target.pv,
  providerVolume: "present", pvcProtected: false, explicitKeep: false,
  successorAttached: false, ...overrides });

test("Job-first progression recomputes after crashes, duplicate and reordered observations", () => {
  const states = [inventory(), inventory({ jobs: [] }), inventory({ jobs: [], pods: [] }),
    inventory({ jobs: [], pods: [], pvc: null }),
    inventory({ jobs: [], pods: [], pvc: null, pv: null }),
    inventory({ jobs: [], pods: [], pvc: null, pv: null, providerVolume: "absent" })];
  const expected = ["Job", "Pod", "PersistentVolumeClaim", "wait", "wait", "complete"];
  // Crashes before delete repeat the same step; crashes after delete use the
  // next readback. Old event order never advances the observation.
  for (const index of [0, 0, 1, 1, 0, 2, 3, 3, 4, 5, 5]) {
    const result = nextWorkspaceReclamationStep(target, states[index]);
    assert.equal(result.type === "delete" ? result.resource.kind : result.type, expected[index]);
  }
});

for (const [label, patch] of [
  ["explicit keep", { explicitKeep: true }],
  ["successor attachment", { successorAttached: true }],
  ["unknown provider", { providerVolume: "unknown" }],
  ["Job replacement", { jobs: [{ ...target.job, uid: uid(9) }] }],
  ["PVC replacement", { pvc: { ...target.pvc, uid: uid(9) } }],
  ["PV replacement", { pv: { ...target.pv, uid: uid(9) } }],
  ["provider identity drift", { pv: { ...target.pv, volumeHandle: "other" } }],
  ["new Pod", { pods: [...target.pods, resource("Pod", "new", 9)] }],
  ["new Job", { jobs: [target.job, resource("Job", "new", 9)] }],
  ["missing hold readback", { explicitKeep: undefined }],
]) test(`preserves ${label} before every stage`, () => {
  for (const state of [inventory(), inventory({ jobs: [], pods: [] })]) {
    assert.throws(() => nextWorkspaceReclamationStep(target, { ...state, ...patch }));
  }
});

test("PVC protection and delayed provider disappearance never complete early", () => {
  assert.deepEqual(nextWorkspaceReclamationStep(target,
    inventory({ jobs: [], pods: [], pvcProtected: true })), { type: "wait", reason: "pvc-protection" });
  assert.deepEqual(nextWorkspaceReclamationStep(target,
    inventory({ jobs: [], pods: [], pvc: null, pv: null })), { type: "wait", reason: "provider-disappearance" });
});

function fixture() {
  const objects = new Map();
  const requests = [];
  const meta = r => ({ name: r.name, uid: r.uid, namespace: "test", resourceVersion: "7",
    labels: { "codeops.example/launch-id": target.launchId, "codeops.example/resource-role": "workspace-storage" },
    annotations: { "codeops.example/request-digest": digest, "codeops.example/resource-configuration-digest": digest } });
  const volumes = [{ name: "workspace", persistentVolumeClaim: { claimName: target.pvc.name } }];
  objects.set("apis/batch/v1/namespaces/test/jobs/workspace-job", {
    kind: "Job", metadata: meta(target.job), spec: { template: { spec: { volumes } } } });
  objects.set("api/v1/namespaces/test/pods/workspace-pod", { kind: "Pod",
    metadata: { ...meta(target.pods[0]), ownerReferences: [{ kind: "Job", name: target.job.name,
      uid: target.job.uid, controller: true }] }, spec: { volumes } });
  objects.set("api/v1/namespaces/test/persistentvolumeclaims/workspace-pvc", { kind: "PersistentVolumeClaim",
    metadata: { ...meta(target.pvc), finalizers: ["kubernetes.io/pvc-protection"] }, spec: { volumeName: target.pv.name } });
  objects.set("api/v1/persistentvolumes/workspace-pv", { kind: "PersistentVolume",
    metadata: { name: target.pv.name, uid: target.pv.uid }, spec: {
      persistentVolumeReclaimPolicy: "Delete", claimRef: { name: target.pvc.name, uid: target.pvc.uid, namespace: "test" },
      csi: { driver: target.pv.driver, volumeHandle: target.pv.volumeHandle } }, status: { phase: "Bound" } });
  let providerPresent = true;
  let truncate = false;
  const adapter = () => createWorkspaceRetentionResources({ namespace: "test",
    verifyOwned(raw, expectedTarget, expected) {
      assert.equal(raw.metadata.uid, expected.uid);
      assert.equal(raw.metadata.annotations["codeops.example/request-digest"], expectedTarget.requestDigest);
      assert.equal(raw.metadata.annotations["codeops.example/resource-configuration-digest"], expected.configDigest);
    },
    async get(path) {
      if (path.endsWith("?limit=1000")) {
        const prefix = path.split("?")[0] + "/";
        const kind = prefix.includes("/jobs/") ? "Job" : prefix.includes("/pods/") ? "Pod"
          : prefix.includes("/persistentvolumeclaims/") ? "PersistentVolumeClaim" : "PersistentVolume";
        return { apiVersion: kind === "Job" ? "batch/v1" : "v1", kind: `${kind}List`,
          metadata: { continue: truncate ? "more" : "" }, items: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)) };
      }
      return structuredClone(objects.get(path) ?? null);
    },
    async remove(path, options) {
      requests.push({ path, options });
      const current = objects.get(path);
      assert.equal(options.propagationPolicy, "Foreground");
      assert.deepEqual(options.preconditions, { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion });
      objects.delete(path);
    },
    async providerInventory() { return { observedAt: new Date().toISOString(), state: providerPresent ? "present" : "absent",
      providerVolumes: providerPresent ? 10 : 9, volumeQuota: 12 }; },
  });
  return { objects, requests, adapter, providerGone() { providerPresent = false; }, truncate() { truncate = true; } };
}

test("disposable synthetic lifecycle reclaims Job, Pod, PVC and verifies provider disappearance", async () => {
  const f = fixture();
  const before = await f.adapter().observe(target);
  for (const kind of ["Job", "Pod", "PersistentVolumeClaim"]) {
    // Recreate the adapter to simulate a process restart at every boundary.
    const adapter = f.adapter();
    const next = nextWorkspaceReclamationStep(target, await adapter.observe(target));
    assert.equal(next.resource.kind, kind);
    await adapter.deleteExact(target, next.resource);
  }
  assert.equal(nextWorkspaceReclamationStep(target, await f.adapter().observe(target)).type, "wait");
  f.objects.delete("api/v1/persistentvolumes/workspace-pv");
  assert.equal(nextWorkspaceReclamationStep(target, await f.adapter().observe(target)).type, "wait");
  f.providerGone();
  const after = await f.adapter().observe(target);
  assert.equal(nextWorkspaceReclamationStep(target, after).type, "complete");
  assert.equal(before.capacity.workspaceVolumes, 1);
  assert.equal(after.capacity.workspaceVolumes, 0);
  assert.equal(after.capacity.releasedPvs, 0);
  assert.equal(after.capacity.volumeQuota - after.capacity.providerVolumes, 3);
  assert.equal(f.requests.length, 3);
});

test("keep added between observation and deletion prevents all effects", async () => {
  const f = fixture();
  const next = nextWorkspaceReclamationStep(target, await f.adapter().observe(target));
  f.objects.get("api/v1/namespaces/test/persistentvolumeclaims/workspace-pvc").metadata.annotations["codeops.example/keep"] = "true";
  await assert.rejects(f.adapter().deleteExact(target, next.resource));
  assert.equal(f.requests.length, 0);
});

test("incomplete inventory fails closed", async () => {
  const f = fixture(); f.truncate();
  await assert.rejects(f.adapter().observe(target), /incomplete/);
  assert.equal(f.requests.length, 0);
});

test("receipt cannot substitute for authenticated operator authority", async () => {
  const forbidden = new Proxy({}, { get() { throw new Error("must not reach effects or database"); } });
  await assert.rejects(prepareWorkspaceRetention(forbidden, forbidden, { decisionId: uid(10), target, operator: {} }), /authenticated operator/);
  await assert.rejects(reconcileWorkspaceRetention(forbidden, forbidden, uid(10), {}), /authenticated operator/);
});

test("immutable completion replay after restart does not read or delete resources", async () => {
  const decision = { target, before: inventory(), authorityDigest: digest };
  const receipt = { completed: true, receiptId: uid(12), decisionId: uid(10),
    decisionDigest: sha256CanonicalJsonDigest(decision) };
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    return { rows: sql.includes("SELECT decision_json")
      ? [{ decision_json: decision, decision_digest: sha256CanonicalJsonDigest(decision) }]
      : sql.includes("SELECT receipt_json") ? [{ receipt_json: receipt,
        receipt_digest: sha256CanonicalJsonDigest(receipt) }] : [], rowCount: 1 };
  } };
  const operator = authenticatedCheckpointOperator({ token: "t".repeat(32),
    headers: { authorization: `Bearer ${"t".repeat(32)}`, "x-codeops-principal": "operator:test" } });
  const forbidden = { async observe() { throw new Error("unexpected observation"); }, async deleteExact() { throw new Error("unexpected deletion"); } };
  assert.deepEqual(await reconcileWorkspaceRetention(client, forbidden, uid(10), operator), receipt);
  assert.equal(queries.at(-1), "COMMIT");
});

test("capacity uses total provider allocation for quota headroom", async () => {
  const client = { async query() { return { rows: [{ eligible_retained: "4", stuck_deletions: "2" }], rowCount: 1 }; } };
  assert.deepEqual(await workspaceRetentionMetrics(client, capacity, 300), {
    workspaceVolumeCount: 1, quotaHeadroom: 2, eligibleRetainedCount: 4, stuckDeletionCount: 2, releasedPvs: 0,
  });
});

test("retry matrix consumes COAUTO25 disposition without granting a new retry", async () => {
  const { assertTerminalRetryDisposition } = await import("../dist/workspace-retention.js");
  const terminal = { version: "codeops.session-runtime-terminal-observation/v1",
    sessionId: target.sessionId, generation: target.generation, leaseId: target.leaseId, runId: "run-test",
    job: { name: target.job.name, uid: target.job.uid, resourceVersion: "7" }, pod: null,
    cause: { type: "failed", reason: "provider_timeout", message: null, exitCode: 1 },
    terminalAt: "2026-09-07T10:00:00.000Z", observedAt: "2026-09-07T10:00:01.000Z" };
  const request = { version: "codeops.work-item-retry-disposition/v1", dispositionId: uid(10),
    lineageRevision: 1, rootAdmissionId: uid(11), predecessorSessionId: target.sessionId,
    kind: "stop-terminal", reasonCode: "terminal", authority: {
      repository: "example/repo", provider: { kind: "plane", workspaceId: uid(12), projectId: uid(13) },
      workItemId: uid(14), workflowId: "workflow-test", runId: "run-test", sourceSha: "a".repeat(40),
      ownerPrincipalId: "operator:test", predecessorGeneration: target.generation,
      predecessorLeaseId: target.leaseId, expiresAt: "2026-09-07T11:00:00.000Z" },
    terminalObservation: terminal, providerEffect: { state: "none", preEffectProofDigest: digest, proofEventId: digest },
    budget: { rootBudgetId: "budget-test", rootRevision: 1, providerRequestsConsumed: 1, outputTokensConsumed: 10 },
    successor: null };
  assert.doesNotThrow(() => assertTerminalRetryDisposition(request, target));
  for (const kind of ["retry-same-input", "recover-checkpoint", "correct-candidate", "replan", "wait-external", "wait-human", "reconcile-unknown-effect"]) {
    assert.throws(() => assertTerminalRetryDisposition({ ...request, kind }, target));
  }
  for (const state of ["authorized", "attempting", "unknown"]) {
    assert.throws(() => assertTerminalRetryDisposition({ ...request,
      providerEffect: { state, effectId: `githubmutation-${"a".repeat(64)}`, receiptDigest: digest, failureCode: null } }, target));
  }
  for (const changed of [{ ...target, generation: 2 }, { ...target, leaseId: uid(99) },
    { ...target, sessionId: "ses_other" }, { ...target, job: { ...target.job, uid: uid(99) } }]) {
    assert.throws(() => assertTerminalRetryDisposition(request, changed));
  }
});


function composedInventory(mutate = () => {}) {
  const f = fixture();
  const exactTarget = structuredClone(target);
  const lists = new Map();
  for (const [path, raw] of f.objects) {
    raw.apiVersion = raw.kind === "Job" ? "batch/v1" : "v1";
    if (["Job", "PersistentVolumeClaim"].includes(raw.kind)) {
      const submitted = structuredClone(raw);
      // Hash submitted configuration, before the server assigns the PVC binding.
      if (raw.kind === "PersistentVolumeClaim") delete submitted.spec.volumeName;
      const config = kubernetesResourceConfigurationDigest(submitted);
      raw.metadata.annotations["codeops.example/resource-configuration-digest"] = config;
      exactTarget[raw.kind === "Job" ? "job" : "pvc"].configDigest = config;
    }
    const collection = path.slice(0, path.lastIndexOf("/"));
    const list = { apiVersion: raw.apiVersion, kind: `${raw.kind}List`, metadata: {}, items: [structuredClone(raw)] };
    delete list.items[0].apiVersion;
    delete list.items[0].kind;
    lists.set(collection, list);
  }
  exactTarget.pods[0].configDigest = exactTarget.job.configDigest;
  mutate(lists);
  const before = structuredClone(lists);
  const client = createInClusterKubernetesClient({ namespace: "test", host: "unused", port: 443,
    token: "synthetic-test-value", ca: Buffer.alloc(0), request: async (method, path) => {
      assert.equal(method, "GET");
      assert.ok(path.endsWith("?limit=1000"));
      return { status: 200, text: JSON.stringify(lists.get(path.split("?")[0])) };
    } });
  return { target: exactTarget, lists, before, adapter: client.workspaceRetentionResources(async () => ({
    observedAt: "2026-09-07T12:00:00.000Z", state: "present", providerVolumes: 10, volumeQuota: 12,
  })) };
}

test("retention composes typed list normalization with real Kubernetes ownership checks", async () => {
  const f = composedInventory();
  const observed = await f.adapter.observe(f.target);
  assert.deepEqual(observed.jobs, [f.target.job]);
  assert.deepEqual(observed.pvc, f.target.pvc);
  assert.equal(nextWorkspaceReclamationStep(f.target, observed).resource.kind, "Job");
  assert.deepEqual(f.lists, f.before);
});

for (const collection of ["apis/batch/v1/namespaces/test/jobs", "api/v1/namespaces/test/persistentvolumeclaims"]) {
  for (const [label, mutate] of [
    ["wrong list kind", l => { l.kind = "PodList"; }],
    ["wrong list version", l => { l.apiVersion = "foreign/v1"; }],
    ["explicit wrong item kind", l => { l.items[0].kind = "Pod"; }],
    ["explicit wrong item version", l => { l.items[0].apiVersion = "foreign/v1"; }],
    ["continued list", l => { l.metadata.continue = "more"; }],
    ["request digest drift", l => { l.items[0].metadata.annotations["codeops.example/request-digest"] = `sha256:${"b".repeat(64)}`; }],
    ["configuration digest drift", l => { l.items[0].metadata.annotations["codeops.example/resource-configuration-digest"] = `sha256:${"b".repeat(64)}`; }],
    ["namespace drift", l => { l.items[0].metadata.namespace = "foreign"; }],
  ]) test(`retention rejects ${label} in ${collection}`, async () => {
    const f = composedInventory(lists => mutate(lists.get(collection)));
    await assert.rejects(f.adapter.observe(f.target));
  });
  test(`retention refuses replacement UID from ${collection} before deletion`, async () => {
    const f = composedInventory(lists => { lists.get(collection).items[0].metadata.uid = uid(99); });
    const observed = await f.adapter.observe(f.target);
    assert.throws(() => nextWorkspaceReclamationStep(f.target, observed));
  });
}
