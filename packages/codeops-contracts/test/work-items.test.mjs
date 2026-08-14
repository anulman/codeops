import assert from "node:assert/strict";
import test from "node:test";
import {
  workItemCommentInputSchema,
  workItemCreateInputSchema,
  workItemGetInputSchema,
  workItemProviderCreateRequestSchema,
  workItemRelateInputSchema,
  workItemSearchInputSchema,
  workItemUpdateInputSchema,
} from "../dist/work-items.js";

test("defaults ACP work-item creation to triage", () => {
  assert.deepEqual(workItemCreateInputSchema.parse({
    repository: "anulman/codeops",
    title: "Add a provider tool",
    description: "Create the provider-neutral work-item capability.",
  }), {
    repository: "anulman/codeops",
    mode: "triage",
    title: "Add a provider tool",
    description: "Create the provider-neutral work-item capability.",
  });
});

test("requires provenance while keeping the provider identifier pluggable", () => {
  const base = {
    version: "codeops.work-item-provider-create-request/v1",
    provider: "plane",
    operationId: "workitem-123",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    repository: "anulman/codeops",
    mode: "triage",
    title: "One task",
    description: "One bounded task.",
  };
  assert.throws(() => workItemProviderCreateRequestSchema.parse(base));
  assert.equal(workItemProviderCreateRequestSchema.parse({
    ...base,
    provider: "linear",
    provenance: {
      sessionId: "ses_123",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      principalDigest: `sha256:${"b".repeat(64)}`,
    },
  }).provider, "linear");
});

test("binds read and mutation inputs to exact work-item identities", () => {
  const workItemId = "11111111-1111-4111-8111-111111111111";
  const relatedWorkItemId = "22222222-2222-4222-8222-222222222222";
  const revision = `sha256:${"c".repeat(64)}`;

  assert.equal(workItemGetInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
  }).workItemId, workItemId);
  assert.equal(workItemSearchInputSchema.parse({
    repository: "anulman/codeops",
    query: "provider interface",
  }).limit, 20);
  assert.equal(workItemCommentInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
    body: "Validation passed.",
  }).body, "Validation passed.");
  assert.equal(workItemUpdateInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
    expectedRevision: revision,
    title: "Updated title",
  }).expectedRevision, revision);
  assert.equal(workItemRelateInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
    relatedWorkItemId,
    relation: "relates_to",
  }).relatedWorkItemId, relatedWorkItemId);

  assert.throws(() => workItemUpdateInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
    expectedRevision: revision,
  }), /title or description/);
  assert.throws(() => workItemRelateInputSchema.parse({
    repository: "anulman/codeops",
    workItemId,
    relatedWorkItemId: workItemId,
    relation: "relates_to",
  }), /cannot relate to itself/);
});
