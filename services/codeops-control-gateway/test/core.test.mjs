import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectContext } from "@renoconcierge/codeops-contracts";
import {
  authenticateBearer,
  createRunIdentity,
  parseCheckpointLogs,
  readRetainedResult,
  retainCheckpoint,
} from "../dist/core.js";
import { assertRunResources, buildRunResources } from "../dist/resources.js";

const projectContext = createProjectContext({
  version: "codeops.project-context/v1",
  repository: { owner: "anulman", name: "renoconcierge" },
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
      digest: `sha256:${"1".repeat(64)}`,
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
  researchPersona: "@ai-security",
  researchRequest: {
    version: "codeops.research-request/v2",
    requestId: "research-request-1",
    workspaceId: projectContext.project.workspaceId,
    projectId: "11111111-1111-4111-8111-111111111111",
    workItemId: "22222222-2222-4222-8222-222222222222",
    triggerCommentId: "33333333-3333-4333-8333-333333333333",
    requestedBy: "44444444-4444-4444-8444-444444444444",
    repository: { owner: "anulman", name: "renoconcierge" },
    baseSha: "a".repeat(40),
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    projectContext,
    personas: ["@ai-security"],
    brief: "Inspect auth",
    requestedAt: "2026-07-26T00:00:00.000Z",
  },
};

function checkpointLogs(runId, overrides = {}) {
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
    schemaVersion: 3,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest: projectContext.digest,
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
    ...overrides,
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

test("authenticates one exact bearer token", () => {
  const token = "t".repeat(64);
  assert.equal(authenticateBearer(`Bearer ${token}`, token), true);
  assert.equal(authenticateBearer(`Bearer ${"x".repeat(64)}`, token), false);
  assert.equal(authenticateBearer(undefined, token), false);
});

test("derives a stable bounded run identity", () => {
  assert.deepEqual(createRunIdentity(request), createRunIdentity(request));
  assert.match(createRunIdentity(request).runId, /^agent-[0-9a-f]{24}$/);
  assert.notDeepEqual(
    createRunIdentity(request),
    createRunIdentity({ ...request, summary: "different" }),
  );
});

test("validates checkpoint identity, digest, patch, and research immutability", () => {
  const runId = createRunIdentity(request).runId;
  const parsed = parseCheckpointLogs({
    logs: checkpointLogs(runId),
    request,
    runId,
  });
  assert.equal(parsed.patch.length, 0);
  assert.throws(() =>
    parseCheckpointLogs({
      logs: checkpointLogs(runId, { baseSha: "b".repeat(40) }),
      request,
      runId,
    }),
  );
  assert.throws(() =>
    parseCheckpointLogs({
      logs: checkpointLogs(runId).replace(
        '"dataBase64":""',
        '"dataBase64":"YQ=="',
      ),
      request,
      runId,
    }),
  );
  const failureCheckpoint = {
    schemaVersion: 3,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest: projectContext.digest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: "",
    events: [],
    error: "Codex failed before producing a response",
    patch: {
      path: "changes.patch",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    },
  };
  const failureLogs = JSON.stringify({
    type: "codeops.checkpoint",
    checkpointDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(failureCheckpoint))
      .digest("hex")}`,
    checkpoint: failureCheckpoint,
  });
  assert.throws(
    () => parseCheckpointLogs({ logs: failureLogs, request, runId }),
    /checkpoint reported failure/,
  );
});

test("retains one idempotent digest-bound result", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-gateway-"));
  const identity = createRunIdentity(request);
  const retained = parseCheckpointLogs({
    logs: checkpointLogs(identity.runId),
    request,
    runId: identity.runId,
  });
  try {
    const result = await retainCheckpoint({
      rootDirectory,
      request,
      ...identity,
      retained,
    });
    assert.deepEqual(
      await readRetainedResult({ rootDirectory, ...identity }),
      result,
    );
    assert.equal(
      await readFile(
        path.join(
          rootDirectory,
          "agent-runs",
          identity.runId,
          "changes.patch",
        ),
      ).then((value) => value.length),
      0,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("builds only the fixed tokenless run resources", () => {
  const identity = createRunIdentity(request);
  const resources = buildRunResources(
    {
      namespace: "codeops-trial",
      ...identity,
      repositoryUrl: "https://github.com/anulman/renoconcierge",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      repositoryReadToken: "repo-token",
      modelApiKey: "model-key",
    },
    request,
  );
  assert.doesNotThrow(() => assertRunResources(resources));
  assert.deepEqual(
    resources.map((resource) => resource.kind),
    ["Secret", "ServiceAccount", "Job", "NetworkPolicy"],
  );
  const workspaceBuilder =
    resources[2].spec.template.spec.initContainers[0].command.at(-1);
  assert.match(
    workspaceBuilder,
    /git -c safe\.directory=\/workspace -C \/workspace/,
  );
  assert.equal(workspaceBuilder.includes("safe.directory=*"), false);
  const codingAgent = resources[2].spec.template.spec.containers.find(
    (container) => container.name === "coding-agent",
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "CODEX_HOME").value,
    "/tmp/codex-home",
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "CODEX_CONFIG").value,
    '{"model":"gpt-5.6-sol","model_reasoning_effort":"high"}',
  );
  assert.equal(JSON.stringify(resources).includes("automountServiceAccountToken\":true"), false);
});
