import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import {
  PermanentWorkspaceLaunchError,
  reconcileWorkspaceLaunch,
  workspaceLaunchRuntimeIdentity,
  workspaceLaunchRuntimeWorkerImage,
} from "../dist/workspace-launch-controller.js";

const now = () => new Date("2026-08-13T12:00:00.000Z");
const policy = {
  version: "codeops.session-policy/v1",
  mode: "implement",
  workspaceAccess: "bounded-writes",
  modelCalls: "allowed",
  modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
};
const attachmentContent = Buffer.from("Exact estimator context.\n", "utf8").toString("base64");
const contextAttachment = {
  attachmentId: "context-estimator-notes",
  name: "estimator-notes.txt",
  mimeType: "text/plain",
  sizeBytes: Buffer.from("Exact estimator context.\n", "utf8").byteLength,
  digest: `sha256:${createHash("sha256").update(Buffer.from(attachmentContent, "base64")).digest("hex")}`,
  content: attachmentContent,
};
const contextAttachmentDescriptor = (({ content: _content, ...descriptor }) => descriptor)(contextAttachment);
const runtimeRequirements = {
  version: "codeops.runtime-requirements/v1", capabilities: ["acp"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1280, ephemeralStorageMiB: 1280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "compatible-substitution-v1",
};
const runtimeRequirementDigest = sha256CanonicalJsonDigest(runtimeRequirements);
const launch = {
  version: "codeops.workspace-launch/v1",
  launchId: "launch-0123456789abcdef01234567",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  principalId: "user@example.com",
  title: "Investigate the estimator",
  requestDigest: `sha256:${"a".repeat(64)}`,
  runtimeRequirements,
  runtimeRequirementDigest,
  policy,
  contextAttachments: [contextAttachmentDescriptor],
  promptDigest: `sha256:${"b".repeat(64)}`,
  workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
  state: "queued",
  createdAt: now().toISOString(),
  updatedAt: now().toISOString(),
  deadlineAt: "2026-08-13T18:00:00.000Z",
  attemptCount: 0,
};
const request = {
  version: "codeops.workspace-launch-request/v1",
  idempotencyKey: launch.idempotencyKey,
  mode: "implement",
  prompt: "Write a one-off script.",
  contextAttachments: [contextAttachment],
  sources: [],
};
const image = `ghcr.io/anulman/codeops/image@sha256:${"c".repeat(64)}`;
const rolloutImage = `ghcr.io/anulman/codeops/image@sha256:${"d".repeat(64)}`;
const retryLaunch = {
  ...launch,
  retryRuntime: {
    dispositionId: "22222222-2222-4222-8222-222222222222",
    sessionId: "ses_abcdef0123456789abcdef01",
    workflowId: "workflow-retry",
    runId: "launch-abcdef0123456789abcdef01",
    leaseId: "33333333-3333-4333-8333-333333333333",
    promptIdempotencyKey: "44444444-4444-4444-8444-444444444444",
    runtimeWorkerImage: image,
  },
};
const retryLaunchWithSource = {
  ...retryLaunch,
  workspace: {
    ...retryLaunch.workspace,
    sources: [{
      catalogKey: "codeops",
      repository: "anulman/codeops",
      checkoutPath: "sources/codeops",
      requestedRef: "main",
      resolvedSha: "1".repeat(40),
    }],
  },
};
const boundRetryLaunch = {
  ...retryLaunch,
  resourceBindings: {
    sourceAuthority: {
      uid: "uid-source-authority",
      configDigest: `sha256:${"d".repeat(64)}`,
    },
  },
};
const boundRetryLaunchWithSource = {
  ...retryLaunchWithSource,
  resourceBindings: {
    sourceAuthority: {
      ...boundRetryLaunch.resourceBindings.sourceAuthority,
      resourceName: `workspace-${retryLaunchWithSource.launchId.slice("launch-".length)}-source-32279f510b`,
    },
  },
};

test("reconstructs a crashed successor from its disposition-bound runtime image", () => {
  const recovered = JSON.parse(JSON.stringify(retryLaunch));
  assert.equal(workspaceLaunchRuntimeWorkerImage(recovered, image), image);
});

test("rejects live runtime image drift after a rollout", () => {
  assert.throws(() => workspaceLaunchRuntimeWorkerImage(retryLaunch, rolloutImage),
    /drifted from live configuration/);
});

test("rejects replica-skew while the matching replica retains stored authority", () => {
  assert.equal(workspaceLaunchRuntimeWorkerImage(retryLaunch, image), image);
  assert.throws(() => workspaceLaunchRuntimeWorkerImage(retryLaunch, rolloutImage),
    PermanentWorkspaceLaunchError);
});
const runtimeLaunchBinding = {
  version: "codeops.runtime-launch-binding/v1",
  requirementDigest: runtimeRequirementDigest,
  selectedAt: now().toISOString(),
  profile: {
    version: "codeops.runtime-profile/v1", profileId: "standard-v1",
    releaseDigest: `sha256:${"d".repeat(64)}`, capabilities: ["acp"],
    capabilityDigest: sha256CanonicalJsonDigest(["acp"]),
    resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
    authority: runtimeRequirements.maximumAuthority,
    compatibilityPolicyRevision: "compatible-substitution-v1",
    images: { agent: image, worker: image, sessionGateway: image },
  },
};

function resourceBinding(resource) {
  const role = resource.metadata.labels["codeops.example/resource-role"];
  return { uid: `uid-${role}`, configDigest: `sha256:${"d".repeat(64)}` };
}

function resourceConfig(current, identity) {
  return {
    namespace: "agents-system",
    launchId: current.launchId,
    principalId: current.principalId,
    requestDigest: current.requestDigest,
    ...(current.title === undefined ? {} : { displayName: current.title }),
    ...identity,
    policy: current.policy,
    contextAttachments: current.contextAttachments,
    workspace: current.workspace,
    sources: current.workspace.sources.map((source) => ({
      catalogKey: source.catalogKey,
      repositoryUrl: "https://github.com/anulman/codeops.git",
      readToken: "github-read-token",
    })),
    agentImage: image,
    runtimeWorkerImage: image,
    configuredRuntimeWorkerImage: image,
    runtimeLaunchBinding,
    runtimeRequirements,
    imagePullSecrets: [{ name: "registry" }],
    nodeSelector: {},
    runtimeServiceAccountName: "agents-system-runtime",
    sessionSecretsName: "agents-system-session-secrets",
    sessionGatewayOrigin: "http://agents-system-session-control-gateway:8080",
    modelProxyOrigin: "http://agents-system-model-proxy:8080",
    modelProxyServiceName: "agents-system-model-proxy",
    modelProxyPodName: "agents-system-model-proxy-pods",
    workspaceStorageSize: "10Gi",
  };
}

function driftedResourceConfig(current, identity) {
  return {
    ...resourceConfig(current, identity),
    runtimeWorkerImage: current.retryRuntime?.runtimeWorkerImage ?? rolloutImage,
    configuredRuntimeWorkerImage: rolloutImage,
  };
}

test("cleans a source Secret after restart before failing live-image drift", async () => {
  let sourceSecretExists = true;
  const removed = [];
  const result = await reconcileWorkspaceLaunch(boundRetryLaunchWithSource.launchId, {
    load: async () => ({ launch: boundRetryLaunchWithSource, request }),
    update: async (next) => next,
    ensureResource: async () => assert.fail("unexpected resource ensure"),
    loadSession: async () => assert.fail("unexpected session load"),
    loadJob: async () => assert.fail("unexpected Job load"),
    listRuntimePods: async () => assert.fail("unexpected Pod list"),
    recordRuntimePodObservations: async () => assert.fail("unexpected observation"),
    removeResource: async (resource) => {
      removed.push(resource.metadata.name);
      sourceSecretExists = false;
    },
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig: driftedResourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "identity-conflict");
  assert.equal(sourceSecretExists, false);
  assert.deepEqual(removed, [
    `workspace-${boundRetryLaunchWithSource.launchId.slice("launch-".length)}-source-32279f510b`,
  ]);
});

test("repeats live-image-drift cleanup idempotently after a terminal update failure", async () => {
  let current = boundRetryLaunch;
  let sourceSecretExists = true;
  let removeCalls = 0;
  let failedUpdateOnce = false;
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => {
      if (next.state === "failed" && !failedUpdateOnce) {
        failedUpdateOnce = true;
        throw new Error("database unavailable after cleanup");
      }
      return (current = next);
    },
    ensureResource: async () => assert.fail("unexpected resource ensure"),
    loadSession: async () => assert.fail("unexpected session load"),
    loadJob: async () => assert.fail("unexpected Job load"),
    listRuntimePods: async () => assert.fail("unexpected Pod list"),
    recordRuntimePodObservations: async () => assert.fail("unexpected observation"),
    removeResource: async () => {
      removeCalls += 1;
      sourceSecretExists = false;
    },
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig: driftedResourceConfig,
    now,
  };
  await assert.rejects(
    reconcileWorkspaceLaunch(boundRetryLaunch.launchId, dependencies),
    /database unavailable after cleanup/,
  );
  assert.equal(sourceSecretExists, false);
  assert.equal((await reconcileWorkspaceLaunch(boundRetryLaunch.launchId, dependencies)).state, "failed");
  assert.equal(removeCalls, 2);
});

function retryPodDependencies(pod) {
  const current = {
    ...retryLaunch,
    state: "provisioning",
    materializedAt: now().toISOString(),
  };
  const identity = workspaceLaunchRuntimeIdentity(current);
  return {
    launch: current,
    dependencies: {
      load: async () => ({ launch: current, request }),
      update: async (next) => next,
      ensureResource: async () => {},
      loadSession: async () => ({
        sessionId: identity.sessionId,
        generation: 1,
        lease: {
          status: "active",
          leaseId: identity.leaseId,
          expiresAt: "2026-08-13T13:00:00.000Z",
        },
        identity: {
          version: "codeops.session-workspace-identity/v1",
          policy: current.policy,
          contextAttachments: current.contextAttachments,
          workspace: current.workspace,
          displayName: current.title,
        },
      }),
      loadJob: async () => ({ status: { active: 1 } }),
      listRuntimePods: async () => [{
        metadata: {
          uid: "successor-pod",
          labels: { "codeops.example/run-id": identity.runId },
          ownerReferences: [{
            apiVersion: "batch/v1",
            kind: "Job",
            name: `workspace-${current.launchId.slice("launch-".length)}`,
            controller: true,
          }],
        },
        spec: { containers: [{ name: "runtime-worker", image }] },
        status: { podIP: "10.42.1.9", ...pod.status },
      }],
      recordRuntimePodObservations: async () => assert.fail("unexpected observation"),
      removeResource: async () => {},
      enqueuePrompt: async () => assert.fail("unexpected prompt"),
      resourceConfig,
      now,
    },
  };
}

test("requeues an assigned successor Pod while its startup image is absent", async () => {
  const input = retryPodDependencies({
    status: {
      phase: "Pending",
      containerStatuses: [{ name: "runtime-worker", state: { waiting: {
        reason: "ContainerCreating",
      } } }],
    },
  });
  const result = await reconcileWorkspaceLaunch(input.launch.launchId, input.dependencies);
  assert.equal(result.state, "provisioning");
  assert.equal(result.attemptCount, input.launch.attemptCount + 1);
});

test("fails a terminal successor Pod whose image is absent", async () => {
  const input = retryPodDependencies({
    status: {
      phase: "Failed",
      containerStatuses: [{ name: "runtime-worker", state: { terminated: {
        exitCode: 1,
      } } }],
    },
  });
  const result = await reconcileWorkspaceLaunch(input.launch.launchId, input.dependencies);
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-failed");
});

test("provisions fixed resources, waits for the exact session, and sends one prompt", async () => {
  let current = launch;
  const ensured = [];
  const enqueued = [];
  const observations = [];
  let runtimeEnsured = false;
  const identity = workspaceLaunchRuntimeIdentity(launch);
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async (resource) => {
      ensured.push(resource.metadata.labels["codeops.example/resource-role"]);
      if (resource.metadata.labels["codeops.example/resource-role"] === "workspace-runtime") {
        runtimeEnsured = true;
      }
      return resourceBinding(resource);
    },
    loadSession: async () => runtimeEnsured ? {
      version: "codeops.session-snapshot/v1",
      sessionId: identity.sessionId,
      generation: 1,
      state: "running",
      identity: {
        version: "codeops.session-workspace-identity/v1",
        policy: launch.policy,
        contextAttachments: launch.contextAttachments,
        workspace: launch.workspace,
        workflowId: identity.workflowId,
        runId: identity.runId,
        displayName: launch.title,
        parentSessionId: null,
        forkedAtCursor: null,
      },
      lease: {
        leaseId: identity.leaseId,
        generation: 1,
        status: "active",
        holderId: `session-job:${identity.sessionId}`,
        acquiredAt: now().toISOString(),
        expiresAt: "2026-08-13T13:00:00.000Z",
      },
      checkpoint: null,
      pendingPermission: null,
      eventCursor: 1,
      capabilities: [],
      updatedAt: now().toISOString(),
    } : null,
    loadJob: async (name) => name.endsWith("-materialize")
      ? { status: { succeeded: 1 } }
      : { status: { active: 1 } },
    listRuntimePods: async () => [{
      metadata: {
        uid: "runtime-pod-uid",
        labels: { "codeops.example/run-id": identity.runId },
        ownerReferences: [{
          apiVersion: "batch/v1",
          kind: "Job",
          name: `workspace-${launch.launchId.slice("launch-".length)}`,
          controller: true,
        }],
      },
      status: { podIP: "10.42.1.8" },
    }],
    recordRuntimePodObservations: async (entries) => observations.push(...entries),
    removeResource: async (resource, requestDigest, uid, configDigest) => {
      const binding = resourceBinding(resource);
      assert.equal(requestDigest, launch.requestDigest);
      assert.equal(uid, binding.uid);
      assert.equal(configDigest, binding.configDigest);
      ensured.push(`deleted:${resource.kind}`);
    },
    enqueuePrompt: async (input) => {
      enqueued.push(input);
      return { command: input.command };
    },
    resourceConfig,
    now,
  };
  assert.equal((await reconcileWorkspaceLaunch(launch.launchId, dependencies)).state, "provisioning");
  const result = await reconcileWorkspaceLaunch(launch.launchId, dependencies);
  assert.deepEqual(ensured, [
    "source-authority",
    "workspace-storage",
    "source-materializer",
    "source-authority",
    "workspace-storage",
    "source-materializer",
    "deleted:Secret",
    "deleted:Job",
    "workspace-runtime",
    "workspace-runtime",
    "deleted:Secret",
  ]);
  assert.equal(result.state, "ready");
  assert.equal(result.sessionId, identity.sessionId);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].command.prompt, request.prompt);
  assert.deepEqual(enqueued[0].command.contextAttachments, request.contextAttachments);
  assert.equal(enqueued[0].command.idempotencyKey, identity.promptIdempotencyKey);
  assert.deepEqual(observations, [{
    sessionId: identity.sessionId,
    generation: 1,
    podUid: "runtime-pod-uid",
    podIp: "10.42.1.8",
    observedAt: now().toISOString(),
  }]);
});

function initializedSession(identity, leaseExpiresAt) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: identity.sessionId,
    generation: 1,
    state: "running",
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: launch.policy,
      contextAttachments: launch.contextAttachments,
      workspace: launch.workspace,
      workflowId: identity.workflowId,
      runId: identity.runId,
      displayName: launch.title,
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId: identity.leaseId,
      generation: 1,
      status: "active",
      holderId: `session-job:${identity.sessionId}`,
      acquiredAt: "2026-08-13T10:00:00.000Z",
      expiresAt: leaseExpiresAt,
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 1,
    capabilities: [],
    updatedAt: now().toISOString(),
  };
}

for (const [condition, leaseExpiresAt, runtimeStatus] of [
  ["an expired session lease", "2026-08-13T11:59:59.000Z", { active: 1 }],
  ["a failed runtime Job", "2026-08-13T13:00:00.000Z", {
    conditions: [{ type: "Failed", status: "True" }],
  }],
]) {
  test(`fails before prompt admission when the initialized launch has ${condition}`, async () => {
    let current = { ...launch, state: "provisioning", materializedAt: now().toISOString() };
    const identity = workspaceLaunchRuntimeIdentity(current);
    let promptCalls = 0;
    let observationCalls = 0;
    const result = await reconcileWorkspaceLaunch(current.launchId, {
      load: async () => ({ launch: current, request }),
      update: async (next) => (current = next),
      ensureResource: async (resource) => resourceBinding(resource),
      loadSession: async () => initializedSession(identity, leaseExpiresAt),
      loadJob: async () => ({ status: runtimeStatus }),
      listRuntimePods: async () => [],
      recordRuntimePodObservations: async () => { observationCalls += 1; },
      removeResource: async () => {},
      enqueuePrompt: async () => { promptCalls += 1; return { command: {} }; },
      resourceConfig,
      now,
    });
    assert.equal(result.state, "failed");
    assert.equal(result.failureCode, "provisioning-failed");
    assert.equal(promptCalls, 0);
    assert.equal(observationCalls, 0);
  });
}

test("keeps provisioning durable until the root session initializes", async () => {
  let current = launch;
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async (resource) => resourceBinding(resource),
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async () => {},
    enqueuePrompt: async () => { throw new Error("unexpected prompt"); },
    resourceConfig,
    now,
  };
  assert.equal((await reconcileWorkspaceLaunch(launch.launchId, dependencies)).state, "provisioning");
  assert.equal((await reconcileWorkspaceLaunch(launch.launchId, dependencies)).state, "provisioning");
});

test("persists and deletes an exact legacy credential identity before stable recreation", async () => {
  let current = launch;
  const events = [];
  const legacyName = "workspace-0123456789abcdef01234567-source-0123456789";
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => { current = next; events.push({ type: "persist",
      binding: next.resourceBindings?.sourceAuthority }); return next; },
    recoverResource: async (resource) => resource.kind === "Secret" &&
      !events.some(({ type }) => type === "delete") ? {
      uid: "legacy-secret-uid", configDigest: `sha256:${"e".repeat(64)}`,
      resourceName: legacyName, matchesExpectedConfiguration: false,
      desiredConfigDigest: `sha256:${"f".repeat(64)}`,
    } : null,
    ensureResource: async (resource, _requestDigest, _uid, expectedConfigDigest) => {
      events.push({ type: "ensure", name: resource.metadata.name });
      return { ...resourceBinding(resource), configDigest: expectedConfigDigest ??
        resourceBinding(resource).configDigest };
    },
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async (resource, _digest, uid) => { events.push({ type: "delete",
      name: resource.metadata.name, uid,
      persisted: current.resourceBindings?.sourceAuthority,
      replacement: current.resourceReplacements?.sourceAuthority }); },
    readResourceUid: async (resource) => resource.metadata.name === legacyName &&
      !events.some(({ type }) => type === "delete") ? "legacy-secret-uid" : null,
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  };
  assert.equal((await reconcileWorkspaceLaunch(launch.launchId, dependencies)).state,
    "provisioning");
  const deletion = events.find(({ type }) => type === "delete");
  assert.deepEqual(deletion, { type: "delete", name: legacyName, uid: "legacy-secret-uid",
    persisted: { uid: "legacy-secret-uid", configDigest: `sha256:${"e".repeat(64)}`,
      resourceName: legacyName }, replacement: { uid: "legacy-secret-uid",
      configDigest: `sha256:${"e".repeat(64)}`, resourceName: legacyName,
      desiredConfigDigest: `sha256:${"f".repeat(64)}` } });
  assert.equal(events.some(({ type, name }) => type === "ensure" &&
    name === "workspace-0123456789abcdef01234567-source"), true);
});

test("replays asynchronous Secret deletion only from durable replacement intent", async () => {
  let current = launch;
  const legacyName = "workspace-0123456789abcdef01234567-source-0123456789";
  const desiredDigest = `sha256:${"f".repeat(64)}`;
  let deleting = false;
  let deleted = false;
  let deleteCalls = 0;
  let recoverCalls = 0;
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    recoverResource: async (resource) => {
      recoverCalls += 1;
      if (recoverCalls === 1) return { uid: "old-uid", configDigest: `sha256:${"e".repeat(64)}`,
        resourceName: legacyName, matchesExpectedConfiguration: false,
        desiredConfigDigest: desiredDigest };
      return null;
    },
    readResourceUid: async (resource) => resource.metadata.name !== legacyName || deleted
      ? null : "old-uid",
    removeResource: async () => { deleteCalls += 1; deleting = true; },
    ensureResource: async (resource, _digest, uid, configDigest) => ({
      uid: uid ?? `new-${resource.metadata.labels["codeops.example/resource-role"]}`,
      configDigest: configDigest ?? `sha256:${"d".repeat(64)}`,
    }),
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  };
  const pending = await reconcileWorkspaceLaunch(launch.launchId, dependencies);
  assert.equal(pending.state, "queued");
  assert.equal(deleting, true);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(current.resourceReplacements.sourceAuthority, {
    uid: "old-uid", resourceName: legacyName,
    configDigest: `sha256:${"e".repeat(64)}`, desiredConfigDigest: desiredDigest,
  });
  deleted = true;
  const replayed = await reconcileWorkspaceLaunch(launch.launchId, dependencies);
  assert.equal(replayed.state, "provisioning");
  assert.equal(deleteCalls, 1);
  assert.equal(replayed.resourceBindings.sourceAuthority.uid, "new-source-authority");
  assert.equal(replayed.resourceReplacements.sourceAuthority, undefined);
});

test("replacement-race replay binds an exact new Secret without deleting its UID", async () => {
  const desiredName = "workspace-0123456789abcdef01234567-source";
  const desiredDigest = `sha256:${"f".repeat(64)}`;
  let current = { ...launch, resourceBindings: { sourceAuthority: {
    uid: "old-uid", configDigest: `sha256:${"e".repeat(64)}` } },
  resourceReplacements: { sourceAuthority: { uid: "old-uid", resourceName: desiredName,
    configDigest: `sha256:${"e".repeat(64)}`, desiredConfigDigest: desiredDigest } } };
  let deleteCalls = 0;
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    readResourceUid: async () => "new-uid",
    recoverResource: async () => ({ uid: "new-uid", configDigest: desiredDigest,
      desiredConfigDigest: desiredDigest, matchesExpectedConfiguration: true }),
    removeResource: async () => { deleteCalls += 1; },
    ensureResource: async (resource, _digest, uid, configDigest) => ({ uid: uid ??
      `uid-${resource.metadata.labels["codeops.example/resource-role"]}`,
    configDigest: configDigest ?? `sha256:${"d".repeat(64)}` }),
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(result.state, "provisioning");
  assert.equal(deleteCalls, 0);
  assert.deepEqual(result.resourceBindings.sourceAuthority,
    { uid: "new-uid", configDigest: desiredDigest });
  assert.equal(result.resourceReplacements.sourceAuthority, undefined);
});

test("terminates a session that drifts from the resolved workspace", async () => {
  const identity = workspaceLaunchRuntimeIdentity(launch);
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: { ...launch, state: "provisioning",
      resourceBindings: { sourceAuthority: {
        uid: "uid-source-authority", configDigest: `sha256:${"d".repeat(64)}`,
      } } }, request }),
    update: async (next) => next,
    ensureResource: async (resource) => resourceBinding(resource),
    loadSession: async () => ({
      sessionId: identity.sessionId,
      generation: 1,
      lease: { status: "active", leaseId: identity.leaseId },
      identity: { version: "codeops.session-workspace-identity/v1", workspace: { ...launch.workspace, scratchPath: "other" } },
    }),
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async (resource) => removed.push(resource.kind),
    enqueuePrompt: async () => { throw new Error("unexpected prompt"); },
    resourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-failed");
  assert.deepEqual(removed, ["Secret"]);
});

test("fails a launch whose fixed Job reaches a terminal failure", async () => {
  let current = { ...launch, state: "provisioning" };
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async (resource) => resourceBinding(resource),
    loadSession: async () => null,
    loadJob: async () => ({
      status: { conditions: [{ type: "Failed", status: "True" }] },
    }),
    removeResource: async (resource) => removed.push(resource.kind),
    enqueuePrompt: async () => { throw new Error("unexpected prompt"); },
    resourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "provisioning-failed");
  assert.deepEqual(removed, ["Secret"]);
});

test("backs off transient provisioning failures and stops at the durable deadline", async () => {
  let current = launch;
  const transient = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async () => { throw new Error("Kubernetes unavailable"); },
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async () => {},
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(transient.state, "queued");
  assert.equal(transient.attemptCount, 1);
  assert.equal(transient.nextAttemptAt, "2026-08-13T12:00:02.000Z");

  current = { ...launch, deadlineAt: now().toISOString() };
  const removed = [];
  const expired = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async () => { throw new Error("Kubernetes unavailable"); },
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async (resource) => removed.push(resource.kind),
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(expired.state, "failed");
  assert.equal(expired.failureCode, "provisioning-timeout");
  assert.deepEqual(removed, []);
});

test("cleans a created credential from the exact ensure result when binding persistence fails", async () => {
  let updateCount = 0;
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: { ...launch, deadlineAt: now().toISOString() }, request }),
    update: async (next) => {
      updateCount += 1;
      if (updateCount === 2) throw new Error("binding persistence failed");
      return next;
    },
    ensureResource: async (resource) => resourceBinding(resource),
    loadSession: async () => null,
    loadJob: async () => assert.fail("Job status must not be consumed"),
    removeResource: async (resource, requestDigest, uid, configDigest) => {
      removed.push({ role: resource.metadata.labels["codeops.example/resource-role"],
        requestDigest, uid, configDigest });
    },
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.deepEqual(removed, [{ role: "source-authority", requestDigest: launch.requestDigest,
    ...resourceBinding({ metadata: { labels: {
      "codeops.example/resource-role": "source-authority",
    } } }) }]);
});

test("terminates incompatible resources after credential cleanup", async () => {
  let current = launch;
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async (resource) => {
      if (resource.metadata.labels["codeops.example/resource-role"] === "source-authority") {
        return resourceBinding(resource);
      }
      throw new PermanentWorkspaceLaunchError("resource identity drift");
    },
    loadSession: async () => null,
    loadJob: async () => ({ status: { active: 1 } }),
    removeResource: async (resource) => removed.push(resource.kind),
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "identity-conflict");
  assert.deepEqual(removed, ["Secret"]);
});

test("replay never deletes a replacement Job identity", async () => {
  const bindings = {
    sourceAuthority: { uid: "uid-source-authority", configDigest: `sha256:${"1".repeat(64)}` },
    workspaceStorage: { uid: "uid-workspace-storage", configDigest: `sha256:${"2".repeat(64)}` },
    sourceMaterializer: { uid: "uid-source-materializer", configDigest: `sha256:${"3".repeat(64)}` },
  };
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: { ...launch, state: "provisioning",
      resourceBindings: bindings }, request }),
    update: async (next) => next,
    ensureResource: async (resource, requestDigest, expectedUid, expectedConfigDigest) => {
      const key = {
        "source-authority": "sourceAuthority",
        "workspace-storage": "workspaceStorage",
        "source-materializer": "sourceMaterializer",
      }[resource.metadata.labels["codeops.example/resource-role"]];
      assert.equal(requestDigest, launch.requestDigest);
      assert.deepEqual({ uid: expectedUid, configDigest: expectedConfigDigest }, bindings[key]);
      if (key === "sourceMaterializer") {
        throw new PermanentWorkspaceLaunchError("replacement Kubernetes UID");
      }
      return bindings[key];
    },
    loadSession: async () => null,
    loadJob: async () => assert.fail("replacement Job status must not be consumed"),
    removeResource: async (resource, requestDigest, uid, configDigest) => {
      removed.push({ role: resource.metadata.labels["codeops.example/resource-role"],
        requestDigest, uid, configDigest });
    },
    enqueuePrompt: async () => assert.fail("unexpected prompt"),
    resourceConfig,
    now,
  });
  assert.equal(result.state, "failed");
  assert.deepEqual(removed, [{ role: "source-authority", requestDigest: launch.requestDigest,
    ...bindings.sourceAuthority }]);
});
