import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFileResearchDedupLedger,
  projectResearchPacket,
} from "../dist/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";
const evidence = {
  version: "codeops.evidence/v1",
  kind: "checkpoint",
  uri: "artifact:///agent-runs/research-a/checkpoint.json",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 123,
  mediaType: "application/json",
};
const packet = {
  version: "codeops.research-packet/v2",
  personas: ["@ai-security"],
  perspectives: [
    {
      persona: "@ai-security",
      outcome: "findings",
      summary: "Authentication boundaries need qualification.",
    },
  ],
  requestId: "research-request-1",
  projectId,
  workItemId,
  baseSha: "b".repeat(40),
  projectContextDigest: `sha256:${"d".repeat(64)}`,
  planeRevisionDigest: `sha256:${"c".repeat(64)}`,
  summary: "Authentication boundaries need qualification.",
  currentBehavior: ["The current route matrix is incomplete."],
  expectedBehavior: ["Every route has an explicit contract."],
  evidence: [evidence],
  videoNotApplicableReason: "This is a repository-contract review.",
  decisions: [],
  proposedMutations: {
    version: "codeops.research-mutation-batch/v1",
    requestId: "research-request-1",
    projectId,
    sourceWorkItemId: workItemId,
    mutations: [
      {
        type: "comment.create",
        targetWorkItemId: workItemId,
        bodyHtml: "<p>Bounded findings</p>",
        attachments: [evidence],
      },
    ],
  },
  createdAt: "2026-07-26T00:00:00.000Z",
};

function client(comments) {
  return {
    async getWorkItem() {
      return { id: workItemId, project: projectId, labels: [] };
    },
    async listLabels() {
      return [];
    },
    async createComment(_projectId, _workItemId, input) {
      comments.push(input);
      return { id: "33333333-3333-4333-8333-333333333333" };
    },
    async createLabel() {
      throw new Error("unexpected label creation");
    },
    async updateLabel() {
      throw new Error("unexpected label update");
    },
    async updateProject() {
      throw new Error("unexpected project update");
    },
    async updateWorkItem() {
      throw new Error("unexpected work-item update");
    },
    async createWorkItem() {
      throw new Error("unexpected work-item creation");
    },
  };
}

const packetStore = {
  async put() {},
};

test("durably applies one content-only projection and deduplicates restart retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-projection-"));
  const comments = [];
  const ledger = createFileResearchDedupLedger({
    rootDirectory: root,
    leaseDurationMs: 60_000,
  });
  try {
    const first = await projectResearchPacket({
      packet,
      ledger,
      packetStore,
      client: client(comments),
      now: () => "2026-07-26T00:01:00.000Z",
    });
    const retry = await projectResearchPacket({
      packet,
      ledger,
      packetStore,
      client: client(comments),
      now: () => "2026-07-26T00:02:00.000Z",
    });
    assert.deepEqual(first, {
      status: "applied",
      requestId: packet.requestId,
      mutationCount: 1,
    });
    assert.deepEqual(retry, {
      status: "duplicate",
      requestId: packet.requestId,
      mutationCount: 1,
    });
    assert.equal(comments.length, 1);
    assert.equal(comments[0].external_source, "codeops");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects projection identity drift and every non-comment Trial 0 mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-projection-bad-"));
  const ledger = createFileResearchDedupLedger({
    rootDirectory: root,
    leaseDurationMs: 60_000,
  });
  try {
    await assert.rejects(
      projectResearchPacket({
        packet: {
          ...packet,
          proposedMutations: {
            ...packet.proposedMutations,
            requestId: "research-request-other",
          },
        },
        ledger,
        packetStore,
        client: client([]),
      }),
    );
    await assert.rejects(
      projectResearchPacket({
        packet: {
          ...packet,
          proposedMutations: {
            ...packet.proposedMutations,
            mutations: [
              {
                type: "ticket.create",
                name: "Not admitted",
                descriptionHtml: "<p>No</p>",
                labelKeys: [],
              },
            ],
          },
        },
        ledger,
        packetStore,
        client: client([]),
      }),
      /one source-ticket comment/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
