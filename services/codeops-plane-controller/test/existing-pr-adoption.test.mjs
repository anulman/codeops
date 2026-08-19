import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createProjectContext } from "@codeops/codeops-contracts";
import { adoptExistingPullRequest } from "../dist/index.js";

const now = "2026-08-19T00:00:00.000Z";
const headSha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";
const baseSha = "a".repeat(40);
const workspaceId = "d250cd44-fa71-42c2-b2b5-3c73227288fc";
const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const workItemId = "e1c25c66-5bb8-465e-a818-92a483423443";

function adoptionRequest() {
  const projectContext = createProjectContext({
    version: "codeops.project-context/v1",
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: headSha,
    baseSha: headSha,
    project: {
      workspaceId,
      projectId,
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Qualify the route matrix.</p>",
      updatedAt: now,
    },
    documents: [{
      path: "AGENTS.md",
      purpose: "Repository guidance",
      digest: `sha256:${createHash("sha256").update("# Guidance\n").digest("hex")}`,
      content: "# Guidance\n",
    }],
  });
  const adoptedPullRequest = {
    version: "codeops.adopted-pull-request/v1",
    repository: "example-org/example-repository",
    pullRequestNumber: 158,
    headSha,
    headRef: "feat/customer-routing-matrix",
    baseSha,
    baseRef: "main",
    title: "Qualify the canonical customer-file auth matrix",
    url: "https://github.com/example-org/example-repository/pull/158",
    adoptedAt: now,
    sessionOwnerPrincipalId: "access:operator@example.com",
    rationale: "Run the exact existing head through independent review.",
  };
  return {
    version: "codeops.existing-pull-request-adoption-request/v1",
    operatorRequestId: "22222222-2222-4222-8222-222222222222",
    codingRequest: {
      version: "codeops.coding-request/v2",
      requestId: "adopt-pr-158",
      eventId: "operator-adoption:22222222-2222-4222-8222-222222222222",
      workspaceId,
      projectId,
      requestedBy: "88fc36c8-73b0-4547-81c7-96b70f61835e",
      controlPlaneSha: headSha,
      planeRevisionDigest: `sha256:${"c".repeat(64)}`,
      ticketSnapshot: {
        workItemId,
        name: "Build isolated routing fixtures",
        descriptionHtml: "<p>Cover the accepted matrix.</p>",
        priority: "high",
        stateId: "77777777-7777-4777-8777-777777777777",
        labelIds: [],
        assigneeIds: [],
        moduleId: null,
        parentId: null,
        updatedAt: now,
        relevantComments: [],
        relations: [],
        projectTasks: [],
      },
      researchDisposition: {
        mode: "skipped",
        rationale: "The bounded ticket is self-contained.",
      },
      projectContext,
      workItem: {
        version: "codeops.work-item/v1",
        workItemId,
        workflowId: "adopt-pr-158",
        runId: "adopt-pr-158",
        repository: { owner: "example-org", name: "example-repository" },
        baseSha: headSha,
        branch: "feat/customer-routing-matrix",
        summary: "Build the isolated routing fixtures.",
        acceptanceCriteria: ["The focused routing suite passes."],
        secretReferences: [],
        requestedAt: now,
      },
      adoptedPullRequest,
    },
    pullRequest: adoptedPullRequest,
  };
}

function harness({ begin = async () => {} } = {}) {
  const order = [];
  return {
    order,
    input: {
      request: adoptionRequest(),
      resolveCurrent: async () => ({
        repository: "example-org/example-repository",
        number: 158,
        state: "open",
        headSha,
        headRef: "feat/customer-routing-matrix",
        baseSha,
        baseRef: "main",
      }),
      codingRequests: { put: async () => order.push("coding-request") },
      pullRequestBindings: {
        getByPullRequest: async () => null,
        put: async () => order.push("pull-request-binding"),
      },
      workflowBindings: {
        put: async () => order.push("workflow-binding"),
      },
      begin: async (identity) => {
        order.push("begin");
        await begin(identity);
      },
      enqueue: async () => {
        order.push("enqueue");
        return "enqueued";
      },
    },
  };
}

test("moves the adopted ticket into execution before enqueue", async () => {
  const state = harness();
  const result = await adoptExistingPullRequest(state.input);
  assert.equal(result.status, "enqueued");
  assert.deepEqual(state.order, [
    "begin",
    "coding-request",
    "enqueue",
    "workflow-binding",
    "pull-request-binding",
  ]);
});

test("fails closed before persistence or enqueue when lifecycle preflight fails", async () => {
  const state = harness({
    begin: async () => {
      throw new Error("Plane state drifted");
    },
  });
  await assert.rejects(
    adoptExistingPullRequest(state.input),
    /Plane state drifted/,
  );
  assert.deepEqual(state.order, ["begin"]);
});
