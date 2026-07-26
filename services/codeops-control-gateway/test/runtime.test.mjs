import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunIdentity } from "../dist/core.js";
import { createAgentJobRunner } from "../dist/runtime.js";

const request = {
  version: "codeops.agent-job-dispatch/v1",
  workItemId: "22222222-2222-4222-8222-222222222222",
  workflowId: "research-request-1",
  baseSha: "a".repeat(40),
  summary: "Research auth",
  role: "qa-contract-researcher",
  researchPersona: "@ai-security",
  researchRequest: {
    version: "codeops.research-request/v2",
    requestId: "research-request-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    workItemId: "22222222-2222-4222-8222-222222222222",
    triggerCommentId: "33333333-3333-4333-8333-333333333333",
    requestedBy: "44444444-4444-4444-8444-444444444444",
    repository: { owner: "anulman", name: "renoconcierge" },
    baseSha: "a".repeat(40),
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    personas: ["@ai-security"],
    brief: "Inspect auth",
    requestedAt: "2026-07-26T00:00:00.000Z",
  },
};

function logs(runId) {
  const report = {
    version: "codeops.research-persona-report/v1",
    requestId: "research-request-1",
    persona: "@ai-security",
    outcome: "findings",
    summary: "Authentication boundaries need qualification.",
    currentBehavior: ["The current matrix is incomplete."],
    expectedBehavior: ["Every route has an explicit contract."],
    decisions: [],
  };
  const checkpoint = {
    schemaVersion: 2,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
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
      repositoryUrl: "https://github.com/anulman/renoconcierge",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      repositoryReadToken: "repo-token",
      modelApiKey: "model-key",
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
      repositoryUrl: "https://github.com/anulman/renoconcierge",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      repositoryReadToken: "repo-token",
      modelApiKey: "model-key",
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
