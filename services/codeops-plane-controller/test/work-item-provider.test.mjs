import assert from "node:assert/strict";
import test from "node:test";
import { createPlaneWorkItem } from "../dist/work-item-provider.js";

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
  return {
    creates,
    intakeCreates,
    api: {
      async listProjectWorkItems() { return items; },
      async createWorkItem(_projectId, input) {
        creates.push(input);
        return { id: workItemId, project: projectId, labels: [], name: input.name, descriptionHtml: input.description_html };
      },
      async createIntakeWorkItem(_projectId, input) {
        intakeCreates.push(input);
        return { id: workItemId, project: projectId, labels: [], name: input.name, descriptionHtml: input.description_html };
      },
    },
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
