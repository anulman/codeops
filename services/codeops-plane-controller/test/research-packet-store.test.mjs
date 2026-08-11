import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileResearchPacketStore } from "../dist/index.js";
import { upgradeResearchPacket } from "./research-fixture.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";
const packet = upgradeResearchPacket({
  version: "codeops.research-packet/v2",
  personas: ["@ai-product"],
  perspectives: [
    {
      persona: "@ai-product",
      outcome: "findings",
      summary: "The product context is bound.",
    },
  ],
  requestId: "research-request:packet-store",
  projectId,
  workItemId,
  baseSha: "a".repeat(40),
  projectContextDigest: `sha256:${"b".repeat(64)}`,
  planeRevisionDigest: `sha256:${"c".repeat(64)}`,
  summary: "The product context is bound.",
  currentBehavior: [],
  expectedBehavior: [],
  evidence: [],
  videoNotApplicableReason: "Contract-only packet.",
  decisions: [],
  proposedMutations: {
    version: "codeops.research-mutation-batch/v1",
    requestId: "research-request:packet-store",
    projectId,
    sourceWorkItemId: workItemId,
    mutations: [],
  },
  createdAt: "2026-07-27T00:00:00.000Z",
});

test("persists one immutable latest research packet across restarts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-packets-"));
  try {
    const first = createFileResearchPacketStore({ rootDirectory: root });
    await first.put(packet);
    await first.put(packet);
    const restarted = createFileResearchPacketStore({ rootDirectory: root });
    assert.deepEqual(
      await restarted.getLatest({ projectId, workItemId }),
      packet,
    );
    await assert.rejects(
      restarted.getLatest({
        projectId: "33333333-3333-4333-8333-333333333333",
        workItemId,
      }),
      /project identity mismatch/,
    );
    await assert.rejects(
      restarted.put({
        ...packet,
        requestId: "research-request:conflict",
        synthesis: {
          ...packet.synthesis,
          requestId: "research-request:conflict",
        },
        proposedMutations: {
          ...packet.proposedMutations,
          requestId: "research-request:conflict",
        },
      }),
      /stale or conflicting replacement/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newer current packet replaces a retained legacy packet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-packets-"));
  try {
    await writeFile(
      path.join(root, `${workItemId}.json`),
      `${JSON.stringify({
        version: "codeops.research-packet/v2",
        requestId: "research-request:legacy",
        projectId,
        workItemId,
        createdAt: "2026-07-26T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const store = createFileResearchPacketStore({ rootDirectory: root });
    await store.put(packet);
    assert.deepEqual(
      await store.getLatest({ projectId, workItemId }),
      packet,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
