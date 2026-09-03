import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRuntimeSessionIdentity } from "../dist/session-identity.js";

const policyJson = JSON.stringify({
  version: "codeops.session-policy/v1",
  mode: "review",
  workspaceAccess: "read-only",
  modelCalls: "allowed",
  modelPolicy: {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
});

test("loads a bounded workspace manifest without legacy repository fields", async () => {
  const identity = await loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_WORKSPACE_FILE: "/run/workspace.json",
      CODEOPS_SESSION_WORKFLOW_ID: "workspace-launch",
      CODEOPS_SESSION_RUN_ID: "launch-123",
      CODEOPS_SESSION_DISPLAY_NAME: "Investigate the estimator",
      CODEOPS_SESSION_POLICY_JSON: policyJson,
      CODEOPS_SESSION_CONTEXT_ATTACHMENTS_JSON: JSON.stringify([{
        attachmentId: "context-brief",
        name: "brief.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        digest: `sha256:${"b".repeat(64)}`,
      }]),
    },
    read: async () => Buffer.from(JSON.stringify({
      version: "codeops.workspace/v1",
      sources: [],
      scratchPath: "scratch",
    })),
  });
  assert.equal(identity.version, "codeops.session-workspace-identity/v1");
  assert.deepEqual(identity.workspace.sources, []);
  assert.equal(identity.displayName, "Investigate the estimator");
  assert.equal(identity.contextAttachments[0].name, "brief.txt");
  assert.equal("repository" in identity, false);
});

test("loads an inline workspace manifest without a credential-bearing volume", async () => {
  const identity = await loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_WORKSPACE_JSON: JSON.stringify({
        version: "codeops.workspace/v1",
        sources: [],
        scratchPath: "scratch",
      }),
      CODEOPS_SESSION_WORKFLOW_ID: "workspace-launch",
      CODEOPS_SESSION_RUN_ID: "launch-123",
      CODEOPS_SESSION_POLICY_JSON: policyJson,
    },
  });
  assert.equal(identity.version, "codeops.session-workspace-identity/v1");
  assert.deepEqual(identity.workspace.sources, []);
});

test("parses the exact admitted child identity without reconstructing root lineage", async () => {
  const exact = {
    version: "codeops.session-workspace-identity/v1",
    policy: JSON.parse(policyJson),
    contextAttachments: [],
    workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
    workflowId: "child-workflow",
    runId: "child-run",
    displayName: "Implement admitted item",
    workItemId: "55555555-5555-4555-8555-555555555555",
    agentRole: "coding",
    round: 2,
    parentSessionId: "session-parent",
    forkedAtCursor: 17,
  };
  const identity = await loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_IDENTITY_JSON: JSON.stringify(exact),
      CODEOPS_SESSION_WORKFLOW_ID: "wrong-root-workflow",
      CODEOPS_SESSION_RUN_ID: "wrong-root-run",
    },
  });
  assert.deepEqual(identity, exact);
});

test("rejects ambiguous inline and file workspace identity", async () => {
  await assert.rejects(loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_WORKSPACE_JSON: "{}",
      CODEOPS_SESSION_WORKSPACE_FILE: "/run/workspace.json",
      CODEOPS_SESSION_WORKFLOW_ID: "workspace-launch",
      CODEOPS_SESSION_RUN_ID: "launch-123",
    },
  }), /one manifest input/);
});

test("keeps the legacy single-repository environment compatible", async () => {
  const identity = await loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_REPOSITORY: "example-org/example-repository",
      CODEOPS_SESSION_BRANCH: "main",
      CODEOPS_SESSION_BASE_SHA: "a".repeat(40),
      CODEOPS_SESSION_WORKFLOW_ID: "legacy-workflow",
      CODEOPS_SESSION_RUN_ID: "legacy-run",
    },
  });
  assert.equal(identity.repository, "example-org/example-repository");
});
