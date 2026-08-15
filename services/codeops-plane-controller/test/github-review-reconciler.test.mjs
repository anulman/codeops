import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  contractVersions,
  createProjectContext,
} from "@codeops/codeops-contracts";
import {
  createFileCodingRequestStore,
  createFileResearchDedupLedger,
  createHumanReviewCodingRequest,
  reconcileGitHubPullRequestReviewEvent,
} from "../dist/index.js";

const workspaceId = "d250cd44-fa71-42c2-b2b5-3c73227288fc";
const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const workItemId = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const actorId = "88fc36c8-73b0-4547-81c7-96b70f61835e";
const baseSha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";
const reviewHead = "b".repeat(40);
const reviewedAt = "2026-07-30T22:45:00.000Z";

function initialRequest() {
  const projectContext = createProjectContext({
    version: contractVersions.projectContext,
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: "a".repeat(40),
    baseSha,
    project: {
      workspaceId,
      projectId,
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Bounded project.</p>",
      updatedAt: "2026-07-30T20:00:00.000Z",
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
  return {
    version: "codeops.coding-request/v2",
    requestId: "coding-initial",
    eventId: "plane-ready:initial",
    workspaceId,
    projectId,
    projectContext,
    requestedBy: actorId,
    controlPlaneSha: "a".repeat(40),
    planeRevisionDigest: `sha256:${"c".repeat(64)}`,
    ticketSnapshot: {
      workItemId,
      name: "Implement the bounded route",
      descriptionHtml: "<p>Implement it.</p>",
      priority: "high",
      stateId: "77777777-7777-4777-8777-777777777777",
      labelIds: [],
      assigneeIds: [],
      moduleId: null,
      parentId: null,
      updatedAt: "2026-07-30T20:00:00.000Z",
      relevantComments: [],
      relations: [],
      projectTasks: [],
    },
    researchDisposition: {
      mode: "skipped",
      rationale: "The ticket is self-contained.",
    },
    workItem: {
      version: "codeops.work-item/v1",
      workItemId,
      workflowId: "coding-initial",
      runId: "coding-initial",
      repository: { owner: "example-org", name: "example-repository" },
      baseSha,
      branch: "codeops/original",
      summary: "Implement the bounded route",
      acceptanceCriteria: ["The focused contract passes."],
      secretReferences: [],
      requestedAt: "2026-07-30T20:00:00.000Z",
    },
  };
}

const binding = {
  version: "codeops.pull-request-binding/v1",
  workspaceId,
  projectId,
  workItemId,
  workflowId: "coding-initial",
  repository: "example-org/example-repository",
  number: 158,
  state: "open",
  headSha: reviewHead,
  headRef: "codeops/original",
  baseRef: "main",
  baseSha: "0".repeat(40),
  qualified: true,
  updatedAt: "2026-07-30T22:30:00.000Z",
};

function event(overrides = {}) {
  return {
    kind: "pull_request_review",
    repository: binding.repository,
    number: binding.number,
    action: "submitted",
    reviewId: 9001,
    state: "changes_requested",
    body: "Please make the exact-head check explicit.",
    reviewerId: 6723643628,
    reviewerLogin: "anulman",
    reviewerType: "User",
    reviewedHeadSha: reviewHead,
    currentHeadSha: reviewHead,
    headRef: binding.headRef,
    baseRef: binding.baseRef,
    baseSha: binding.baseSha,
    submittedAt: reviewedAt,
    ...overrides,
  };
}

const comments = [
  {
    id: 7001,
    body: "Cover this branch with a regression test.",
    path: "services/codeops-plane-controller/src/github-events.ts",
    line: 42,
    side: "RIGHT",
    createdAt: reviewedAt,
  },
];

async function withStores(run) {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-review-"));
  try {
    const requests = createFileCodingRequestStore({
      rootDirectory: path.join(root, "requests"),
    });
    await requests.put(initialRequest());
    await run({
      requests,
      ledger: createFileResearchDedupLedger({
        rootDirectory: path.join(root, "dedup"),
        leaseDurationMs: 60_000,
      }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("derives one exact-head revision request from the immutable Ready request", () => {
  const request = createHumanReviewCodingRequest({
    source: initialRequest(),
    event: event(),
    comments,
  });
  assert.equal(request.workItem.baseSha, reviewHead);
  assert.equal(request.workItem.branch, binding.headRef);
  assert.equal(request.requestedBy, "github:6723643628");
  assert.equal(request.humanReview.reviewId, 9001);
  assert.deepEqual(request.humanReview.comments, comments);
  assert.equal(request.researchDisposition.mode, "skipped");
  assert.equal(request.projectContext.baseSha, reviewHead);
  assert.match(request.requestId, /^review-[0-9a-f]{57}$/);
  assert.throws(
    () =>
      createHumanReviewCodingRequest({
        source: initialRequest(),
        event: event({ currentHeadSha: "d".repeat(40) }),
        comments,
      }),
    /current PR head/,
  );
});

test("invalidates stacking, begins revision, re-evaluates, and enqueues once", async () => {
  await withStores(async ({ requests, ledger }) => {
    const calls = [];
    let stored = binding;
    const input = {
      event: event(),
      receivedAt: "2026-07-30T22:46:00.000Z",
      allowedReviewerIds: new Set([6723643628]),
      bindings: {
        async getByPullRequest() {
          return stored;
        },
        async getByWorkItem() {
          return stored;
        },
        async put(value) {
          stored = value;
          calls.push(["binding", value.qualified]);
        },
      },
      ledger,
      async loadComments() {
        calls.push(["comments"]);
        return comments;
      },
      loadInitialRequest: (id) => requests.getInitialByWorkItem(id),
      async beginRevision() {
        calls.push(["in-progress"]);
      },
      async reevaluateProject() {
        calls.push(["reevaluate"]);
      },
      async enqueueRevision({ request }) {
        calls.push(["enqueue", request.requestId]);
        return "enqueued";
      },
      async qualify() {
        throw new Error("not approval");
      },
    };
    const result = await reconcileGitHubPullRequestReviewEvent(input);
    assert.equal(result.status, "revision-enqueued");
    assert.deepEqual(calls.map((call) => call[0]), [
      "comments",
      "binding",
      "in-progress",
      "reevaluate",
      "enqueue",
    ]);
    assert.equal(stored.qualified, false);

    calls.length = 0;
    const duplicate = await reconcileGitHubPullRequestReviewEvent(input);
    assert.equal(duplicate.status, "revision-enqueued");
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(calls, [["comments"]]);
  });
});

test("requires exact allowlisted approval and passing qualification", async () => {
  await withStores(async ({ requests, ledger }) => {
    const calls = [];
    let stored = { ...binding, qualified: false };
    const approved = event({
      reviewId: 9002,
      state: "approved",
      body: "",
    });
    const result = await reconcileGitHubPullRequestReviewEvent({
      event: approved,
      receivedAt: "2026-07-30T22:47:00.000Z",
      allowedReviewerIds: new Set([6723643628]),
      bindings: {
        async getByPullRequest() {
          return stored;
        },
        async getByWorkItem() {
          return stored;
        },
        async put(value) {
          stored = value;
          calls.push(["binding", value.qualified]);
        },
      },
      ledger,
      async loadComments() {
        throw new Error("approval must not load review comments");
      },
      loadInitialRequest: (id) => requests.getInitialByWorkItem(id),
      async beginRevision() {
        throw new Error("approval must not begin revision");
      },
      async enqueueRevision() {
        throw new Error("approval must not enqueue revision");
      },
      async qualify() {
        calls.push(["checks"]);
        return true;
      },
      async reevaluateProject() {
        calls.push(["reevaluate"]);
      },
    });
    assert.equal(result.status, "qualified");
    assert.equal(stored.qualified, true);
    assert.deepEqual(calls, [
      ["checks"],
      ["binding", true],
      ["reevaluate"],
    ]);

    const movedBase = await reconcileGitHubPullRequestReviewEvent({
      event: event({ reviewId: 9004, state: "approved", baseSha: "1".repeat(40) }),
      receivedAt: "2026-07-30T22:48:00.000Z",
      allowedReviewerIds: new Set([6723643628]),
      bindings: {
        async getByPullRequest() {
          return stored;
        },
      },
      ledger,
      loadComments: async () => [],
      loadInitialRequest: (id) => requests.getInitialByWorkItem(id),
      enqueueRevision: async () => "enqueued",
      beginRevision: async () => {},
      qualify: async () => true,
      reevaluateProject: async () => {},
    });
    assert.deepEqual(movedBase, {
      status: "ignored",
      reason: "review-does-not-match-bound-current-head",
    });

    const ignored = await reconcileGitHubPullRequestReviewEvent({
      event: event({ reviewId: 9003, reviewerId: 1 }),
      receivedAt: "2026-07-30T22:48:00.000Z",
      allowedReviewerIds: new Set([6723643628]),
      bindings: {
        async getByPullRequest() {
          throw new Error("untrusted reviewer must stop before binding lookup");
        },
      },
      ledger,
      loadComments: async () => [],
      loadInitialRequest: async () => null,
      enqueueRevision: async () => "enqueued",
      beginRevision: async () => {},
      qualify: async () => true,
      reevaluateProject: async () => {},
    });
    assert.deepEqual(ignored, {
      status: "ignored",
      reason: "reviewer-is-not-allowlisted",
    });
  });
});
