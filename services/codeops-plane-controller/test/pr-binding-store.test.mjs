import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createFilePullRequestBindingStore,
  storedPullRequestBindingSchema,
} from "../dist/index.js";

const binding = {
  version: "codeops.pull-request-binding/v1",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
  workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  workflowId: "coding-123",
  repository: "anulman/renoconcierge",
  number: 158,
  state: "open",
  headSha: "a".repeat(40),
  headRef: "feat/a",
  baseRef: "main",
  qualified: true,
  updatedAt: "2026-07-30T21:00:00.000Z",
};

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-pr-store-"));
  try {
    await run(createFilePullRequestBindingStore({ rootDirectory: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("persists and resolves one immutable PR identity by ticket or PR", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    await store.put(binding);
    assert.deepEqual(await store.getByWorkItem(binding.workItemId), binding);
    assert.deepEqual(
      await store.getByPullRequest({
        repository: binding.repository,
        number: binding.number,
      }),
      binding,
    );
  });
});

test("requires stacked bindings to identify their base ticket", () => {
  assert.throws(
    () =>
      storedPullRequestBindingSchema.parse({
        ...binding,
        baseRef: "feat/parent",
      }),
    /base ticket/,
  );
  assert.doesNotThrow(() =>
    storedPullRequestBindingSchema.parse({
      ...binding,
      baseRef: "feat/parent",
      baseTicketId: "9ce2ec60-90ab-4417-bc0f-802c349885d6",
    }),
  );
});

test("permits one fail-closed stacked PR retarget to main while retaining provenance", async () => {
  await withStore(async (store) => {
    const stacked = {
      ...binding,
      baseRef: "feat/parent",
      baseTicketId: "9ce2ec60-90ab-4417-bc0f-802c349885d6",
    };
    await store.put(stacked);
    await store.put({
      ...stacked,
      baseRef: "main",
      qualified: false,
      updatedAt: "2026-07-30T21:01:00.000Z",
    });
    const retargeted = await store.getByWorkItem(binding.workItemId);
    assert.equal(retargeted.baseRef, "main");
    assert.equal(retargeted.baseTicketId, stacked.baseTicketId);
    assert.equal(retargeted.qualified, false);
    await assert.rejects(
      store.put({
        ...retargeted,
        baseRef: "feat/other",
        updatedAt: "2026-07-30T21:02:00.000Z",
      }),
      /base retarget is invalid/,
    );
  });
});

test("allows monotonic state updates but fails closed on identity drift", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    await store.put({
      ...binding,
      state: "merged",
      qualified: false,
      updatedAt: "2026-07-30T22:00:00.000Z",
    });
    assert.equal((await store.getByWorkItem(binding.workItemId)).state, "merged");
    await assert.rejects(
      store.put({
        ...binding,
        number: 159,
        updatedAt: "2026-07-30T23:00:00.000Z",
      }),
      /identity is immutable/,
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

test("requires head changes to clear qualification before later requalification", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    await assert.rejects(
      store.put({
        ...binding,
        headSha: "b".repeat(40),
        updatedAt: "2026-07-30T22:00:00.000Z",
      }),
      /must be requalified/,
    );
    await store.put({
      ...binding,
      headSha: "b".repeat(40),
      qualified: false,
      updatedAt: "2026-07-30T22:00:00.000Z",
    });
    await store.put({
      ...binding,
      headSha: "b".repeat(40),
      qualified: true,
      updatedAt: "2026-07-30T23:00:00.000Z",
    });
    assert.equal((await store.getByWorkItem(binding.workItemId)).qualified, true);
  });
});

test("rejects unsafe roots and closed qualified bindings", () => {
  assert.throws(
    () => createFilePullRequestBindingStore({ rootDirectory: "relative" }),
    /absolute/,
  );
  assert.throws(
    () =>
      storedPullRequestBindingSchema.parse({
        ...binding,
        state: "closed",
      }),
    /only an open PR/,
  );
});

test("retains immutable native-stack provenance across rewrites and unstacking", async () => {
  await withStore(async (store) => {
    await store.put(binding);
    const stacked = {
      ...binding,
      qualified: false,
      nativeStack: {
        number: 42,
        size: 2,
        position: 2,
        base: { ref: "main", sha: "0".repeat(40) },
        active: true,
      },
      updatedAt: "2026-07-30T21:01:00.000Z",
    };
    await store.put(stacked);
    await store.put({
      ...stacked,
      headSha: "b".repeat(40),
      nativeStack: {
        ...stacked.nativeStack,
        base: { ref: "main", sha: "1".repeat(40) },
      },
      updatedAt: "2026-07-30T21:02:00.000Z",
    });
    await store.put({
      ...stacked,
      headSha: "b".repeat(40),
      nativeStack: {
        ...stacked.nativeStack,
        active: false,
      },
      updatedAt: "2026-07-30T21:03:00.000Z",
    });
    const unstacked = await store.getByWorkItem(binding.workItemId);
    assert.equal(unstacked.nativeStack.number, 42);
    assert.equal(unstacked.nativeStack.active, false);
    await assert.rejects(
      store.put({
        ...unstacked,
        nativeStack: {
          ...unstacked.nativeStack,
          number: 43,
          active: true,
        },
        updatedAt: "2026-07-30T21:04:00.000Z",
      }),
      /provenance is immutable/,
    );
    assert.throws(() =>
      storedPullRequestBindingSchema.parse({
        ...unstacked,
        qualified: true,
      }),
    );
  });
});
