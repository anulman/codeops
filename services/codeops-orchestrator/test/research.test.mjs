import assert from "node:assert/strict";
import test from "node:test";
import { createProjectContext } from "@renoconcierge/codeops-contracts";
import { buildResearchPacket } from "../dist/research.js";

const projectContext = createProjectContext({
  version: "codeops.project-context/v1",
  repository: { owner: "anulman", name: "renoconcierge" },
  controlPlaneSha: "b".repeat(40),
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
      digest:
        "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
      content: "# Repository guidance\n",
    },
  ],
});

const request = {
  version: "codeops.research-request/v3",
  requestId: "research-request-1",
  workspaceId: projectContext.project.workspaceId,
  projectId: projectContext.project.projectId,
  workItemId: "22222222-2222-4222-8222-222222222222",
  triggerCommentId: "33333333-3333-4333-8333-333333333333",
  requestedBy: "44444444-4444-4444-8444-444444444444",
  repository: { owner: "anulman", name: "renoconcierge" },
  controlPlaneSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  projectContext,
  ticketSnapshot: {
    workItemId: "22222222-2222-4222-8222-222222222222",
    name: "Inventory canonical auth states",
    descriptionHtml: "<p>Define the matrix.</p>",
    priority: "high",
    stateId: "66666666-6666-4666-8666-666666666666",
    labelIds: [],
    assigneeIds: [],
    moduleId: null,
    parentId: null,
    updatedAt: "2026-07-26T00:00:00.000Z",
    relevantComments: [],
    relations: [],
    projectTasks: [
      {
        workItemId: "77777777-7777-4777-8777-777777777777",
        name: "Existing auth hardening task",
        descriptionHtml: "<p>Preserve this context.</p>",
        descriptionDigest: `sha256:${"e".repeat(64)}`,
        priority: "high",
        stateId: "88888888-8888-4888-8888-888888888888",
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  },
  personas: ["@ai-security", "@ai-web"],
  brief: "Inspect authentication contracts.",
  requestedAt: "2026-07-26T00:00:00.000Z",
};

function personaResult(persona, suffix) {
  return {
    version: "codeops.agent-job-dispatch-result/v1",
    role: "qa-contract-researcher",
    runId: `research-${suffix}`,
    checkpointUri: `artifact:///agent-runs/research-${suffix}/checkpoint.json`,
    checkpointDigest: `sha256:${suffix.repeat(64)}`,
    checkpointSizeBytes: 123,
    patchUri: `artifact:///agent-runs/research-${suffix}/changes.patch`,
    patchDigest: `sha256:${"0".repeat(64)}`,
    patchSizeBytes: 0,
    researchResult: {
      kind: "persona",
      report: {
        version: "codeops.research-persona-report/v2",
        requestId: request.requestId,
        persona,
        outcome: "findings",
        summary: `${persona} found a bounded issue.`,
        findings: [],
        decisions: [],
        citations: [],
      },
    },
  };
}

function synthesisResult() {
  return {
    version: "codeops.agent-job-dispatch-result/v1",
    role: "qa-contract-researcher",
    runId: "research-synthesis",
    checkpointUri:
      "artifact:///agent-runs/research-synthesis/checkpoint.json",
    checkpointDigest: `sha256:${"d".repeat(64)}`,
    checkpointSizeBytes: 456,
    patchUri: "artifact:///agent-runs/research-synthesis/changes.patch",
    patchDigest: `sha256:${"0".repeat(64)}`,
    patchSizeBytes: 0,
    researchResult: {
      kind: "synthesis",
      synthesis: {
        version: "codeops.research-synthesis/v1",
        requestId: request.requestId,
        verdict: "ready-to-refine",
        summary: "One ticket-specific contract is now explicit.",
        topFindings: [
          {
            id: "finding-1",
            category: "matrix-fact",
            severity: "high",
            confidence: "high",
            currentBehavior: "The current route is ambiguous.",
            expectedBehavior: "The route has one deterministic oracle.",
            citationIds: ["citation-1"],
          },
        ],
        decisions: [],
        downstreamFindings: [],
        followUpTasks: [
          {
            key: "db-auth-evidence",
            area: "database",
            targetWorkItemId: "77777777-7777-4777-8777-777777777777",
            title: "Harden database auth evidence",
            objective: "Restrict identity evidence mutations.",
            acceptanceCriteria: ["Runtime roles cannot rewrite identity evidence."],
            sourceFindingIds: ["finding-1"],
            citationIds: ["citation-1"],
          },
          {
            key: "otp-rate-limit",
            area: "security",
            targetWorkItemId: null,
            title: "Bound OTP verification attempts",
            objective: "Prevent unbounded OTP guessing.",
            acceptanceCriteria: ["Attempts are bounded per active challenge."],
            sourceFindingIds: ["finding-1"],
            citationIds: ["citation-1"],
          },
        ],
        matrix: {
          version: "codeops.route-state-credential-matrix/v1",
          rows: [
            {
              id: "matrix-1",
              lifecycleState: "qualified",
              credentialState: "valid",
              routeOrRpc: "/claim",
              currentOracle: "Ambiguous",
              expectedOracle: "Deterministic",
              allowedSideEffects: "None",
              status: "gap",
              citationIds: ["citation-1"],
            },
          ],
        },
        citations: [
          {
            id: "citation-1",
            path: "services/auth.ts",
            lineStart: 10,
            lineEnd: 12,
            testName: "rejects wrong-file cookies",
            claim: "The route does not bind the file.",
          },
        ],
      },
    },
  };
}

test("assembles one deterministic source-ticket refinement in requested persona order", () => {
  const packet = buildResearchPacket({
    request,
    personaDispatches: [
      personaResult("@ai-security", "a"),
      personaResult("@ai-web", "c"),
    ],
    synthesisDispatch: synthesisResult(),
  });
  assert.deepEqual(
    packet.perspectives.map((perspective) => perspective.persona),
    request.personas,
  );
  assert.deepEqual(
    packet.proposedMutations.mutations.map((mutation) => mutation.type),
    ["ticket.update", "task.upsert", "task.upsert", "comment.create"],
  );
  assert.equal(
    packet.proposedMutations.mutations[1].key,
    "otp-rate-limit",
  );
  assert.equal(
    packet.proposedMutations.mutations[2].expectedDescriptionDigest,
    `sha256:${"e".repeat(64)}`,
  );
  assert.match(
    packet.proposedMutations.mutations[0].changes.descriptionHtml,
    /route\/state\/credential matrix/i,
  );
  assert.match(
    packet.proposedMutations.mutations.at(-1).bodyHtml,
    /github\.com\/anulman\/renoconcierge\/blob\/a{40}/,
  );
  assert.equal(packet.evidence.length, 3);
  assert.equal(packet.createdAt, request.requestedAt);
});

test("bounds the rendered ticket description while retaining the versioned matrix", () => {
  const synthesisDispatch = synthesisResult();
  const synthesis = synthesisDispatch.researchResult.synthesis;
  const citation = synthesis.citations[0];
  synthesis.matrix.rows = Array.from({ length: 50 }, (_, index) => ({
    ...synthesis.matrix.rows[0],
    id: `matrix-${index + 1}`,
    routeOrRpc: `/customer-files/${"route".repeat(150)}-${index}`,
    currentOracle: `Current ${"ambiguous ".repeat(180)}`,
    expectedOracle: `Expected ${"deterministic ".repeat(140)}`,
    allowedSideEffects: `Allowed ${"none ".repeat(240)}`,
    citationIds: [citation.id],
  }));

  const packet = buildResearchPacket({
    request,
    personaDispatches: [
      personaResult("@ai-security", "a"),
      personaResult("@ai-web", "c"),
    ],
    synthesisDispatch,
  });
  const description =
    packet.proposedMutations.mutations[0].changes.descriptionHtml;
  assert.ok(description.length <= 50_000);
  assert.match(description, /route\/state\/credential matrix/i);
  assert.match(description, /Showing \d+ of 50 rows/);
  assert.match(description, /complete versioned matrix remains in the research packet/i);
});

test("rejects missing, reordered, or identity-drifted persona reports", () => {
  assert.throws(() =>
    buildResearchPacket({
      request,
      personaDispatches: [personaResult("@ai-security", "a")],
      synthesisDispatch: synthesisResult(),
    }),
  );
  assert.throws(() =>
    buildResearchPacket({
      request,
      personaDispatches: [
        personaResult("@ai-web", "c"),
        personaResult("@ai-security", "a"),
      ],
      synthesisDispatch: synthesisResult(),
    }),
  );
});
