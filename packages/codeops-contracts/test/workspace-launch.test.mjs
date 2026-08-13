import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceCatalogSchema,
  workspaceCheckpointSchema,
  workspaceLaunchRequestSchema,
  workspaceLaunchSchema,
  workspaceLaunchSessionId,
  workspaceManifestSchema,
  workspaceSessionLaunchId,
} from "../dist/workspace-launch.js";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

test("maps one workspace launch to its optimistic session route", () => {
  const launchId = "launch-0123456789abcdef01234567";
  const sessionId = "ses_0123456789abcdef01234567";
  assert.equal(workspaceLaunchSessionId(launchId), sessionId);
  assert.equal(workspaceSessionLaunchId(sessionId), launchId);
  assert.equal(workspaceSessionLaunchId("ses_regular-session"), null);
  assert.throws(() => workspaceLaunchSessionId("launch-invalid"));
});

test("accepts a first-class scratch workspace launch", () => {
  assert.deepEqual(
    workspaceLaunchRequestSchema.parse({
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      prompt: "Write a one-off CSV normalization script.",
      sources: [],
    }).sources,
    [],
  );
});

test("accepts up to four unique catalog sources", () => {
  const sources = ["codeops", "renoconcierge", "understudy", "vocalpitch"].map(
    (catalogKey) => ({ catalogKey }),
  );
  assert.equal(
    workspaceLaunchRequestSchema.parse({
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      prompt: "Update the shared contract.",
      sources,
    }).sources.length,
    4,
  );
  assert.throws(() =>
    workspaceLaunchRequestSchema.parse({
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      prompt: "Too many.",
      sources: [...sources, { catalogKey: "fifth" }],
    }),
  );
  assert.throws(() =>
    workspaceLaunchRequestSchema.parse({
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      prompt: "Duplicate.",
      sources: [{ catalogKey: "codeops" }, { catalogKey: "codeops" }],
    }),
  );
});

test("binds resolved sources to unique derived checkout paths", () => {
  const workspace = workspaceManifestSchema.parse({
    version: "codeops.workspace/v1",
    sources: [
      {
        catalogKey: "codeops",
        repository: "anulman/codeops",
        checkoutPath: "sources/codeops",
        requestedRef: "main",
        resolvedSha: sha,
      },
    ],
    scratchPath: "scratch",
  });
  assert.equal(workspace.sources[0].resolvedSha, sha);
  assert.throws(() =>
    workspaceManifestSchema.parse({
      ...workspace,
      sources: [workspace.sources[0], workspace.sources[0]],
    }),
  );
});

test("keeps catalog labels separate from source authority", () => {
  const catalog = workspaceCatalogSchema.parse({
    version: "codeops.workspace-catalog/v1",
    repositories: [
      {
        key: "codeops",
        label: "CodeOps",
        repository: "anulman/codeops",
        defaultRef: "main",
      },
    ],
  });
  assert.equal(catalog.repositories[0].key, "codeops");
  assert.equal(JSON.stringify(catalog).includes("token"), false);
});

test("records durable launch state without the prompt body", () => {
  const launch = workspaceLaunchSchema.parse({
    version: "codeops.workspace-launch/v1",
    launchId: "launch-1",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    principalId: "anulman@gmail.com",
    requestDigest: digest,
    promptDigest: digest,
    workspace: {
      version: "codeops.workspace/v1",
      sources: [],
      scratchPath: "scratch",
    },
    state: "queued",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
    deadlineAt: "2026-08-13T18:00:00.000Z",
    attemptCount: 0,
  });
  assert.equal("prompt" in launch, false);
});

test("groups checkpoint evidence by source and scratch artifact", () => {
  const checkpoint = workspaceCheckpointSchema.parse({
    version: "codeops.workspace-checkpoint/v1",
    workspaceManifestDigest: digest,
    sourcePatches: [
      {
        catalogKey: "codeops",
        repository: "anulman/codeops",
        baseSha: sha,
        patchDigest: digest,
      },
    ],
    scratchArtifactDigest: digest,
  });
  assert.equal(checkpoint.sourcePatches.length, 1);
});
