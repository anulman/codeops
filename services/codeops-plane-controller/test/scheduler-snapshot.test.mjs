import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSchedulerProjectSnapshot } from "../dist/index.js";

const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const a = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const b = "77777777-7777-4777-8777-777777777777";
const stateIds = {
  ready: "10000000-0000-4000-8000-000000000001",
  in_progress: "10000000-0000-4000-8000-000000000002",
  needs_attention: "10000000-0000-4000-8000-000000000003",
  paused: "10000000-0000-4000-8000-000000000004",
  cancelled: "10000000-0000-4000-8000-000000000005",
  complete: "10000000-0000-4000-8000-000000000006",
  failed: "10000000-0000-4000-8000-000000000007",
};

const binding = {
  version: "codeops.pull-request-binding/v1",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId,
  workItemId: a,
  workflowId: "coding-123",
  repository: "anulman/renoconcierge",
  number: 158,
  state: "open",
  headSha: "a".repeat(40),
  headRef: "codeops/a",
  baseRef: "main",
  qualified: true,
  updatedAt: "2026-07-30T21:00:00.000Z",
};

test("compiles exact Plane relations, workflow state, and durable PR bindings", async () => {
  const snapshot = await compileSchedulerProjectSnapshot({
    projectId,
    workItems: [
      { id: b, state: stateIds.ready },
      { id: a, state: stateIds.needs_attention },
    ],
    async loadRelations(workItemId) {
      return {
        blocked_by:
          workItemId === b ? [{ project_id: projectId, issue_id: a }] : [],
      };
    },
    workflowByWorkItem: new Map([
      [a, "terminal"],
      [b, "none"],
    ]),
    stateIds,
    bindings: {
      async getByWorkItem(workItemId) {
        return workItemId === a ? binding : null;
      },
      async getByPullRequest() {
        throw new Error("not used");
      },
      async put() {
        throw new Error("not used");
      },
    },
  });
  assert.deepEqual([...snapshot.keys()], [a, b]);
  assert.equal(snapshot.get(a).state, "needs_attention");
  assert.equal(snapshot.get(a).pullRequest.number, 158);
  assert.deepEqual(snapshot.get(b).blockedBy, [a]);
  assert.equal(snapshot.get(b).workflow, "none");
});

test("fails closed on missing workflow state, cross-project blockers, and duplicate states", async () => {
  const base = {
    projectId,
    workItems: [{ id: a, state: stateIds.ready }],
    workflowByWorkItem: new Map(),
    stateIds,
    bindings: {
      async getByWorkItem() {
        return null;
      },
      async getByPullRequest() {
        return null;
      },
      async put() {},
    },
  };
  await assert.rejects(
    compileSchedulerProjectSnapshot({
      ...base,
      async loadRelations() {
        return { blocked_by: [] };
      },
    }),
    /workflow snapshot missing/,
  );
  await assert.rejects(
    compileSchedulerProjectSnapshot({
      ...base,
      workflowByWorkItem: new Map([[a, "none"]]),
      async loadRelations() {
        return {
          blocked_by: [
            {
              project_id: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
              issue_id: b,
            },
          ],
        };
      },
    }),
    /cross-project blockers/,
  );
  await assert.rejects(
    compileSchedulerProjectSnapshot({
      ...base,
      stateIds: { ...stateIds, complete: stateIds.ready },
      workflowByWorkItem: new Map([[a, "none"]]),
      async loadRelations() {
        return { blocked_by: [] };
      },
    }),
    /state IDs must be unique/,
  );
});
