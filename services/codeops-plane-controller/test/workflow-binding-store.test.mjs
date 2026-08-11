import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileWorkflowBindingStore } from "../dist/index.js";

const binding = {
  version: "codeops.workflow-binding/v1",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
  workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  repository: "example-org/example-repository",
  workflowId: "coding-123",
  status: "active",
  baseSha: "a".repeat(40),
  branch: "codeops/a",
  updatedAt: "2026-07-30T21:00:00.000Z",
};

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-workflow-store-"));
  try {
    await run(createFileWorkflowBindingStore({ rootDirectory: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("persists one immutable workflow identity through terminal state", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    assert.deepEqual(await store.getByWorkItem(binding.workItemId), binding);
    await store.put({
      ...binding,
      status: "terminal",
      updatedAt: "2026-07-30T22:00:00.000Z",
    });
    assert.equal(
      (await store.getByWorkItem(binding.workItemId)).status,
      "terminal",
    );
    await assert.rejects(
      store.put({
        ...binding,
        updatedAt: "2026-07-30T23:00:00.000Z",
      }),
      /terminal/,
    );
  });
});

test("fails closed on workflow identity drift and unsafe roots", async () => {
  assert.throws(
    () => createFileWorkflowBindingStore({ rootDirectory: "relative" }),
    /absolute/,
  );
  await withStore(async (store) => {
    await store.put(binding);
    await assert.rejects(
      store.put({
        ...binding,
        workflowId: "coding-other",
        updatedAt: "2026-07-30T22:00:00.000Z",
      }),
      /only a terminal workflow/,
    );
    await assert.rejects(
      store.put({
        ...binding,
        repository: "anulman/codeops",
        updatedAt: "2026-07-30T22:00:00.000Z",
      }),
      /identity is immutable/,
    );
  });
});

test("advances one terminal workflow to an exact active PR revision", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    await store.put({
      ...binding,
      status: "terminal",
      updatedAt: "2026-07-30T22:00:00.000Z",
    });
    const revision = {
      ...binding,
      workflowId: "review-123",
      baseSha: "b".repeat(40),
      status: "active",
      updatedAt: "2026-07-30T23:00:00.000Z",
    };
    await store.put(revision);
    assert.deepEqual(await store.getByWorkItem(binding.workItemId), revision);
    await assert.rejects(
      store.put({
        ...revision,
        workflowId: "review-other",
        updatedAt: "2026-07-30T23:01:00.000Z",
      }),
      /only a terminal workflow/,
    );
  });
});
