import assert from "node:assert/strict";
import test from "node:test";
import {
  commentOnPlaneWorkItem,
  createPlaneWorkItem,
  getPlaneWorkItem,
  relatePlaneWorkItems,
  searchPlaneWorkItems,
  updatePlaneWorkItem,
} from "../dist/work-item-provider.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";
const request = {
  version: "codeops.work-item-provider-create-request/v1",
  provider: "plane",
  operationId: "workitem-abc",
  payloadDigest: `sha256:${"a".repeat(64)}`,
  repository: "anulman/codeops",
  mode: "triage",
  title: "Create a work-item provider",
  description: "Keep credentials in the trusted controller.",
  provenance: {
    sessionId: "ses_123",
    dispatchId: "33333333-3333-4333-8333-333333333333",
    principalDigest: `sha256:${"b".repeat(64)}`,
  },
};

function client(items = []) {
  const creates = [];
  const intakeCreates = [];
  const comments = [];
  const updates = [];
  const relations = [];
  let snapshots = [...items];
  return {
    creates, intakeCreates, comments, updates, relations,
    api: {
      async listProjectWorkItems() { return items; },
      async listProjectWorkItemSnapshots() { return snapshots; },
      async getWorkItemSnapshot(_projectId, id) {
        return snapshots.find((item) => item.id === id);
      },
      async createWorkItem(_projectId, input) {
        creates.push(input);
        return { id: workItemId, project: projectId, labels: [], name: input.name, descriptionHtml: input.description_html };
      },
      async createIntakeWorkItem(_projectId, input) {
        intakeCreates.push(input);
        return { id: workItemId, project: projectId, labels: [], name: input.name, descriptionHtml: input.description_html };
      },
      async createComment(_projectId, _workItemId, input) {
        comments.push(input);
        return { id: "44444444-4444-4444-8444-444444444444", disposition: "created" };
      },
      async updateWorkItem(_projectId, id, input) {
        updates.push(input);
        snapshots = snapshots.map((item) => item.id === id ? {
          ...item,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description_html === undefined ? {} : {
            description_html: input.description_html,
            description_stripped: input.description_html.replace(/<[^>]+>/g, ""),
          }),
          updated_at: "2026-08-14T00:00:01.000Z",
        } : item);
      },
      async getWorkItemRelations() { return { relates_to: [] }; },
      async createWorkItemRelation(_projectId, _workItemId, input) {
        relations.push(input);
      },
    },
  };
}

function snapshot(id = workItemId, name = "Existing item") {
  return {
    id,
    project: projectId,
    name,
    description_html: "<p>Existing description.</p>",
    description_stripped: "Existing description.",
    priority: "none",
    state: "55555555-5555-4555-8555-555555555555",
    labels: [],
    updated_at: "2026-08-14T00:00:00.000Z",
  };
}

function providerRequest(version, extra) {
  return {
    version,
    provider: "plane",
    operationId: "workitem-operation",
    payloadDigest: `sha256:${"c".repeat(64)}`,
    repository: "anulman/codeops",
    provenance: request.provenance,
    ...extra,
  };
}

test("creates escaped Plane intake content with an idempotency marker", async () => {
  const fake = client();
  const result = await createPlaneWorkItem({
    request: { ...request, description: "Do <not> trust & raw HTML." },
    projectId,
    client: fake.api,
  });
  assert.equal(result.disposition, "created");
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.intakeCreates.length, 1);
  assert.match(fake.intakeCreates[0].description_html, /Do &lt;not&gt; trust &amp; raw HTML/);
  assert.match(fake.intakeCreates[0].description_html, /operation=workitem-abc/);
});

test("creates a direct Plane work item only in direct mode", async () => {
  const fake = client();
  await createPlaneWorkItem({
    request: { ...request, mode: "direct" },
    projectId,
    client: fake.api,
  });
  assert.equal(fake.creates.length, 1);
  assert.equal(fake.intakeCreates.length, 0);
});

test("returns the exact existing Plane item on a replay", async () => {
  const marker = `<!-- codeops-work-item:v1 operation=${request.operationId} payload=${request.payloadDigest} -->`;
  const fake = client([{ id: workItemId, project: projectId, labels: [], name: request.title, descriptionHtml: marker }]);
  const result = await createPlaneWorkItem({ request, projectId, client: fake.api });
  assert.equal(result.disposition, "existing");
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.intakeCreates.length, 0);
});

test("fails closed when an operation identity has different content", async () => {
  const fake = client([{ id: workItemId, project: projectId, labels: [], name: request.title, descriptionHtml: "operation=workitem-abc payload=sha256:wrong" }]);
  await assert.rejects(
    createPlaneWorkItem({ request, projectId, client: fake.api }),
    /conflicts/,
  );
});

test("gets and searches bounded same-project work-item projections", async () => {
  const fake = client([snapshot(), snapshot("66666666-6666-4666-8666-666666666666", "Other")]);
  const item = await getPlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-get-request/v1", { workItemId }),
    projectId,
    client: fake.api,
  });
  assert.equal(item.workItemId, workItemId);
  assert.match(item.revision, /^sha256:[0-9a-f]{64}$/);

  const result = await searchPlaneWorkItems({
    request: providerRequest("codeops.work-item-provider-search-request/v1", {
      query: "existing description",
      limit: 20,
    }),
    projectId,
    client: fake.api,
  });
  assert.equal(result.items.length, 2);
});

test("comments and relates through idempotent provider identities", async () => {
  const relatedWorkItemId = "66666666-6666-4666-8666-666666666666";
  const fake = client([snapshot(), snapshot(relatedWorkItemId, "Related")]);
  const comment = await commentOnPlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-comment-request/v1", {
      workItemId,
      body: "Passed <focused> validation.",
    }),
    projectId,
    client: fake.api,
  });
  assert.equal(comment.disposition, "created");
  assert.match(fake.comments[0].comment_html, /Passed &lt;focused&gt; validation/);
  assert.match(fake.comments[0].external_id, /workitem-operation/);

  const relation = await relatePlaneWorkItems({
    request: providerRequest("codeops.work-item-provider-relate-request/v1", {
      workItemId,
      relatedWorkItemId,
      relation: "relates_to",
    }),
    projectId,
    client: fake.api,
  });
  assert.equal(relation.disposition, "created");
  assert.deepEqual(fake.relations, [{ relation_type: "relates_to", issues: [relatedWorkItemId] }]);
});

test("updates only from the exact observed revision", async () => {
  const fake = client([snapshot()]);
  const before = await getPlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-get-request/v1", { workItemId }),
    projectId,
    client: fake.api,
  });
  const result = await updatePlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-update-request/v1", {
      workItemId,
      expectedRevision: before.revision,
      title: "Updated item",
    }),
    projectId,
    client: fake.api,
  });
  assert.equal(result.disposition, "updated");
  assert.equal(result.item.title, "Updated item");
  assert.equal(fake.updates.length, 1);

  const stale = await updatePlaneWorkItem({
      request: providerRequest("codeops.work-item-provider-update-request/v1", {
        workItemId,
        expectedRevision: before.revision,
        title: "Stale write",
      }),
      projectId,
      client: fake.api,
    });
  assert.equal(stale.disposition, "reload-required");
  assert.equal(stale.item.title, "Updated item");
  assert.notEqual(stale.item.revision, before.revision);
  assert.equal(fake.updates.length, 1);

  const reloaded = await getPlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-get-request/v1", { workItemId }),
    projectId,
    client: fake.api,
  });
  const retried = await updatePlaneWorkItem({
    request: providerRequest("codeops.work-item-provider-update-request/v1", {
      workItemId,
      expectedRevision: reloaded.revision,
      title: "Retried after reload",
    }),
    projectId,
    client: fake.api,
  });
  assert.equal(retried.disposition, "updated");
  assert.equal(retried.item.title, "Retried after reload");
  assert.equal(fake.updates.length, 2);
});
