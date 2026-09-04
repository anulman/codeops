import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentJobDispatchRequestSchema,
  createProjectContext,
  sha256CanonicalJsonDigest,
} from "@codeops/codeops-contracts";
import { claimRequest, createRunIdentity } from "../dist/core.js";
import { createAgentJobRunner } from "../dist/runtime.js";
import { createRepositoryRegistry } from "../dist/repository-registry.js";

const repositoryRegistry = createRepositoryRegistry([
  {
    repository: "example-org/example-repository",
    repositoryUrl: "https://github.com/example-org/example-repository",
    readToken: "r".repeat(32),
    writeToken: "w".repeat(32),
  },
]);

const modelAuth = {
  mode: "proxy",
  origin: "http://codeops-model-proxy:8080",
  signingKey: "m".repeat(64),
};
const runtimeProfile = {
  version: "codeops.runtime-profile/v1",
  profileId: "standard-v1",
  releaseDigest: `sha256:${"7".repeat(64)}`,
  capabilities: ["acp"],
  capabilityDigest: sha256CanonicalJsonDigest(["acp"]),
  resources: { cpuMillis: 3_000, memoryMiB: 7_168, ephemeralStorageMiB: 5_120 },
  authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "compatible-substitution-v1",
  images: {
    agent: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    worker: `ghcr.io/a/worker@sha256:${"e".repeat(64)}`,
    sessionGateway: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
  },
};
const runtimeRequirements = {
  version: "codeops.runtime-requirements/v1",
  capabilities: ["acp"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1_280, ephemeralStorageMiB: 1_280 },
  requiredAuthority: runtimeProfile.authority,
  maximumAuthority: runtimeProfile.authority,
  compatibilityPolicyRevision: runtimeProfile.compatibilityPolicyRevision,
};
const runtimeLaunchBinding = {
  version: "codeops.runtime-launch-binding/v1",
  requirementDigest: sha256CanonicalJsonDigest(runtimeRequirements),
  profile: runtimeProfile,
  selectedAt: "2026-08-31T08:00:00.000Z",
};

function resourceBinding(resource) {
  return {
    uid: `uid-${resource.kind}-${resource.metadata.name}`,
    configDigest: `sha256:${"e".repeat(64)}`,
  };
}

const projectContext = createProjectContext({
  version: "codeops.project-context/v1",
  repository: { owner: "example-org", name: "example-repository" },
  controlPlaneSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  project: {
    workspaceId: "55555555-5555-4555-8555-555555555555",
    projectId: "11111111-1111-4111-8111-111111111111",
    name: "Onboarding Auth QA",
    descriptionHtml: "<p>Deterministic qualification.</p>",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  documents: [
    {
      path: "AGENTS.md",
      purpose: "Repository guidance",
      digest:
        "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
      content: "# Repository guidance\n",
    },
  ],
});

const request = {
  version: "codeops.agent-job-dispatch/v1",
  workItemId: "22222222-2222-4222-8222-222222222222",
  workflowId: "research-request-1",
  baseSha: "a".repeat(40),
  summary: "Research auth",
  role: "qa-contract-researcher",
  researchStage: { kind: "persona", persona: "@ai-security" },
  researchRequest: {
    version: "codeops.research-request/v3",
    requestId: "research-request-1",
    workspaceId: projectContext.project.workspaceId,
    projectId: "11111111-1111-4111-8111-111111111111",
    workItemId: "22222222-2222-4222-8222-222222222222",
    triggerCommentId: "33333333-3333-4333-8333-333333333333",
    requestedBy: "44444444-4444-4444-8444-444444444444",
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    projectContext,
    ticketSnapshot: {
      workItemId: "22222222-2222-4222-8222-222222222222",
      name: "Research auth",
      descriptionHtml: "<p>Define auth contracts.</p>",
      priority: "high",
      stateId: "66666666-6666-4666-8666-666666666666",
      labelIds: [],
      assigneeIds: [],
      moduleId: null,
      parentId: null,
      updatedAt: "2026-07-26T00:00:00.000Z",
      relevantComments: [],
      relations: [],
    },
    personas: ["@ai-security"],
    brief: "Inspect auth",
    requestedAt: "2026-07-26T00:00:00.000Z",
  },
};

function logs(runId, projectContextDigest = projectContext.digest) {
  const report = {
    version: "codeops.research-persona-report/v2",
    requestId: "research-request-1",
    persona: "@ai-security",
    outcome: "findings",
    summary: "Authentication boundaries need qualification.",
    findings: [],
    decisions: [],
    citations: [],
  };
  const checkpoint = {
    schemaVersion: 3,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: JSON.stringify(report),
    events: [],
    patch: {
      path: "changes.patch",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    },
  };
  return [
    JSON.stringify({
      type: "codeops.patch-chunk",
      runId,
      sequence: 1,
      total: 1,
      patchDigest: `sha256:${checkpoint.patch.sha256}`,
      dataBase64: "",
    }),
    JSON.stringify({
      type: "codeops.checkpoint",
      checkpointDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(checkpoint))
        .digest("hex")}`,
      checkpoint,
    }),
  ].join("\n");
}

test("creates, retains, cleans, and then returns the durable result idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-"));
  const runId = createRunIdentity(request).runId;
  const ensured = [];
  const deleted = [];
  const ensuredResources = [];
  const kubernetes = {
    async ensure(resource) {
      ensured.push(`${resource.kind}/${resource.metadata.name}`);
      ensuredResources.push(resource);
      return resourceBinding(resource);
    },
    async getJob() {
      return { status: { succeeded: 1 } };
    },
    async listRunPods() {
      return [{ metadata: { name: "agent-pod" } }];
    },
    async getPodLogs() {
      return logs(runId);
    },
    async delete(resource, requestDigest, uid, configDigest) {
      const binding = resourceBinding(resource);
      assert.equal(requestDigest, createRunIdentity(request).requestDigest);
      assert.equal(uid, binding.uid);
      assert.equal(configDigest, binding.configDigest);
      deleted.push(`${resource.kind}/${resource.metadata.name}`);
    },
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"f".repeat(64)}`,
      runtimeRequirements,
      runtimeLaunchBinding,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 1,
      timeoutMs: 100,
    },
  });
  try {
    const first = await run(request);
    const retainedRequest = JSON.parse(await readFile(
      path.join(root, "agent-runs", runId, "request.json"), "utf8"));
    assert.equal(Object.keys(retainedRequest.resourceBindings).length, 4);
    const job = ensuredResources.find((resource) => resource.kind === "Job");
    assert.equal(
      job.spec.template.spec.containers.find(({ name }) => name === "session-gateway").image,
      runtimeLaunchBinding.profile.images.sessionGateway,
    );
    ensured.length = 0;
    deleted.length = 0;
    const second = await run(request);
    assert.deepEqual(second, first);
    assert.equal(ensured.length, 0);
    assert.deepEqual(deleted, [
      `NetworkPolicy/codeops-agent-${runId}`,
      `Job/codeops-agent-${runId}`,
      `ServiceAccount/codeops-agent-${runId}`,
      `Secret/codeops-run-${runId}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed before effects for unfinished legacy Agent Job evidence without a runtime binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-unbound-"));
  const identity = createRunIdentity(request);
  const directory = path.join(root, "agent-runs", identity.runId);
  let effects = 0;
  const run = createAgentJobRunner({
    kubernetes: {
      async ensure() { effects += 1; }, async delete() { effects += 1; },
      async getJob() { effects += 1; return {}; }, async listRunPods() { effects += 1; return []; },
      async getPodLogs() { effects += 1; return ""; },
    },
    config: {
      namespace: "codeops", repositoryRegistry,
      agentImage: runtimeProfile.images.agent,
      runtimeRequirements, runtimeLaunchBinding, modelAuth,
      evidenceRoot: root, pollIntervalMs: 1, timeoutMs: 1,
    },
  });
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "request.json"), `${JSON.stringify({
      requestDigest: identity.requestDigest,
      request,
    }, null, 2)}\n`);
    await assert.rejects(run(request), /no durable runtime binding/);
    assert.equal(effects, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained successful Agent Job stays successful when legacy cleanup bindings are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-legacy-cleanup-"));
  const runId = createRunIdentity(request).runId;
  let deleteCount = 0;
  const kubernetes = {
    async ensure(resource) { return resourceBinding(resource); },
    async getJob() { return { status: { succeeded: 1 } }; },
    async listRunPods() { return [{ metadata: { name: "agent-pod" } }]; },
    async getPodLogs() { return logs(runId); },
    async delete() { deleteCount += 1; },
  };
  const run = createAgentJobRunner({ kubernetes, config: { namespace: "codeops",
    repositoryRegistry, agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`, modelAuth,
    runtimeRequirements, runtimeLaunchBinding,
    evidenceRoot: root, pollIntervalMs: 1, timeoutMs: 100 } });
  try {
    const first = await run(request);
    const requestPath = path.join(root, "agent-runs", runId, "request.json");
    const retainedRequest = JSON.parse(await readFile(requestPath, "utf8"));
    delete retainedRequest.resourceBindings;
    await writeFile(requestPath, `${JSON.stringify(retainedRequest, null, 2)}\n`);
    assert.deepEqual(await run(request), first);
    assert.equal(deleteCount, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans from the exact ensure result when durable binding retention fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-binding-fail-"));
  const runId = createRunIdentity(request).runId;
  const deleted = [];
  let ensureCount = 0;
  const kubernetes = {
    async ensure(resource) {
      ensureCount += 1;
      if (ensureCount === 2) {
        const requestPath = path.join(root, "agent-runs", runId, "request.json");
        const retainedRequest = JSON.parse(await readFile(requestPath, "utf8"));
        retainedRequest.resourceBindings = { invalid: true };
        await writeFile(requestPath, `${JSON.stringify(retainedRequest, null, 2)}\n`);
      }
      return resourceBinding(resource);
    },
    async getJob() { return { status: { succeeded: 1 } }; },
    async listRunPods() { return [{ metadata: { name: "agent-pod" } }]; },
    async getPodLogs() { return logs(runId); },
    async delete(resource, requestDigest, uid, configDigest) {
      assert.equal(requestDigest, createRunIdentity(request).requestDigest);
      assert.deepEqual({ uid, configDigest }, resourceBinding(resource));
      deleted.push(resource.kind);
    },
  };
  const run = createAgentJobRunner({ kubernetes, config: { namespace: "codeops",
    repositoryRegistry, agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`, modelAuth,
    runtimeRequirements, runtimeLaunchBinding,
    evidenceRoot: root, pollIntervalMs: 1, timeoutMs: 100 } });
  try {
    await assert.rejects(run(request), /durable Agent Job resource binding is invalid/);
    assert.deepEqual(deleted.sort(), ["Secret", "ServiceAccount"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash replay replaces only an authenticated unbound Secret after rotation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-rotated-restart-"));
  const identity = createRunIdentity(request);
  const recoveredBinding = { uid: "pre-crash-secret-uid",
    configDigest: `sha256:${"1".repeat(64)}` };
  const calls = [];
  let recoveredSecretPresent = true;
  let stalePostDeleteRecoveries = 1;
  let crashAfterDelete = true;
  const kubernetes = {
    async recoverOwned(resource) {
      calls.push(["recover", resource.kind, resource.metadata.name]);
      if (resource.kind !== "Secret") return null;
      if (!recoveredSecretPresent && stalePostDeleteRecoveries === 0) return null;
      if (!recoveredSecretPresent) stalePostDeleteRecoveries -= 1;
      return { ...recoveredBinding, desiredConfigDigest: `sha256:${"e".repeat(64)}`,
        matchesExpectedConfiguration: false };
    },
    async ensure(resource, _digest, uid, configDigest) {
      calls.push(["ensure", resource.kind, resource.metadata.name, uid, configDigest]);
      return resourceBinding(resource);
    },
    async getJob() { return { status: { succeeded: 1 } }; },
    async listRunPods() { return [{ metadata: { name: "agent-pod" } }]; },
    async getPodLogs() { return logs(identity.runId); },
    async delete(resource, requestDigest, uid, configDigest) {
      calls.push(["delete", resource.kind, resource.metadata.name, uid, configDigest,
        Object.hasOwn(resource, "data")]);
      assert.equal(requestDigest, identity.requestDigest);
      if (uid === recoveredBinding.uid) {
        recoveredSecretPresent = false;
        const retained = JSON.parse(await readFile(
          path.join(root, "agent-runs", identity.runId, "request.json"), "utf8"));
        const key = `Secret/${resource.metadata.name}`;
        assert.deepEqual(retained.resourceReplacements[key], { ...recoveredBinding,
          desiredConfigDigest: `sha256:${"e".repeat(64)}` });
        if (crashAfterDelete) {
          assert.deepEqual(retained.resourceBindings[key], recoveredBinding);
          crashAfterDelete = false;
          throw new Error("crash after authenticated Secret deletion");
        }
        if (retained.resourceBindings[key] !== undefined) {
          assert.deepEqual(retained.resourceBindings[key], recoveredBinding);
        }
      }
    },
  };
  const run = createAgentJobRunner({ kubernetes, config: { namespace: "codeops",
    repositoryRegistry, agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`, modelAuth,
    runtimeRequirements, runtimeLaunchBinding,
    evidenceRoot: root, pollIntervalMs: 1, timeoutMs: 100 } });
  try {
    await claimRequest({ rootDirectory: root, request, ...identity, runtimeLaunchBinding });
    await assert.rejects(run(request), /crash after authenticated Secret deletion/);
    await assert.rejects(run(request), /recreated Agent Job Secret configuration drifted/);
    const replacementPending = JSON.parse(await readFile(
      path.join(root, "agent-runs", identity.runId, "request.json"), "utf8"));
    const secretName = `codeops-run-${identity.runId}`;
    assert.equal(replacementPending.resourceBindings[`Secret/${secretName}`], undefined);
    assert.deepEqual(replacementPending.resourceReplacements[`Secret/${secretName}`], {
      ...recoveredBinding, desiredConfigDigest: `sha256:${"e".repeat(64)}`,
    });
    await run(request);
    assert.equal(calls.some((call) => call[0] === "ensure" && call[1] === "Secret" &&
      call[2] === secretName && call[3] === undefined && call[4] ===
        `sha256:${"e".repeat(64)}`), true);
    const retained = JSON.parse(await readFile(
      path.join(root, "agent-runs", identity.runId, "request.json"), "utf8"));
    assert.deepEqual(retained.resourceReplacements, {});
    assert.deepEqual(retained.resourceBindings[`Secret/${secretName}`],
      resourceBinding({ kind: "Secret", metadata: { name: secretName } }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds each admitted dispatch to only its repository-scoped runtime credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-registry-"));
  const registry = createRepositoryRegistry([
    {
      repository: "example-org/example-repository",
      repositoryUrl: "https://github.com/example-org/example-repository",
      readToken: "a".repeat(32),
      writeToken: "b".repeat(32),
    },
    {
      repository: "anulman/codeops",
      repositoryUrl: "https://github.com/anulman/codeops",
      readToken: "c".repeat(32),
      writeToken: "d".repeat(32),
    },
  ]);
  const ensured = [];
  const kubernetes = {
    async ensure(resource) {
      ensured.push(resource);
      return resourceBinding(resource);
    },
    async getJob() {
      return { status: { succeeded: 1 } };
    },
    async listRunPods() {
      return [{ metadata: { name: "agent-pod" } }];
    },
    async getPodLogs() {
      return logs(this.runId, this.projectContextDigest);
    },
    async delete() {},
    runId: "",
    projectContextDigest: "",
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry: registry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeRequirements,
      runtimeLaunchBinding,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 1,
      timeoutMs: 100,
    },
  });
  function requestForRepository(name) {
    const value = structuredClone(request);
    const { digest: _digest, ...contextIdentity } = projectContext;
    const repository = { owner: "anulman", name };
    value.researchRequest.repository = repository;
    value.researchRequest.projectContext = createProjectContext({
      ...contextIdentity,
      repository,
    });
    return value;
  }
  const codeopsRequest = requestForRepository("codeops");
  const unknownRequest = requestForRepository("not-admitted");
  agentJobDispatchRequestSchema.parse(codeopsRequest);
  agentJobDispatchRequestSchema.parse(unknownRequest);
  try {
    kubernetes.runId = createRunIdentity(request).runId;
    kubernetes.projectContextDigest = request.researchRequest.projectContext.digest;
    await run(request);
    kubernetes.runId = createRunIdentity(codeopsRequest).runId;
    kubernetes.projectContextDigest =
      codeopsRequest.researchRequest.projectContext.digest;
    await run(codeopsRequest);
    const repositorySecrets = ensured
      .filter((resource) => resource.kind === "Secret")
      .map((resource) =>
        Buffer.from(resource.data["repository-read-token"], "base64").toString(),
      );
    assert.deepEqual(repositorySecrets, ["a".repeat(32), "c".repeat(32)]);
    const effectCount = ensured.length;
    await assert.rejects(run(unknownRequest), /not admitted/);
    assert.equal(ensured.length, effectCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains terminal validation failure and removes credentials/resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-fail-"));
  const deleted = [];
  const kubernetes = {
    async ensure(resource) { return resourceBinding(resource); },
    async getJob() {
      return { status: { failed: 1 } };
    },
    async listRunPods() {
      return [{ metadata: { name: "agent-pod" } }];
    },
    async getPodLogs() {
      return "no checkpoint";
    },
    async delete(resource, requestDigest, uid, configDigest) {
      assert.equal(requestDigest, createRunIdentity(request).requestDigest);
      assert.deepEqual({ uid, configDigest }, resourceBinding(resource));
      deleted.push(resource.kind);
    },
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeRequirements,
      runtimeLaunchBinding,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 1,
      timeoutMs: 100,
    },
  });
  try {
    await assert.rejects(run(request), /exactly one checkpoint/);
    assert.deepEqual(deleted.sort(), [
      "Job",
      "NetworkPolicy",
      "Secret",
      "ServiceAccount",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes credentials/resources when an init failure prevents log retrieval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-init-fail-"));
  const deleted = [];
  const kubernetes = {
    async ensure(resource) { return resourceBinding(resource); },
    async getJob() {
      return { status: { failed: 1 } };
    },
    async listRunPods() {
      return [{ metadata: { name: "agent-pod" } }];
    },
    async getPodLogs() {
      throw new Error("session-gateway container never started");
    },
    async delete(resource) {
      deleted.push(resource.kind);
    },
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeRequirements,
      runtimeLaunchBinding,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 1,
      timeoutMs: 100,
    },
  });
  try {
    await assert.rejects(run(request), /container never started/);
    assert.deepEqual(deleted.sort(), [
      "Job",
      "NetworkPolicy",
      "Secret",
      "ServiceAccount",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation aborts reconciliation and removes every exact run resource", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-cancel-"));
  const deleted = [];
  const cancellation = new AbortController();
  const kubernetes = {
    async ensure(resource) { return resourceBinding(resource); },
    async getJob() {
      cancellation.abort(new Error("operator cancelled"));
      return { status: {} };
    },
    async listRunPods() {
      throw new Error("cancelled reconciliation must not inspect Pod logs");
    },
    async getPodLogs() {
      throw new Error("cancelled reconciliation must not inspect Pod logs");
    },
    async delete(resource) {
      deleted.push(resource.kind);
    },
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeRequirements,
      runtimeLaunchBinding,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    },
  });
  try {
    const result = run(request, cancellation.signal);
    await assert.rejects(result, /operator cancelled|aborted/i);
    assert.deepEqual(deleted.sort(), [
      "Job",
      "NetworkPolicy",
      "Secret",
      "ServiceAccount",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
