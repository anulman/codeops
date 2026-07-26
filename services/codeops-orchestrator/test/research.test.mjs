import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchPacket } from "../dist/research.js";

const request = {
  version: "codeops.research-request/v2",
  requestId: "research-request-1",
  projectId: "11111111-1111-4111-8111-111111111111",
  workItemId: "22222222-2222-4222-8222-222222222222",
  triggerCommentId: "33333333-3333-4333-8333-333333333333",
  requestedBy: "44444444-4444-4444-8444-444444444444",
  repository: { owner: "anulman", name: "renoconcierge" },
  baseSha: "a".repeat(40),
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  personas: ["@ai-security", "@ai-web"],
  brief: "Inspect authentication contracts.",
  requestedAt: "2026-07-26T00:00:00.000Z",
};

function result(persona, suffix) {
  return {
    version: "codeops.agent-job-dispatch-result/v1",
    role: "qa-contract-researcher",
    runId: `research-${suffix}`,
    checkpointUri: `artifact:///agent-runs/research-${suffix}/checkpoint.json`,
    checkpointDigest: `sha256:${suffix.repeat(64)}`,
    checkpointSizeBytes: 123,
    researchReport: {
      version: "codeops.research-persona-report/v1",
      requestId: request.requestId,
      persona,
      outcome: "findings",
      summary: `${persona} found a bounded issue.`,
      currentBehavior: [`Current <${persona}>`],
      expectedBehavior: [`Expected ${persona}`],
      decisions: [],
    },
  };
}

test("assembles one deterministic content-only packet in requested persona order", () => {
  const packet = buildResearchPacket({
    request,
    dispatches: [result("@ai-security", "a"), result("@ai-web", "c")],
    createdAt: "2026-07-26T01:00:00.000Z",
  });
  assert.deepEqual(
    packet.perspectives.map((perspective) => perspective.persona),
    request.personas,
  );
  assert.equal(packet.proposedMutations.mutations.length, 1);
  assert.equal(packet.proposedMutations.mutations[0].type, "comment.create");
  assert.doesNotMatch(
    packet.proposedMutations.mutations[0].bodyHtml,
    /<@ai-security>/,
  );
  assert.equal(packet.evidence.length, 2);
});

test("rejects missing, reordered, or identity-drifted reports", () => {
  assert.throws(() =>
    buildResearchPacket({
      request,
      dispatches: [result("@ai-security", "a")],
      createdAt: "2026-07-26T01:00:00.000Z",
    }),
  );
  assert.throws(() =>
    buildResearchPacket({
      request,
      dispatches: [result("@ai-web", "c"), result("@ai-security", "a")],
      createdAt: "2026-07-26T01:00:00.000Z",
    }),
  );
});
