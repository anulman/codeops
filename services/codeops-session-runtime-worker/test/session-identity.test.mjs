import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRuntimeSessionIdentity } from "../dist/session-identity.js";

test("loads a bounded workspace manifest without legacy repository fields", async () => {
  const identity = await loadRuntimeSessionIdentity({
    env: {
      CODEOPS_SESSION_WORKSPACE_FILE: "/run/workspace.json",
      CODEOPS_SESSION_WORKFLOW_ID: "workspace-launch",
      CODEOPS_SESSION_RUN_ID: "launch-123",
    },
    read: async () => Buffer.from(JSON.stringify({
      version: "codeops.workspace/v1",
      sources: [],
      scratchPath: "scratch",
    })),
  });
  assert.equal(identity.version, "codeops.session-workspace-identity/v1");
  assert.deepEqual(identity.workspace.sources, []);
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
    },
  });
  assert.equal(identity.version, "codeops.session-workspace-identity/v1");
  assert.deepEqual(identity.workspace.sources, []);
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
