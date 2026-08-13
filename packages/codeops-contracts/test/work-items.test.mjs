import assert from "node:assert/strict";
import test from "node:test";
import {
  workItemCreateInputSchema,
  workItemProviderCreateRequestSchema,
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
