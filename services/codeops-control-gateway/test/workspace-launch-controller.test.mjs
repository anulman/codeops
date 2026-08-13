import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PermanentWorkspaceLaunchError,
  reconcileWorkspaceLaunch,
  workspaceLaunchRuntimeIdentity,
} from "../dist/workspace-launch-controller.js";

const now = () => new Date("2026-08-13T12:00:00.000Z");
const launch = {
  version: "codeops.workspace-launch/v1",
  launchId: "launch-0123456789abcdef01234567",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  principalId: "user@example.com",
  requestDigest: `sha256:${"a".repeat(64)}`,
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
  prompt: "Write a one-off script.",
  sources: [],
};
const image = `ghcr.io/anulman/codeops/image@sha256:${"c".repeat(64)}`;

function resourceConfig(current, identity) {
  return {
    namespace: "agents-system",
    launchId: current.launchId,
    principalId: current.principalId,
    requestDigest: current.requestDigest,
    ...identity,
    workspace: current.workspace,
    sources: [],
    agentImage: image,
    runtimeWorkerImage: image,
    imagePullSecrets: [{ name: "registry" }],
    nodeSelector: {},
    runtimeServiceAccountName: "agents-system-runtime",
    sessionSecretsName: "agents-system-session-secrets",
    sessionGatewayOrigin: "http://agents-system-session-control-gateway:8080",
    modelProxyOrigin: "http://agents-system-model-proxy:8080",
    workspaceStorageSize: "10Gi",
  };
}

test("provisions fixed resources, waits for the exact session, and sends one prompt", async () => {
  let current = launch;
  const ensured = [];
  const enqueued = [];
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
    },
    loadSession: async () => runtimeEnsured ? {
      version: "codeops.session-snapshot/v1",
      sessionId: identity.sessionId,
      generation: 1,
      state: "running",
      identity: {
        version: "codeops.session-workspace-identity/v1",
        workspace: launch.workspace,
        workflowId: identity.workflowId,
        runId: identity.runId,
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
    removeResource: async (resource) => ensured.push(`deleted:${resource.kind}`),
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
    "deleted:Secret",
    "deleted:Job",
    "workspace-runtime",
    "deleted:Secret",
  ]);
  assert.equal(result.state, "ready");
  assert.equal(result.sessionId, identity.sessionId);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].command.prompt, request.prompt);
  assert.equal(enqueued[0].command.idempotencyKey, identity.promptIdempotencyKey);
});

test("keeps provisioning durable until the root session initializes", async () => {
  let current = launch;
  const dependencies = {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async () => {},
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

test("terminates a session that drifts from the resolved workspace", async () => {
  const identity = workspaceLaunchRuntimeIdentity(launch);
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: { ...launch, state: "provisioning" }, request }),
    update: async (next) => next,
    ensureResource: async () => {},
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
    ensureResource: async () => {},
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
  assert.deepEqual(removed, ["Secret"]);
});

test("terminates incompatible resources after credential cleanup", async () => {
  let current = launch;
  const removed = [];
  const result = await reconcileWorkspaceLaunch(launch.launchId, {
    load: async () => ({ launch: current, request }),
    update: async (next) => (current = next),
    ensureResource: async () => {
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
