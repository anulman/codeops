import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJsonText } from "@codeops/codeops-contracts";
import {
  claimAdmittedChildMaterialization,
  releaseAdmittedChildMaterializationClaim,
  renewAdmittedChildMaterializationClaim,
  failAdmittedChildMaterialization,
  loadAdmittedChildMaterialization,
  AdmittedChildAuthorityDriftError,
  PermanentAdmittedChildMaterializationError,
  classifyAdmittedChildKubernetesError,
  reconcileAdmittedChildMaterialization,
} from "../dist/admitted-child-materialization-controller.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";
import { KubernetesApiError, KubernetesResponseError,
  kubernetesResourceConfigurationDigest } from "../dist/kubernetes.js";
import {
  admittedChildWorkspaceLaunchId,
  buildAdmittedChildCleanupResources,
  buildWorkspaceResources,
} from "../dist/workspace-resources.js";
import { kubernetesIdentityLabel } from "../dist/kubernetes.js";

const now = () => new Date("2026-09-02T10:01:00.000Z");
const secretProofKey = "stable-test-secret-proof-key-material";
const admissionId = "11111111-1111-4111-8111-111111111111";
const childSessionId = "session-child";
const policy = { version: "codeops.session-policy/v1", mode: "implement",
  workspaceAccess: "bounded-writes", modelCalls: "allowed",
  modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } };
const image = `registry.example/image@sha256:${"a".repeat(64)}`;
const snapshot = { version: "codeops.session-snapshot/v1", sessionId: childSessionId,
  generation: 1, state: "running", identity: { version: "codeops.session-workspace-identity/v1",
    policy, contextAttachments: [], workspace: { version: "codeops.workspace/v1", sources: [{
      catalogKey: "codeops", repository: "anulman/codeops", checkoutPath: "sources/codeops",
      requestedRef: "main", resolvedSha: "b".repeat(40) }], scratchPath: "scratch" },
    workflowId: "workflow-1", runId: "run-1", parentSessionId: "session-parent",
    forkedAtCursor: 2 }, lease: { leaseId: "22222222-2222-4222-8222-222222222222",
    generation: 1, status: "active", holderId: "runtime-worker:child",
    acquiredAt: "2026-09-02T10:00:00.000Z", expiresAt: "2026-09-02T11:00:00.000Z" },
  checkpoint: null, pendingPermission: null, eventCursor: 1,
  capabilities: sessionCapabilitiesFor("running", false),
  updatedAt: "2026-09-02T10:00:00.000Z" };
const input = { version: "codeops.admitted-child-materialization-input/v1", admissionId,
  admissionDigest: `sha256:${"1".repeat(64)}`, approvalId: "33333333-3333-4333-8333-333333333333",
  approvalDigest: `sha256:${"2".repeat(64)}`, parentSessionId: "session-parent", childSessionId,
  childDispatchId: "44444444-4444-4444-8444-444444444444", principalId: "user@example.com",
  workItem: { repository: "anulman/codeops", provider: { kind: "plane",
    workspaceId: "66666666-6666-4666-8666-666666666666",
    projectId: "77777777-7777-4777-8777-777777777777" },
    workItemId: "88888888-8888-4888-8888-888888888888", workflowId: "workflow-1", runId: "run-1",
    sourceSha: "b".repeat(40) }, source: snapshot.identity.workspace.sources[0], policy,
  profile: "custom", release: "v0.5.0-alpha.58", images: { agent: image, runtimeWorker: image },
  contextAttachments: [], generation: 1, lease: { leaseId: snapshot.lease.leaseId,
    holderId: snapshot.lease.holderId, acquiredAt: snapshot.lease.acquiredAt,
    expiresAt: snapshot.lease.expiresAt }, workflowId: "workflow-1",
  runId: "run-1", identity: snapshot.identity,
  initialDispatch: { version: "codeops.session-runtime-dispatch/v1",
    dispatchId: "44444444-4444-4444-8444-444444444444", principalId: "user@example.com",
    command: { version: "codeops.session-command/v1", sessionId: childSessionId, generation: 1,
      leaseId: snapshot.lease.leaseId, idempotencyKey: "55555555-5555-4555-8555-555555555555",
      type: "prompt", prompt: "Implement it." }, snapshot,
    dispatchedAt: "2026-09-02T10:00:00.000Z" }, admittedAt: "2026-09-02T10:00:00.000Z" };
const inputDigest = `sha256:${createHash("sha256").update(canonicalJsonText(input)).digest("hex")}`;
const initialDispatchDigest = `sha256:${createHash("sha256")
  .update(canonicalJsonText(input.initialDispatch)).digest("hex")}`;
const queued = { version: "codeops.admitted-child-materialization-state/v1", admissionId,
  inputDigest, state: "queued", resources: {}, attemptCount: 0,
  createdAt: input.admittedAt, updatedAt: input.admittedAt };
const owner = { admissionId, approvalId: input.approvalId,
  parentSessionId: input.parentSessionId, childDispatchId: input.childDispatchId,
  repository: input.workItem.repository, sourceSha: input.workItem.sourceSha,
  workItemId: input.workItem.workItemId, release: input.release, profile: input.profile };

function config() { return { namespace: "agents-system",
  launchId: admittedChildWorkspaceLaunchId(admissionId), principalId: input.principalId,
  requestDigest: inputDigest, sessionId: childSessionId, workflowId: input.workflowId, runId: input.runId,
  leaseId: input.lease.leaseId, holderId: input.lease.holderId, generation: 1, policy,
  contextAttachments: [], identity: snapshot.identity, workspace: snapshot.identity.workspace,
  sources: [{ catalogKey: "codeops", repositoryUrl: "https://github.com/anulman/codeops",
    readToken: "token-long-enough" }], agentImage: image, runtimeWorkerImage: image,
  imagePullSecrets: [], nodeSelector: {}, runtimeServiceAccountName: "runtime",
  sessionSecretsName: "session-secrets", sessionGatewayOrigin: "http://session-gateway:8080",
  modelProxyOrigin: "http://model-proxy:8080", modelProxyServiceName: "model-proxy",
  modelProxyPodName: "model-proxy-pods", workspaceStorageSize: "10Gi",
  admittedChildOwner: owner }; }

function cleanupResources() { return buildAdmittedChildCleanupResources({
  namespace: "agents-system", admissionId, requestDigest: inputDigest, owner,
}); }

function boundState(value) {
  if (value.state === "queued" || Object.keys(value.resources).length > 0) return value;
  const resources = buildWorkspaceResources(config());
  const keys = { "source-authority": "sourceAuthority", "workspace-storage": "workspaceStorage",
    "source-materializer": "sourceMaterializer", "workspace-runtime": "workspaceRuntime" };
  const bindings = {};
  for (const resource of resources) {
    const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
    if (resourceRole === "workspace-runtime" && value.state === "provisioning") continue;
    bindings[keys[resourceRole]] = { uid: `uid:${resourceRole}`,
      configDigest: kubernetesResourceConfigurationDigest(resource,
        resource.kind === "Secret" ? secretProofKey : undefined) };
  }
  return { ...value, resources: bindings };
}

function harness(options = {}) { let state = boundState(options.state ?? queued); const effects = [];
  const resourceUids = new Map();
  const materializationInput = options.input ?? input;
  const storedInputDigest = options.inputDigest ?? `sha256:${createHash("sha256")
    .update(canonicalJsonText(materializationInput)).digest("hex")}`;
  const storedDispatchDigest = options.initialDispatchDigest ?? `sha256:${createHash("sha256")
    .update(canonicalJsonText(materializationInput.initialDispatch)).digest("hex")}`;
  const dependencies = { load: async () => ({ input: materializationInput, state,
      inputDigest: storedInputDigest, authorityCurrent: options.authorityCurrent ?? true,
      initialDispatchDigest: storedDispatchDigest,
      duplicateOwner: options.duplicateOwner ?? false }),
    update: async (next) => (state = next),
    ensureResource: async (resource, _identity, expectedUid, _states, expectedConfigDigest) => { const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
      effects.push(`${expectedUid === undefined ? "create" : "get"}:${resourceRole}`);
      if (options.drift && resource.kind === "PersistentVolumeClaim") throw new PermanentAdmittedChildMaterializationError("drift");
      const uid = expectedUid ?? `uid:${resourceRole}`;
      resourceUids.set(resource.metadata.name, uid);
      return { uid,
        configDigest: expectedConfigDigest ?? kubernetesResourceConfigurationDigest(resource,
          resource.kind === "Secret" ? secretProofKey : undefined) };
    },
    loadJob: async (resource) => resource.metadata.name.endsWith("-materialize")
      ? (options.materializer ?? { status: { succeeded: 1 } })
      : (options.runtime ?? { status: { active: 1 } }),
    listRuntimePods: async () => options.pods ?? [{ metadata: { labels: { "job-name":
      `workspace-${admissionId.replaceAll("-", "")}`,
      "codeops.example/session-id": kubernetesIdentityLabel(childSessionId),
      "codeops.example/run-id": kubernetesIdentityLabel(input.runId) },
      ownerReferences: [{ kind: "Job", name:
        `workspace-${admissionId.replaceAll("-", "")}`,
      uid: "uid:workspace-runtime", controller: true }] }, status: {
      conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{
        name: "runtime-worker", ready: true, state: { running: {} } }] } }],
    removeResource: async (resource) => {
      const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
      if (options.cleanupErrorRole === resourceRole) throw options.cleanupError;
      if (options.foreignOwner === resourceRole) {
        effects.push(`reject-delete:${resourceRole}`);
        throw new PermanentAdmittedChildMaterializationError("foreign owner");
      }
      effects.push(`delete:${resourceRole}`);
      options.onRemove?.(structuredClone(state), resource);
      if (!options.asyncDeletion) resourceUids.delete(resource.metadata.name);
    },
    recoverResource: async (resource) => {
      const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
      if (!options.recovered?.includes(resourceRole)) return null;
      if (resourceRole === "source-authority" &&
          effects.includes("delete:source-authority")) {
        if (!options.replacementRace) return null;
        const configDigest = kubernetesResourceConfigurationDigest(resource, secretProofKey);
        return { uid: "replacement-uid", configDigest,
          matchesExpectedConfiguration: true, desiredConfigDigest: configDigest };
      }
      effects.push(`recover:${resourceRole}`);
      const uid = `uid:${resourceRole}`;
      resourceUids.set(options.recoveredResourceName ?? resource.metadata.name, uid);
      return { uid, configDigest: `sha256:${"e".repeat(64)}`,
        ...(options.recoveredResourceName === undefined ? {} : {
          resourceName: options.recoveredResourceName,
        }), matchesExpectedConfiguration: options.recoveryMatches ?? true,
        ...((options.recoveryMatches ?? true) ? {} : {
          desiredConfigDigest: kubernetesResourceConfigurationDigest(resource, secretProofKey),
        }) };
    },
    readResourceUid: async (resource) => options.deletionComplete
      ? null : options.replacementRace && effects.includes("delete:source-authority")
        ? "replacement-uid" : resourceUids.get(resource.metadata.name) ?? null,
    resourceConfig: options.resourceConfigError === undefined ? config : () => {
      throw options.resourceConfigError;
    },
    markSuccessFinalizing: async (next) => (state = next),
    markReady: async (next) => (state = next),
    markFailed: async (next) => (state = next),
    cleanupResources, now: options.now ?? now, timeoutMs: 1_800_000 };
  return { dependencies, effects, state: () => state }; }

test("rejects initial dispatch digest drift before materialization effects", async () => {
  const run = harness({ initialDispatchDigest: `sha256:${"f".repeat(64)}` });
  await assert.rejects(reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies), /materialization digest drifted/);
  assert.deepEqual(run.effects, []);
});

test("creates in fixed order and converges across crash replay and duplicate reconciliation", async () => {
  const run = harness({ materializer: { status: { active: 1 } } });
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state, "provisioning");
  assert.deepEqual(run.effects, ["create:source-authority", "create:workspace-storage",
    "create:source-materializer", "get:source-authority", "get:workspace-storage",
    "get:source-materializer"]);
  await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(run.effects.filter((item) => item.startsWith("create:")).length, 3);
  run.dependencies.loadJob = async (resource) => resource.metadata.name.endsWith("-materialize")
    ? { status: { succeeded: 1 } } : { status: { active: 1 } };
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state, "ready");
  assert.deepEqual(run.effects.slice(-3), ["get:workspace-runtime", "delete:source-authority", "delete:source-materializer"]);
  await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(run.effects.filter((item) => item === "create:workspace-runtime").length, 1);
});

test("binds a recovered Agent Secret before deleting and recreating its stable identity", async () => {
  const legacyName = `workspace-${admissionId.replaceAll("-", "")}-source-0123456789`;
  const run = harness({ recovered: ["source-authority"], recoveryMatches: false,
    recoveredResourceName: legacyName, materializer: { status: { active: 1 } } });
  await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.deepEqual(run.effects.slice(0, 3), ["recover:source-authority",
    "delete:source-authority", "create:source-authority"]);
  assert.equal(run.state().resources.sourceAuthority.uid, "uid:source-authority");
  assert.equal(run.state().resources.sourceAuthority.resourceName, undefined);
});

test("persists admitted-child replacement intent before deletion and replays termination", async () => {
  const legacyName = `workspace-${admissionId.replaceAll("-", "")}-source-0123456789`;
  let deletionState;
  const options = { recovered: ["source-authority"], recoveryMatches: false,
    recoveredResourceName: legacyName, materializer: { status: { active: 1 } },
    asyncDeletion: true, deletionComplete: false,
    onRemove: (state) => { deletionState = state; } };
  const run = harness(options);
  const pending = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(pending.state, "queued");
  assert.deepEqual(deletionState.resourceReplacements.sourceAuthority, {
    uid: "uid:source-authority", resourceName: legacyName,
    configDigest: `sha256:${"e".repeat(64)}`,
    desiredConfigDigest: kubernetesResourceConfigurationDigest(
      buildWorkspaceResources(config()).find((resource) =>
        resource.metadata.labels["codeops.example/resource-role"] === "source-authority"),
      secretProofKey),
  });
  assert.equal(run.effects.filter((effect) => effect === "delete:source-authority").length, 1);
  options.deletionComplete = true;
  const replayed = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(replayed.state, "provisioning");
  assert.equal(run.effects.filter((effect) => effect === "delete:source-authority").length, 1);
  assert.equal(replayed.resourceReplacements.sourceAuthority, undefined);
  assert.equal(replayed.resources.sourceAuthority.resourceName, undefined);
});

test("admitted-child replacement-race replay binds the new Secret without deleting it", async () => {
  const run = harness({ recovered: ["source-authority"], recoveryMatches: false,
    replacementRace: true, materializer: { status: { active: 1 } } });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "provisioning");
  assert.equal(run.effects.filter((effect) => effect === "delete:source-authority").length, 1);
  assert.equal(result.resources.sourceAuthority.uid, "replacement-uid");
  assert.equal(result.resourceReplacements.sourceAuthority, undefined);
});

test("retains an exact ensure result locally when binding persistence reports failure", async () => {
  const run = harness();
  const update = run.dependencies.update;
  let failOnce = true;
  run.dependencies.update = async (next) => {
    if (failOnce && next.resources.sourceAuthority !== undefined) {
      failOnce = false;
      throw new Error("binding persistence result was lost");
    }
    return update(next);
  };
  const first = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(first.state, "queued");
  assert.deepEqual(first.resources.sourceAuthority, {
    uid: "uid:source-authority",
    configDigest: kubernetesResourceConfigurationDigest(
      buildWorkspaceResources(config()).find((resource) =>
        resource.metadata.labels["codeops.example/resource-role"] === "source-authority"),
      secretProofKey,
    ),
  });
  assert.equal((await reconcileAdmittedChildMaterialization(
    admissionId, run.dependencies)).state, "ready");
});

test("retries runtime creation without deleting the completed materializer", async () => {
  const run = harness();
  const ensure = run.dependencies.ensureResource;
  let failRuntimeOnce = true;
  run.dependencies.ensureResource = async (resource, ...rest) => {
    if (resource.metadata.labels["codeops.example/resource-role"] === "workspace-runtime" &&
        failRuntimeOnce) {
      failRuntimeOnce = false;
      run.effects.push("fail:workspace-runtime");
      throw new Error("transient runtime creation failure");
    }
    return ensure(resource, ...rest);
  };
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "runtime-authorized");
  assert.equal(run.effects.includes("delete:source-materializer"), false);
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "ready");
  assert.equal(run.effects.filter((item) => item === "create:workspace-runtime").length, 1);
  assert.deepEqual(run.effects.slice(-3),
    ["get:workspace-runtime", "delete:source-authority", "delete:source-materializer"]);
});

test("replays authorized runtime creation and health-check before cleanup", async () => {
  let runtimeHealthChecks = 0;
  const run = harness({ state: { ...queued, state: "runtime-authorized" } });
  const loadJob = run.dependencies.loadJob;
  run.dependencies.loadJob = async (resource, ...rest) => {
    if (!resource.metadata.name.endsWith("-materialize")) runtimeHealthChecks += 1;
    return loadJob(resource, ...rest);
  };
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "ready");
  assert.deepEqual(run.effects.slice(-3),
    ["get:workspace-runtime", "delete:source-authority", "delete:source-materializer"]);
  assert.equal(run.effects.includes("create:workspace-runtime"), false);
  assert.equal(runtimeHealthChecks, 4);
});

test("does not delete bootstrap resources before success finalization is durable", async () => {
  const run = harness({ state: { ...queued, state: "runtime-authorized" } });
  const mark = run.dependencies.markSuccessFinalizing;
  let loseFinalizationUpdate = true;
  run.dependencies.markSuccessFinalizing = async (next) => {
    if (loseFinalizationUpdate) {
      loseFinalizationUpdate = false;
      throw new Error("crash before success finalization commit");
    }
    return mark(next);
  };
  const interrupted = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(interrupted.state, "runtime-authorized");
  assert.equal(run.effects.some((item) => item.startsWith("delete:")), false);
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "ready");
});

for (const crashRole of ["source-authority", "source-materializer"]) {
  test(`replays forward after a crash following ${crashRole} deletion`, async () => {
    const run = harness({ state: { ...queued, state: "runtime-authorized" } });
    const remove = run.dependencies.removeResource;
    const deleted = new Set();
    let crash = true;
    run.dependencies.removeResource = async (resource, identity, uid, configDigest, states) => {
      const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
      assert.deepEqual(states, ["success-finalizing"]);
      assert.equal(uid, `uid:${resourceRole}`);
      assert.match(configDigest, /^sha256:[0-9a-f]{64}$/);
      if (deleted.has(resourceRole)) {
        run.effects.push(`not-found:${resourceRole}`);
        return;
      }
      await remove(resource, identity, uid, configDigest, states);
      deleted.add(resourceRole);
      if (resourceRole === crashRole && crash) {
        crash = false;
        throw new Error("crash after successful deletion");
      }
    };
    const interrupted = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
    assert.equal(interrupted.state, "success-finalizing");
    assert.equal("failureCode" in interrupted, false);
    const ready = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
    assert.equal(ready.state, "ready");
    assert.equal(run.effects.includes(`not-found:${crashRole}`), true);
  });
}

test("replays forward after cleanup completes immediately before the ready write", async () => {
  const run = harness({ state: { ...queued, state: "runtime-authorized" } });
  const ready = run.dependencies.markReady;
  let crash = true;
  run.dependencies.markReady = async (next) => {
    if (crash) { crash = false; throw new Error("crash before ready commit"); }
    return ready(next);
  };
  const interrupted = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(interrupted.state, "success-finalizing");
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "ready");
});

test("success finalization retries a transient Kubernetes crash", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing });
  const loadJob = run.dependencies.loadJob;
  let crash = true;
  run.dependencies.loadJob = async (...args) => {
    if (crash) { crash = false; throw new Error("transient Kubernetes read failure"); }
    return loadJob(...args);
  };
  const interrupted = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(interrupted.state, "success-finalizing");
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies)).state, "ready");
});

test("success finalization bounds repeated transient Kubernetes failures by the durable timeout", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: "2026-09-02T10:01:00.000Z" };
  const run = harness({ state: finalizing,
    now: () => new Date("2026-09-02T10:31:00.000Z") });
  run.dependencies.loadJob = async () => { throw new Error("Kubernetes remains unavailable"); };
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-timeout");
});

test("success finalization retries absent and temporarily unready Pods until ready", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing, pods: [] });
  const transient = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(transient.state, "success-finalizing");
  assert.equal("failureCode" in transient, false);
  run.dependencies.listRuntimePods = harness().dependencies.listRuntimePods;
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies)).state, "ready");
});

test("recovers and removes an exactly owned Secret and runtime from the pre-binding crash window", async () => {
  const run = harness({ authorityCurrent: false,
    recovered: ["source-authority", "workspace-runtime"] });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "authority-drift");
  assert.equal(run.effects.includes("recover:source-authority"), true);
  assert.equal(run.effects.includes("recover:workspace-runtime"), true);
  assert.equal(run.effects.includes("delete:source-authority"), true);
  assert.equal(run.effects.includes("delete:workspace-runtime"), true);
});

test("success finalization fails closed when concurrent terminal reconciliation removes authority", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing });
  run.dependencies.loadJob = async () => {
    throw new AdmittedChildAuthorityDriftError("concurrent terminal reconciliation");
  };
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "authority-drift");
  assert.equal(run.effects.includes("delete:workspace-runtime"), true);
});

test("success finalization fails closed on permanent Kubernetes ownership drift", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing });
  run.dependencies.loadJob = async () => {
    throw new PermanentAdmittedChildMaterializationError("permanent ownership drift");
  };
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "identity-conflict");
});

test("re-fences the exact runtime Job and ready Pod after every success cleanup boundary", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing });
  const sequence = [];
  const loadJob = run.dependencies.loadJob;
  run.dependencies.loadJob = async (...args) => {
    sequence.push("job"); return loadJob(...args);
  };
  const listPods = run.dependencies.listRuntimePods;
  run.dependencies.listRuntimePods = async (...args) => {
    sequence.push("pod"); return listPods(...args);
  };
  const remove = run.dependencies.removeResource;
  run.dependencies.removeResource = async (resource, ...args) => {
    sequence.push(`delete:${resource.metadata.labels["codeops.example/resource-role"]}`);
    return remove(resource, ...args);
  };
  const ready = run.dependencies.markReady;
  run.dependencies.markReady = async (state) => {
    sequence.push("ready"); return ready(state);
  };
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies)).state, "ready");
  assert.deepEqual(sequence, ["delete:source-authority", "job", "pod",
    "delete:source-materializer", "job", "pod", "job", "pod", "ready"]);
});

test("replay fences a persisted source Secret without reconstructing rotated credentials", async () => {
  const run = harness({ state: { ...queued, state: "provisioning" } });
  run.dependencies.resourceConfig = () => ({ ...config(), sources: [{
    ...config().sources[0], readToken: "rotated-repository-token",
  }] });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "ready");
});

for (const [evidence, options] of [
  ["terminal Job", { runtime: { status: { failed: 1 } } }],
  ["permanently unready Pod", { pods: [{ metadata: { labels: { "job-name":
    `workspace-${admissionId.replaceAll("-", "")}`,
    "codeops.example/session-id": kubernetesIdentityLabel(childSessionId),
    "codeops.example/run-id": kubernetesIdentityLabel(input.runId) }, ownerReferences: [{
      kind: "Job", name: `workspace-${admissionId.replaceAll("-", "")}`,
      uid: "uid:workspace-runtime", controller: true }] }, status: { phase: "Failed",
      containerStatuses: [{ name: "runtime-worker", ready: false,
        state: { terminated: { exitCode: 1 } } }] } }] }],
]) test(`success finalization converges through cleanup on ${evidence}`, async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ ...options, state: finalizing });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-failed");
  assert.deepEqual(run.effects.filter((item) => item.startsWith("delete:")),
    ["delete:source-authority", "delete:workspace-runtime",
      "delete:source-authority", "delete:source-materializer"]);
});

test("success finalization never reclassifies or deletes a foreign binding", async () => {
  const finalizing = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "success-finalizing", finalizingAt: now().toISOString() };
  const run = harness({ state: finalizing, authorityCurrent: false,
    foreignOwner: "source-authority" });
  let runtimeReads = 0;
  run.dependencies.loadJob = async () => { runtimeReads += 1; return { status: { failed: 1 } }; };
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "identity-conflict");
  assert.deepEqual(result.cleanupResiduals, [{ resourceRole: "source-authority",
    reason: "immutable-identity-drift" }]);
  assert.equal(run.effects.includes("reject-delete:source-authority"), true);
  assert.equal(run.effects.includes("delete:source-authority"), false);
  assert.equal(runtimeReads, 0);
});

test("readiness requires the runtime-worker container from the generated Job", async () => {
  const run = harness({ state: { ...queued, state: "runtime-authorized" } });
  const list = run.dependencies.listRuntimePods;
  run.dependencies.listRuntimePods = async (...args) => (await list(...args)).map((pod) => ({
    ...pod, status: { ...pod.status, containerStatuses: pod.status.containerStatuses.map(
      (container) => ({ ...container, name: "session-runtime-worker" }),
    ) },
  }));
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "runtime-authorized");
  assert.equal(run.effects.some((item) => item.startsWith("delete:")), false);
});

for (const [description, status] of [
  ["terminated runtime-worker container", { phase: "Running", containerStatuses: [{
    name: "runtime-worker", ready: false, state: { terminated: { exitCode: 1 } },
  }] }],
  ["Failed Pod phase", { phase: "Failed", containerStatuses: [{
    name: "runtime-worker", ready: false, state: { waiting: { reason: "Error" } },
  }] }],
]) test(`runtime-authorized terminalizes an exact owned ${description}`, async () => {
  const readyPod = (await harness().dependencies.listRuntimePods())[0];
  const run = harness({ state: { ...queued, state: "runtime-authorized" },
    pods: [{ ...readyPod, status }] });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-failed");
});

for (const [description, pods] of [
  ["absent Pod", []],
  ["Pending Pod", [{ metadata: { labels: { "job-name":
    `workspace-${admissionId.replaceAll("-", "")}`,
    "codeops.example/session-id": kubernetesIdentityLabel(childSessionId),
    "codeops.example/run-id": kubernetesIdentityLabel(input.runId) }, ownerReferences: [{
      kind: "Job", name: `workspace-${admissionId.replaceAll("-", "")}`,
      uid: "uid:workspace-runtime", controller: true }] }, status: { phase: "Pending",
      containerStatuses: [{ name: "runtime-worker", ready: false,
        state: { waiting: { reason: "ContainerCreating" } } }] } }]],
]) test(`runtime-authorized waits for an ${description}`, async () => {
  const run = harness({ state: { ...queued, state: "runtime-authorized" }, pods });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "runtime-authorized");
  assert.equal(run.effects.some((item) => item.startsWith("delete:")), false);
});

test("runtime-authorized advances when a Pending Pod eventually becomes Ready", async () => {
  const readyPods = await harness().dependencies.listRuntimePods();
  const run = harness({ state: { ...queued, state: "runtime-authorized" }, pods: [] });
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies)).state, "runtime-authorized");
  run.dependencies.listRuntimePods = async () => readyPods;
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId,
    run.dependencies)).state, "ready");
});

for (const resourceRole of ["source-authority", "workspace-storage",
  "source-materializer", "workspace-runtime"]) {
  test(`revalidates persisted ${resourceRole} UID before consuming later status`, async () => {
    const phase = resourceRole === "workspace-runtime" ? "runtime-authorized" : "provisioning";
    const run = harness({ state: { ...queued, state: phase } });
    const ensure = run.dependencies.ensureResource;
    let statusReads = 0;
    run.dependencies.ensureResource = async (resource, ...rest) => {
      const binding = await ensure(resource, ...rest);
      return resource.metadata.labels["codeops.example/resource-role"] === resourceRole
        ? { ...binding, uid: "replacement-uid" } : binding;
    };
    const load = run.dependencies.loadJob;
    run.dependencies.loadJob = async (...args) => { statusReads += 1; return load(...args); };
    const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
    assert.equal(result.state, "failed");
    assert.equal(result.failureCode, "identity-conflict");
    assert.equal(statusReads, 0);
  });
}

test("rejects persisted immutable configuration drift before Job status consumption", async () => {
  const state = boundState({ ...queued, state: "provisioning" });
  state.resources.sourceMaterializer.configDigest = `sha256:${"f".repeat(64)}`;
  const run = harness({ state });
  let statusReads = 0;
  run.dependencies.loadJob = async () => { statusReads += 1; return { status: { succeeded: 1 } }; };
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.failureCode, "identity-conflict");
  assert.equal(statusReads, 0);
});

test("does not create the runtime Job before authorization is durable", async () => {
  const run = harness({ state: { ...queued, state: "provisioning" } });
  const update = run.dependencies.update;
  const ensure = run.dependencies.ensureResource;
  let loseRuntimeAuthorizedUpdate = true;
  let runtimeEnsureCalls = 0;
  run.dependencies.ensureResource = async (resource, ...rest) => {
    if (resource.metadata.labels["codeops.example/resource-role"] !== "workspace-runtime") {
      return ensure(resource, ...rest);
    }
    if (rest[1] === undefined) runtimeEnsureCalls += 1;
    return ensure(resource, ...rest);
  };
  run.dependencies.update = async (next) => {
    if (next.state === "runtime-authorized" && loseRuntimeAuthorizedUpdate) {
      loseRuntimeAuthorizedUpdate = false;
      throw new Error("crash before runtime authorization");
    }
    return update(next);
  };
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "provisioning");
  assert.equal(runtimeEnsureCalls, 0);
  assert.equal((await reconcileAdmittedChildMaterialization(admissionId, run.dependencies)).state,
    "ready");
  assert.equal(runtimeEnsureCalls, 1);
});

for (const transientRole of ["source-authority", "source-materializer", "workspace-runtime"]) {
  test(`retries terminal cleanup after transient ${transientRole} deletion failure`, async () => {
    const run = harness({ state: { ...queued,
      state: transientRole === "workspace-runtime" ? "runtime-authorized" : "provisioning" },
      materializer: { status: { failed: 1 } },
      ...(transientRole === "workspace-runtime" ? { runtime: { status: { failed: 1 } } } : {}) });
    const remove = run.dependencies.removeResource;
    let failOnce = true;
    run.dependencies.removeResource = async (resource) => {
      const resourceRole = resource.metadata.labels["codeops.example/resource-role"];
      if (resourceRole === transientRole && failOnce) {
        failOnce = false;
        run.effects.push(`fail-delete:${resourceRole}`);
        throw new Error("transient deletion failure");
      }
      return remove(resource);
    };
    await assert.rejects(reconcileAdmittedChildMaterialization(admissionId, run.dependencies),
      /transient deletion failure/);
    assert.equal(run.state().state, "cleanup-pending");
    assert.equal(run.effects.includes("delete:source-authority") ||
      run.effects.includes("fail-delete:source-authority"), true);
    assert.equal(run.effects.includes("delete:source-materializer") ||
      run.effects.includes("fail-delete:source-materializer"), true);
    const failed = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
    assert.equal(failed.state, "failed");
    assert.equal(run.effects.includes(`delete:${transientRole}`), true);
  });
}

for (const [name, options, code, deleted] of [
  ["duplicate ownership", { duplicateOwner: true }, "authority-drift", []],
  ["missing attachment bytes", { input: { ...input, contextAttachments: [{
    attachmentId: "context", name: "context.txt", mimeType: "text/plain", sizeBytes: 1,
    digest: `sha256:${"0".repeat(64)}`, content: "YQ==" }] } }, "authority-drift", []],
  ["identity drift", { drift: true }, "identity-conflict", ["delete:source-authority"]],
  ["failed materializer", { state: { ...queued, state: "provisioning" }, materializer: { status: { failed: 1 } } }, "provisioning-failed", ["delete:source-authority", "delete:source-materializer"]],
  ["runtime completion before readiness", { state: { ...queued, state: "runtime-authorized" },
    runtime: { status: { succeeded: 1 } } }, "provisioning-failed",
  ["delete:workspace-runtime", "delete:source-authority", "delete:source-materializer"]],
  ["provisioning timeout", { state: { ...queued, state: "provisioning" }, now: () => new Date("2026-09-02T10:31:00.000Z") }, "provisioning-timeout", ["delete:source-authority", "delete:source-materializer"]],
]) test(`fails closed on ${name} and cleans both bootstrap resources`, async () => {
  const run = harness(options); const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.failureCode, code); assert.deepEqual(
    run.effects.filter((item) => item.startsWith("delete:")), deleted);
});

test("resource configuration failure leaves a terminal row after immutable cleanup", async () => {
  const run = harness({ resourceConfigError: new Error("repository authority drift") });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "resource-configuration");
  assert.deepEqual(run.effects, []);
});

test("permanent Kubernetes cleanup failures terminalize with bounded residual evidence", async () => {
  const failure = classifyAdmittedChildKubernetesError(
    new KubernetesApiError("delete", 403));
  assert.equal(failure instanceof PermanentAdmittedChildMaterializationError, true);
  const run = harness({ state: { ...queued, state: "runtime-authorized" },
    runtime: { status: { failed: 1 } }, cleanupErrorRole: "workspace-runtime",
    cleanupError: failure });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.cleanupResiduals, [{ resourceRole: "workspace-runtime",
    reason: "kubernetes-permanent-failure", operation: "delete", status: 403 }]);
});

test("malformed successful cleanup responses terminalize with bounded residual evidence", async () => {
  const failure = classifyAdmittedChildKubernetesError(
    new KubernetesResponseError("delete", 202));
  const run = harness({ state: { ...queued, state: "runtime-authorized" },
    runtime: { status: { failed: 1 } }, cleanupErrorRole: "source-authority",
    cleanupError: failure });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.cleanupResiduals, [{ resourceRole: "source-authority",
    reason: "kubernetes-permanent-failure", operation: "delete", status: 202 }]);
});

test("cleanup converges when its diagnostic retry counter is at the schema ceiling", async () => {
  const run = harness({ state: { ...queued, state: "cleanup-pending",
    failureCode: "provisioning-failed", failedAt: now().toISOString(), attemptCount: 100_000 } });
  const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.attemptCount, 100_000);
  assert.deepEqual(run.effects.filter((item) => item.startsWith("delete:")),
    ["delete:workspace-runtime", "delete:source-authority", "delete:source-materializer"]);
});

test("transient Kubernetes cleanup failures remain retryable", async () => {
  const failure = new KubernetesApiError("delete", 503);
  assert.equal(classifyAdmittedChildKubernetesError(failure), failure);
  const run = harness({ state: { ...queued, state: "runtime-authorized" },
    runtime: { status: { failed: 1 } }, cleanupErrorRole: "workspace-runtime",
    cleanupError: failure });
  await assert.rejects(reconcileAdmittedChildMaterialization(admissionId, run.dependencies),
    KubernetesApiError);
  assert.equal(run.state().state, "cleanup-pending");
});

for (const foreignRole of ["source-authority", "source-materializer", "workspace-runtime"]) {
  test(`foreign ${foreignRole} cleanup identity is terminal and is never deleted`, async () => {
    const run = harness({ state: { ...queued, state: "runtime-authorized" },
      runtime: { status: { failed: 1 } }, foreignOwner: foreignRole });
    const result = await reconcileAdmittedChildMaterialization(admissionId, run.dependencies);
    assert.equal(result.state, "failed");
    assert.deepEqual(result.cleanupResiduals, [{ resourceRole: foreignRole,
      reason: "immutable-identity-drift" }]);
    assert.equal(run.effects.includes(`delete:${foreignRole}`), false);
    assert.equal(run.effects.includes(`reject-delete:${foreignRole}`), true);
  });
}

test("active scan claims only the oldest row and rotates attempted cleanup", async () => {
  const client = { async query(text) {
    assert.match(text, /'cleanup-pending'/);
    assert.match(text, /'success-finalizing'/);
    assert.match(text, /ORDER BY updated_at,admission_id LIMIT 1/);
    assert.match(text, /date_trunc\('milliseconds',CURRENT_TIMESTAMP\)/);
    assert.match(text, /YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"/);
    return { rowCount: 1, rows: [{ admission_id: "later", reconciliation_token:
      "00000000-0000-4000-8000-000000000000" }] };
  } };
  assert.deepEqual(await claimAdmittedChildMaterialization(client), { admissionId: "later",
    token: "00000000-0000-4000-8000-000000000000" });
});

test("durable scan claim excludes live foreign controllers and returns a fencing token", async () => {
  const client = { async query(text, values) {
    assert.match(text, /reconciliation_expires_at<=CURRENT_TIMESTAMP/);
    assert.doesNotMatch(text, /OR\s+reconciliation_owner=\$1/);
    assert.match(text, /reconciliation_token=\$2::uuid/);
    assert.deepEqual(values, ["controller-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 30000]);
    return { rowCount: 1, rows: [{ admission_id: admissionId,
      reconciliation_token: values[1] }] };
  } };
  assert.deepEqual(await claimAdmittedChildMaterialization(client, "controller-a",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), { admissionId,
    token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
});

test("claim renewal is owner- and token-fenced and extends one live claim", async () => {
  const client = { async query(text, values) {
    assert.match(text, /reconciliation_owner=\$2/);
    assert.match(text, /reconciliation_token=\$3::uuid/);
    assert.match(text, /reconciliation_expires_at>CURRENT_TIMESTAMP/);
    assert.deepEqual(values, [admissionId, "controller-a",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 120000]);
    return { rowCount: 1, rows: [] };
  } };
  await renewAdmittedChildMaterializationClaim(client, admissionId, "controller-a",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 120000);
});

test("claim release is token-fenced and cannot clear a terminal or replacement claim", async () => {
  const calls = [];
  const client = { async query(text, values) {
    calls.push({ text, values }); return { rowCount: 1, rows: [] };
  } };
  await releaseAdmittedChildMaterializationClaim(client, admissionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.match(calls[0].text, /reconciliation_token=\$2::uuid/);
  assert.match(calls[0].text, /state IN\s*\('queued','provisioning','runtime-authorized','success-finalizing','cleanup-pending'\)/);
  assert.deepEqual(calls[0].values, [admissionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
});

test("authority query requires the exact active admitted child lease", async () => {
  const client = { async query(text) {
    for (const required of ["state' IN ('running','waiting_permission','checkpointing')",
      "status'='active'", "leaseId", "generation", "holderId",
      "expiresAt", "CURRENT_TIMESTAMP <"]) assert.equal(text.includes(required), true);
    return { rowCount: 1, rows: [{ input_json: input, state_json: queued,
      input_digest: inputDigest, initial_dispatch_digest: initialDispatchDigest,
      authority_current: true, duplicate_owner: false }] };
  } };
  assert.equal((await loadAdmittedChildMaterialization(client, admissionId)).authorityCurrent, true);
});

test("failure finalization accepts exact concurrent Session, dispatch, and lifecycle advance", async () => {
  const failedAt = "2026-09-02T10:02:00.000Z";
  const terminalSnapshot = { ...snapshot, state: "failed",
    lease: { leaseId: input.lease.leaseId, generation: input.generation,
      status: "released", releasedAt: failedAt }, eventCursor: 2,
    capabilities: sessionCapabilitiesFor("failed", false), updatedAt: failedAt };
  const completion = { version: "codeops.session-runtime-completion/v1",
    dispatchId: input.childDispatchId, sessionId: input.childSessionId,
    generation: input.generation, leaseId: input.lease.leaseId,
    idempotencyKey: input.initialDispatch.command.idempotencyKey,
    observedEventCursor: 1, completedAt: failedAt, type: "prompt",
    material: { response: "", stopReason: "cancelled" } };
  const result = { version: "codeops.session-command-result/v1",
    commandId: input.childDispatchId, sessionId: input.childSessionId,
    generation: input.generation, leaseId: input.lease.leaseId,
    idempotencyKey: input.initialDispatch.command.idempotencyKey, type: "prompt",
    eventCursor: 2, snapshot: terminalSnapshot, committedAt: failedAt,
    disposition: "rejected", rejectionCode: "invalid_state", reason: "Already advanced." };
  const terminal = { ...boundState({ ...queued, state: "runtime-authorized" }),
    state: "failed", failureCode: "provisioning-failed", failedAt,
    updatedAt: failedAt };
  const calls = [];
  const client = { async query(text) {
    calls.push(text);
    if (text.includes("SELECT materialization.input_json")) return { rowCount: 1, rows: [{
      input_json: input, snapshot_json: terminalSnapshot,
      idempotency_key: input.initialDispatch.command.idempotencyKey,
      owner_principal_id: input.principalId, dispatch_status: "completed",
      completion_json: completion, result_json: result,
      phase: "cancelled", attention: "clear", sequence: 2,
    }] };
    if (text.includes("UPDATE codeops.admitted_child_materializations")) {
      return { rowCount: 1, rows: [{ state_json: terminal }] };
    }
    throw new Error(`unexpected query: ${text}`);
  } };
  assert.equal((await failAdmittedChildMaterialization(client, terminal,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).state, "failed");
  assert.equal(calls.some((sql) => sql.includes("UPDATE codeops.sessions SET")), false);
  assert.equal(calls.some((sql) => sql.includes("UPDATE codeops.session_runtime_outbox SET")), false);
  assert.equal(calls.some((sql) => sql.includes("UPDATE codeops.work_item_lifecycle")), false);
});
