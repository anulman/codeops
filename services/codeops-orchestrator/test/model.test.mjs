import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import { canonicalSerialize } from "@renoconcierge/codeops-contracts";
import {
  dispatchAgentJob,
  publishResearchPacket,
} from "../dist/activities.js";
import { initialPlanDecision, transition } from "../dist/model.js";

const projectContext = {
  version: "codeops.project-context/v1",
  repository: { owner: "anulman", name: "renoconcierge" },
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
      digest: `sha256:${"1".repeat(64)}`,
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
  projectId: "11111111-1111-4111-8111-111111111111",
  workItemId: "22222222-2222-4222-8222-222222222222",
  baseSha: "a".repeat(40),
  projectContextDigest: projectContext.digest,
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  summary: "Authentication boundaries need qualification.",
  currentBehavior: ["The current matrix is incomplete."],
  expectedBehavior: ["Every route has an explicit contract."],
  evidence: [],
  videoNotApplicableReason: "This is a repository-contract review.",
  decisions: [],
  proposedMutations: {
    version: "codeops.research-mutation-batch/v1",
    requestId: "research-request-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    sourceWorkItemId: "22222222-2222-4222-8222-222222222222",
    mutations: [],
  },
  createdAt: "2026-07-26T00:00:00.000Z",
};

test("an admitted persona comment approves only the research run", () => {
  assert.equal(initialPlanDecision("qa-contract-researcher"), "approved");
  assert.equal(initialPlanDecision("coding-agent"), null);
});

test("accepts only the reviewed Trial 0 lifecycle", () => {
  let snapshot = {
    state: "requested",
    sequence: 0,
    summary: "Routing matrix",
  };
  for (const state of [
    "started",
    "planning",
    "approval_required",
    "executing",
    "evidence_ready",
    "validating",
    "completed",
  ]) {
    snapshot = transition(snapshot, state, state);
  }
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.sequence, 7);
});

test("terminal states and skipped gates fail closed", () => {
  assert.throws(
    () =>
      transition(
        { state: "approval_required", sequence: 3, summary: "review" },
        "completed",
        "skip",
      ),
    /invalid CodeOps transition/,
  );
  assert.throws(
    () =>
      transition(
        { state: "completed", sequence: 7, summary: "done" },
        "executing",
        "retry",
      ),
    /invalid CodeOps transition/,
  );
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
    fetch: globalThis.fetch,
    origin: process.env.CODEOPS_AGENT_DISPATCH_ORIGIN,
    tokenPath: process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE,
  };
  process.env.CODEOPS_AGENT_DISPATCH_ORIGIN = "http://codeops-control-gateway";
  process.env.CODEOPS_AGENT_DISPATCH_TOKEN_FILE = tokenPath;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://codeops-control-gateway/v1/agent-jobs");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    const body = JSON.parse(init.body);
    assert.equal(body.role, "qa-contract-researcher");
    assert.equal(body.researchPersona, "@ai-security");
    return new Response(
      JSON.stringify({
        version: "codeops.agent-job-dispatch-result/v1",
        role: "qa-contract-researcher",
        runId: "research-test",
        checkpointUri:
          "artifact:///agent-runs/research-test/checkpoint.json",
        checkpointDigest: `sha256:${"a".repeat(64)}`,
        checkpointSizeBytes: 123,
        researchReport: {
          version: "codeops.research-persona-report/v1",
          requestId: "research-request-1",
          persona: "@ai-security",
          outcome: "findings",
          summary: "Authentication boundaries need qualification.",
          currentBehavior: ["The current matrix is incomplete."],
          expectedBehavior: ["Every route has an explicit contract."],
          decisions: [],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const result = await dispatchAgentJob({
      version: "codeops.agent-job-dispatch/v1",
      workItemId: "22222222-2222-4222-8222-222222222222",
      workflowId: "research-request-1",
      baseSha: "a".repeat(40),
      summary: "Research routing matrix",
      role: "qa-contract-researcher",
      researchPersona: "@ai-security",
      researchRequest: {
        version: "codeops.research-request/v2",
        requestId: "research-request-1",
        workspaceId: projectContext.project.workspaceId,
        projectId: "11111111-1111-4111-8111-111111111111",
        workItemId: "22222222-2222-4222-8222-222222222222",
        triggerCommentId: "33333333-3333-4333-8333-333333333333",
        requestedBy: "44444444-4444-4444-8444-444444444444",
        repository: { owner: "anulman", name: "renoconcierge" },
        baseSha: "a".repeat(40),
        planeRevisionDigest: `sha256:${"b".repeat(64)}`,
        projectContext,
        personas: ["@ai-security"],
        brief: "Research authentication boundaries",
        requestedAt: "2026-07-26T00:00:00.000Z",
      },
    });
    assert.equal(result.checkpointDigest, `sha256:${"a".repeat(64)}`);
  } finally {
    globalThis.fetch = previous.fetch;
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
