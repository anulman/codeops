import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import { canonicalSerialize } from "@renoconcierge/codeops-contracts";
import {
  dispatchAgentJob,
  publishResearchPacket,
  recordTransition,
} from "../dist/activities.js";
import { transition } from "../dist/model.js";

const projectContext = {
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
  digest: "PLACEHOLDER",
};
// Match the contract's canonical identity digest without coupling activity
// fixtures to controller helpers.
projectContext.digest = `sha256:${createHash("sha256")
  .update(
    canonicalSerialize(
      Object.fromEntries(
        Object.entries(projectContext).filter(([key]) => key !== "digest"),
      ),
    ),
  )
  .digest("hex")}`;

const projectionPacket = {
  version: "codeops.research-packet/v3",
  personas: ["@ai-security"],
  perspectives: [
    {
      persona: "@ai-security",
      outcome: "findings",
      summary: "Authentication boundaries need qualification.",
    },
  ],
  requestId: "research-request-1",
  projectId: "11111111-1111-4111-8111-111111111111",
  workItemId: "22222222-2222-4222-8222-222222222222",
  baseSha: "a".repeat(40),
  projectContextDigest: projectContext.digest,
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  summary: "Authentication boundaries need qualification.",
  synthesis: {
    version: "codeops.research-synthesis/v1",
    requestId: "research-request-1",
    verdict: "ready-to-refine",
    summary: "Authentication boundaries need qualification.",
    topFindings: [],
    decisions: [],
    downstreamFindings: [],
    followUpTasks: [],
    matrix: {
      version: "codeops.route-state-credential-matrix/v1",
      rows: [
        {
          id: "matrix-1",
          lifecycleState: "qualified",
          credentialState: "valid",
          routeOrRpc: "/claim",
          currentOracle: "Incomplete",
          expectedOracle: "Explicit",
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
        lineStart: 1,
        claim: "Fixture citation.",
      },
    ],
  },
  currentBehavior: ["The current matrix is incomplete."],
  expectedBehavior: ["Every route has an explicit contract."],
  evidence: [],
  videoNotApplicableReason: "This is a repository-contract review.",
  decisions: [],
  proposedMutations: {
    version: "codeops.research-mutation-batch/v2",
    requestId: "research-request-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    sourceWorkItemId: "22222222-2222-4222-8222-222222222222",
    mutations: [
      {
        type: "ticket.update",
        targetWorkItemId: "22222222-2222-4222-8222-222222222222",
        changes: { descriptionHtml: "<p>Refined.</p>" },
      },
      {
        type: "comment.create",
        targetWorkItemId: "22222222-2222-4222-8222-222222222222",
        bodyHtml: "<p>Research complete.</p>",
        attachments: [],
      },
    ],
  },
  createdAt: "2026-07-26T00:00:00.000Z",
};

test("accepts only the reviewed Trial 0 lifecycle", () => {
  let snapshot = {
    state: "requested",
    sequence: 0,
    summary: "Routing matrix",
  };
  for (const state of [
    "started",
    "planning",
    "executing",
    "evidence_ready",
    "validating",
    "completed",
  ]) {
    snapshot = transition(snapshot, state, state);
  }
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.sequence, 6);
});

test("terminal states and skipped gates fail closed", () => {
  assert.throws(
    () =>
      transition(
        { state: "planning", sequence: 2, summary: "plan" },
        "completed",
        "skip",
      ),
    /invalid CodeOps transition/,
  );
  assert.throws(
    () =>
      transition(
        { state: "completed", sequence: 6, summary: "done" },
        "executing",
        "retry",
      ),
    /invalid CodeOps transition/,
  );
});

test("projects terminal coding failure to the authenticated Plane boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-transition-"));
  const tokenPath = path.join(directory, "token");
  const token = "t".repeat(64);
  await writeFile(tokenPath, token);
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.url, "/v1/workflow-transitions");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const previous = {
    origin: process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN,
    tokenPath: process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE,
  };
  process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN =
    `http://127.0.0.1:${address.port}`;
  process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE = tokenPath;
  const workItem = {
    role: "coding-agent",
    workItemId: "22222222-2222-4222-8222-222222222222",
    workflowId: "coding-123",
    baseSha: "a".repeat(40),
    summary: "Implement auth",
    codingRequest: {
      workspaceId: "55555555-5555-4555-8555-555555555555",
      projectId: "11111111-1111-4111-8111-111111111111",
      workItem: {
        workItemId: "22222222-2222-4222-8222-222222222222",
      },
    },
  };
  try {
    await recordTransition(workItem, {
      state: "planning",
      sequence: 2,
      summary: "Ready authorizes execution",
    });
    assert.equal(seen.length, 0);
    await recordTransition(workItem, {
      state: "failed",
      sequence: 4,
      summary: "Agent Job dispatch failed closed",
    });
    assert.deepEqual(seen, [
      {
        version: "codeops.workflow-transition-notice/v1",
        workspaceId: "55555555-5555-4555-8555-555555555555",
        projectId: "11111111-1111-4111-8111-111111111111",
        workItemId: "22222222-2222-4222-8222-222222222222",
        workflowId: "coding-123",
        state: "failed",
        sequence: 4,
        summary: "Agent Job dispatch failed closed",
      },
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous.origin === undefined) {
      delete process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN;
    } else {
      process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN = previous.origin;
    }
    if (previous.tokenPath === undefined) {
      delete process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE;
    } else {
      process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE = previous.tokenPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Agent Job boundary fails closed without its trusted dispatcher", async () => {
  const previousOrigin = process.env.CODEOPS_AGENT_DISPATCH_ORIGIN;
  delete process.env.CODEOPS_AGENT_DISPATCH_ORIGIN;
  await assert.rejects(
    dispatchAgentJob({
      version: "codeops.agent-job-dispatch/v1",
      workItemId: "22222222-2222-4222-8222-222222222222",
      workflowId: "research-request-1",
      baseSha: "a".repeat(40),
      summary: "Routing matrix",
      role: "coding-agent",
    }),
    /CODEOPS_AGENT_DISPATCH_ORIGIN is required/,
  );
  if (previousOrigin !== undefined) {
    process.env.CODEOPS_AGENT_DISPATCH_ORIGIN = previousOrigin;
  }
});

test("the Agent Job boundary authenticates and validates the dispatcher result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-dispatch-"));
  const tokenPath = path.join(directory, "token");
  const token = "t".repeat(64);
  await writeFile(tokenPath, token);
  const previous = {
    origin: process.env.CODEOPS_AGENT_DISPATCH_ORIGIN,
    tokenPath: process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE,
  };
  process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE = tokenPath;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.url, "/v1/agent-jobs");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.role, "qa-contract-researcher");
      assert.deepEqual(body.researchStage, {
        kind: "persona",
        persona: "@ai-security",
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        version: "codeops.agent-job-dispatch-result/v1",
        role: "qa-contract-researcher",
        runId: "research-test",
        checkpointUri:
          "artifact:///agent-runs/research-test/checkpoint.json",
        checkpointDigest: `sha256:${"a".repeat(64)}`,
        checkpointSizeBytes: 123,
        researchResult: {
          kind: "persona",
          report: {
            version: "codeops.research-persona-report/v2",
            requestId: "research-request-1",
            persona: "@ai-security",
            outcome: "findings",
            summary: "Authentication boundaries need qualification.",
            findings: [],
            decisions: [],
            citations: [],
          },
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  process.env.CODEOPS_AGENT_DISPATCH_ORIGIN =
    `http://127.0.0.1:${address.port}`;
  try {
    const result = await dispatchAgentJob({
      version: "codeops.agent-job-dispatch/v1",
      workItemId: "22222222-2222-4222-8222-222222222222",
      workflowId: "research-request-1",
      baseSha: "a".repeat(40),
      summary: "Research routing matrix",
      role: "qa-contract-researcher",
      researchStage: { kind: "persona", persona: "@ai-security" },
      researchRequest: {
        version: "codeops.research-request/v3",
        requestId: "research-request-1",
        workspaceId: projectContext.project.workspaceId,
        projectId: "11111111-1111-4111-8111-111111111111",
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
          name: "Research auth",
          descriptionHtml: "<p>Define auth contracts.</p>",
          priority: "high",
          stateId: "66666666-6666-4666-8666-666666666666",
          labelIds: [],
          assigneeIds: [],
          moduleId: null,
          parentId: null,
          updatedAt: "2026-07-26T00:00:00.000Z",
          relevantComments: [],
          relations: [],
        },
        personas: ["@ai-security"],
        brief: "Research authentication boundaries",
        requestedAt: "2026-07-26T00:00:00.000Z",
      },
    });
    assert.equal(result.checkpointDigest, `sha256:${"a".repeat(64)}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous.origin === undefined) delete process.env.CODEOPS_AGENT_DISPATCH_ORIGIN;
    else process.env.CODEOPS_AGENT_DISPATCH_ORIGIN = previous.origin;
    if (previous.tokenPath === undefined) {
      delete process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE;
    } else {
      process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE = previous.tokenPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("research completion fails closed without the trusted Plane projection boundary", async () => {
  const previousOrigin = process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN;
  delete process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN;
  await assert.rejects(
    publishResearchPacket(projectionPacket),
    /CODEOPS_RESEARCH_PROJECTION_ORIGIN is required/,
  );
  if (previousOrigin !== undefined) {
    process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN = previousOrigin;
  }
});

test("the Plane projection activity authenticates and binds the response identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-projection-"));
  const tokenPath = path.join(directory, "token");
  const token = "p".repeat(64);
  await writeFile(tokenPath, token);
  const previous = {
    fetch: globalThis.fetch,
    origin: process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN,
    tokenPath: process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE,
  };
  process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN =
    "http://codeops-plane-controller:8080";
  process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE = tokenPath;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "http://codeops-plane-controller:8080/v1/research-packets",
    );
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(JSON.parse(init.body).requestId, projectionPacket.requestId);
    return new Response(
      JSON.stringify({
        version: "codeops.research-projection-result/v1",
        requestId: projectionPacket.requestId,
        status: "applied",
        mutationCount: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    assert.deepEqual(await publishResearchPacket(projectionPacket), {
      passed: true,
      summary:
        "Plane research packet applied with 1 content mutation(s)",
    });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.origin === undefined) {
      delete process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN;
    } else {
      process.env.CODEOPS_RESEARCH_PROJECTION_ORIGIN = previous.origin;
    }
    if (previous.tokenPath === undefined) {
      delete process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE;
    } else {
      process.env.CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE = previous.tokenPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Temporal can bundle the workflow in its deterministic sandbox", async () => {
  const workflowsPath = fileURLToPath(
    new URL("../dist/workflow.js", import.meta.url),
  );
  const bundle = await bundleWorkflowCode({ workflowsPath });
  assert.ok(bundle.code.length > 1_000);
});
