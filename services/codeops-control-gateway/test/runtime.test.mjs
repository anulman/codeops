import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentJobDispatchRequestSchema,
  createProjectContext,
} from "@codeops/codeops-contracts";
import { createRunIdentity } from "../dist/core.js";
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
  const kubernetes = {
    async ensure(resource) {
      ensured.push(`${resource.kind}/${resource.metadata.name}`);
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
    async delete(resource) {
      deleted.push(`${resource.kind}/${resource.metadata.name}`);
    },
  };
  const run = createAgentJobRunner({
    kubernetes,
    config: {
      namespace: "codeops",
      repositoryRegistry,
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 1,
      timeoutMs: 100,
    },
  });
  try {
    const first = await run(request);
    const second = await run(request);
    assert.deepEqual(second, first);
    assert.equal(ensured.length, 4);
    assert.equal(deleted.length, 8);
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
    async ensure() {},
    async getJob() {
      return { status: { failed: 1 } };
    },
    async listRunPods() {
      return [{ metadata: { name: "agent-pod" } }];
    },
    async getPodLogs() {
      return "no checkpoint";
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
    async ensure() {},
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
  const kubernetes = {
    async ensure() {},
    async getJob() {
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
      modelAuth,
      evidenceRoot: root,
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    },
  });
  const cancellation = new AbortController();
  try {
    const result = run(request, cancellation.signal);
    setTimeout(() => cancellation.abort(new Error("operator cancelled")), 5);
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
