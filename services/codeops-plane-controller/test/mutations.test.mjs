import assert from "node:assert/strict";
import test from "node:test";
import { applyResearchMutationBatch } from "../dist/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";
const requestId = "research-request-1";

function batch(overrides = {}) {
  return {
    version: "codeops.research-mutation-batch/v2",
    requestId,
    projectId,
    sourceWorkItemId: workItemId,
    mutations: [
      {
        type: "ticket.update",
        targetWorkItemId: workItemId,
        changes: {
          descriptionHtml:
            '<p>Refined with <a href="https://github.com/a/b/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.ts#L1-L2">evidence</a>.</p>',
        },
      },
      {
        type: "comment.create",
        targetWorkItemId: workItemId,
        bodyHtml: "<p>Research synthesized.</p>",
        attachments: [],
      },
    ],
    ...overrides,
  };
}

function client(writes, initial = []) {
  const records = new Map([
    [
      workItemId,
      {
        id: workItemId,
        project: projectId,
        labels: [],
        name: "Source",
        descriptionHtml: "<p>Source</p>",
      },
    ],
    ...initial.map((record) => [record.id, record]),
  ]);
  return {
    async getWorkItem(_projectId, targetId) {
      return records.get(targetId) ?? {
        id: targetId,
        project: projectId,
        labels: [],
        name: "Existing",
        descriptionHtml: "<p>Existing</p>",
      };
    },
    async updateWorkItem(actualProjectId, actualWorkItemId, patch) {
      writes.push(["update", actualProjectId, actualWorkItemId, patch]);
    },
    async createComment(actualProjectId, actualWorkItemId, input) {
      writes.push(["comment", actualProjectId, actualWorkItemId, input]);
      return { id: "33333333-3333-4333-8333-333333333333" };
    },
    async listProjectWorkItems() {
      return [...records.values()];
    },
    async createWorkItem(actualProjectId, input) {
      const record = {
        id: "55555555-5555-4555-8555-555555555555",
        project: actualProjectId,
        labels: [],
        name: input.name,
        descriptionHtml: input.description_html,
      };
      records.set(record.id, record);
      writes.push(["task-create", actualProjectId, record.id, input]);
      return record;
    },
  };
}

test("updates only the source description and then creates its synthesis comment", async () => {
  const writes = [];
  const results = await applyResearchMutationBatch({
    batch: batch(),
    expected: { requestId, projectId, sourceWorkItemId: workItemId },
    client: client(writes),
  });
  assert.deepEqual(
    writes.map(([kind]) => kind),
    ["update", "comment"],
  );
  assert.deepEqual(Object.keys(writes[0][3]), ["description_html"]);
  assert.equal(results.length, 2);
});

test("rejects every target other than the current source ticket before writing", async () => {
  const writes = [];
  await assert.rejects(
    applyResearchMutationBatch({
      batch: batch({
        mutations: [
          {
            type: "ticket.update",
            targetWorkItemId: "44444444-4444-4444-8444-444444444444",
            changes: { descriptionHtml: "<p>Wrong target.</p>" },
          },
          batch().mutations[1],
        ],
      }),
      expected: { requestId, projectId, sourceWorkItemId: workItemId },
      client: client(writes),
    }),
    /must refine the source description/,
  );
  assert.equal(writes.length, 0);
});

test("creates an evidence-keyed same-project task between refinement and comment", async () => {
  const writes = [];
  const task = {
    type: "task.upsert",
    key: "otp-rate-limit",
    targetWorkItemId: null,
    expectedDescriptionDigest: null,
    name: "Bound OTP verification attempts",
    descriptionHtml:
      "<h3>CodeOps research finding</h3><p>Bound attempts.</p><p><code>[codeops-research-task:otp-rate-limit]</code></p>",
  };
  const input = batch({
    mutations: [batch().mutations[0], task, batch().mutations[1]],
  });
  const results = await applyResearchMutationBatch({
    batch: input,
    expected: { requestId, projectId, sourceWorkItemId: workItemId },
    client: client(writes),
  });
  assert.deepEqual(
    writes.map(([kind]) => kind),
    ["update", "task-create", "comment"],
  );
  assert.equal(results[1].type, "task.upsert");
});

test("updates only a snapshot-bound task and rejects concurrent edits before writing", async () => {
  const targetId = "66666666-6666-4666-8666-666666666666";
  const existing = {
    id: targetId,
    project: projectId,
    labels: [],
    name: "Existing security task",
    descriptionHtml: "<p>Original task.</p>",
  };
  const task = {
    type: "task.upsert",
    key: "otp-rate-limit",
    targetWorkItemId: targetId,
    expectedDescriptionDigest:
      "sha256:c34c0c2474359053178d0f0bc55ed1d7b183becc18b6efc5c4515fdedf8eceef",
    name: "Bound OTP verification attempts",
    descriptionHtml:
      "<h3>CodeOps research finding</h3><p>Bound attempts.</p><p><code>[codeops-research-task:otp-rate-limit]</code></p>",
  };
  const input = batch({
    mutations: [batch().mutations[0], task, batch().mutations[1]],
  });
  const writes = [];
  await applyResearchMutationBatch({
    batch: input,
    expected: { requestId, projectId, sourceWorkItemId: workItemId },
    client: client(writes, [existing]),
  });
  assert.deepEqual(
    writes.map(([kind]) => kind),
    ["update", "update", "comment"],
  );

  const conflicting = { ...existing, descriptionHtml: "<p>Human edit.</p>" };
  const conflictWrites = [];
  await assert.rejects(
    applyResearchMutationBatch({
      batch: input,
      expected: { requestId, projectId, sourceWorkItemId: workItemId },
      client: client(conflictWrites, [conflicting]),
    }),
    /changed after admission/,
  );
  assert.equal(conflictWrites.length, 0);
});

test("rejects lifecycle, label, project, ticket-create, and broad ticket edits", async () => {
  for (const mutation of [
    { type: "state.update", targetWorkItemId: workItemId, state: "Ready" },
    { type: "label.attach", targetWorkItemId: workItemId, key: "security" },
    { type: "project.update", changes: { name: "No" } },
    { type: "ticket.create", name: "No", descriptionHtml: "<p>No</p>" },
    {
      type: "ticket.update",
      targetWorkItemId: workItemId,
      changes: { name: "No" },
    },
  ]) {
    await assert.rejects(
      applyResearchMutationBatch({
        batch: batch({ mutations: [mutation, batch().mutations[1]] }),
        expected: { requestId, projectId, sourceWorkItemId: workItemId },
        client: client([]),
      }),
    );
  }
});

test("rejects active or malformed HTML before any Plane write", async () => {
  for (const descriptionHtml of [
    "<script>alert(1)</script>",
    '<p onclick="alert(1)">bad</p>',
    '<a href="https://example.com/?secret=x">bad</a>',
  ]) {
    const writes = [];
    await assert.rejects(
      applyResearchMutationBatch({
        batch: batch({
          mutations: [
            {
              type: "ticket.update",
              targetWorkItemId: workItemId,
              changes: { descriptionHtml },
            },
            batch().mutations[1],
          ],
        }),
        expected: { requestId, projectId, sourceWorkItemId: workItemId },
        client: client(writes),
      }),
    );
    assert.equal(writes.length, 0);
  }
});
