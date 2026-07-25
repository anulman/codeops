import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalSerialize,
  contractVersions,
  controlCommandSchema,
  controlResultSchema,
  createEventId,
  createTransitionId,
  evidenceReferenceSchema,
  secretReferenceSchema,
  workflowEventSchema,
  workflowStateSchema,
  workItemRequestSchema,
} from "../dist/index.js";

const now = "2026-07-25T16:00:00.000Z";
const sha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";

const secretReference = {
  version: contractVersions.secretReference,
  provider: "kubernetes",
  reference: "codeops-run-123",
  scope: "run-123",
};

const evidence = {
  version: contractVersions.evidence,
  kind: "test-report",
  uri: "artifact:///runs/run-123/report.json",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 1_024,
  mediaType: "application/json",
};

const workItem = {
  version: contractVersions.workItem,
  workItemId: "plane:2fdebb4c",
  workflowId: "workflow-123",
  runId: "run-123",
  repository: { owner: "anulman", name: "renoconcierge" },
  baseSha: sha,
  branch: "feat/customer-routing-matrix",
  summary: "Validate customer routing across file and browser states.",
  acceptanceCriteria: ["Every matrix cell has a deterministic assertion."],
  secretReferences: [secretReference],
  requestedAt: now,
};

function command(type, payload) {
  return {
    version: contractVersions.controlCommand,
    commandId: `command-${type}`,
    workflowId: "workflow-123",
    runId: "run-123",
    requestedAt: now,
    type,
    payload,
  };
}

test("accepts the complete work-item and opaque secret-reference contracts", () => {
  assert.deepEqual(workItemRequestSchema.parse(workItem), workItem);
  assert.deepEqual(secretReferenceSchema.parse(secretReference), secretReference);
});

test("accepts every workflow state with deterministic logical IDs", () => {
  for (const state of workflowStateSchema.options) {
    const transitionKey = `sequence-${state}`;
    const transitionId = createTransitionId({
      workflowId: "workflow-123",
      transitionKey,
    });
    const eventId = createEventId({
      workflowId: "workflow-123",
      transitionId,
    });
    const event = {
      version: contractVersions.event,
      eventId,
      transitionId,
      transitionKey,
      workflowId: "workflow-123",
      runId: "run-123",
      workItemId: "plane:2fdebb4c",
      state,
      baseSha: sha,
      occurredAt: now,
      summary: `Entered ${state}`,
      evidence: [evidence],
    };
    assert.equal(workflowEventSchema.parse(event).state, state);
  }
});

test("accepts every control command and all result states", () => {
  const commands = [
    command("attach", { fromSequence: 0 }),
    command("status", {}),
    command("follow_up", { message: "Run the focused matrix again." }),
    command("cancel", { reason: "Superseded by a reviewed request." }),
    command("permission_response", {
      requestId: "permission-1",
      decision: "approve",
      reason: "Scoped and expected.",
    }),
  ];
  for (const value of commands) assert.equal(controlCommandSchema.parse(value).type, value.type);

  for (const status of ["accepted", "applied", "duplicate", "rejected"]) {
    assert.equal(
      controlResultSchema.parse({
        version: contractVersions.controlResult,
        commandId: "command-status",
        workflowId: "workflow-123",
        runId: "run-123",
        status,
        recordedAt: now,
      }).status,
      status,
    );
  }
});

test("canonical serialization and logical IDs are stable and order-independent", () => {
  assert.equal(
    canonicalSerialize({ z: 1, a: { y: 2, x: 3 } }),
    canonicalSerialize({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.throws(() => canonicalSerialize({ invalid: undefined }));
  assert.throws(() => canonicalSerialize(Number.NaN));
  const first = createTransitionId({ workflowId: "workflow-123", transitionKey: "sequence-1" });
  const retry = createTransitionId({ transitionKey: "sequence-1", workflowId: "workflow-123" });
  const next = createTransitionId({ workflowId: "workflow-123", transitionKey: "sequence-2" });
  assert.equal(first, retry);
  assert.notEqual(first, next);
  assert.equal(
    createEventId({ workflowId: "workflow-123", transitionId: first }),
    createEventId({ workflowId: "workflow-123", transitionId: first }),
  );
  assert.notEqual(
    createEventId({ workflowId: "workflow-123", transitionId: first }),
    createEventId({ workflowId: "workflow-123", transitionId: next }),
  );
});

test("rejects unknown versions, fields, states, commands, and malformed identifiers", () => {
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, version: "codeops.work-item/v2" }));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, transcript: "raw transcript" }));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, baseSha: "8f3d2c0" }));
  for (const branch of ["../main", ".", "-bad", "good/.hidden", "good.", "good.lock", "HEAD"]) {
    assert.throws(() => workItemRequestSchema.parse({ ...workItem, branch }));
  }
  assert.equal(
    workItemRequestSchema.parse({ ...workItem, branch: "release/v1.2.3" }).branch,
    "release/v1.2.3",
  );
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, runId: "../run" }));
  assert.throws(() => workflowStateSchema.parse("running"));
  assert.throws(() => controlCommandSchema.parse(command("deploy", {})));
  assert.throws(() => controlCommandSchema.parse({ ...command("status", {}), unexpected: true }));
});

test("rejects an unknown version at every contract boundary", () => {
  const transitionKey = "sequence-requested";
  const transitionId = createTransitionId({ workflowId: "workflow-123", transitionKey });
  const event = {
    version: contractVersions.event,
    eventId: createEventId({ workflowId: "workflow-123", transitionId }),
    transitionId,
    transitionKey,
    workflowId: "workflow-123",
    runId: "run-123",
    workItemId: "plane:2fdebb4c",
    state: "requested",
    baseSha: sha,
    occurredAt: now,
    summary: "Requested.",
    evidence: [],
  };
  const result = {
    version: contractVersions.controlResult,
    commandId: "command-status",
    workflowId: "workflow-123",
    runId: "run-123",
    status: "accepted",
    recordedAt: now,
  };

  for (const [schema, value] of [
    [secretReferenceSchema, secretReference],
    [evidenceReferenceSchema, evidence],
    [workflowEventSchema, event],
    [controlCommandSchema, command("status", {})],
    [controlResultSchema, result],
  ]) {
    assert.throws(() => schema.parse({ ...value, version: "codeops.unknown/v2" }));
  }
});

test("rejects inline secrets and transcript/workspace blobs", () => {
  assert.throws(() =>
    secretReferenceSchema.parse({ ...secretReference, value: "super-secret-material" }),
  );
  assert.throws(() =>
    workItemRequestSchema.parse({
      ...workItem,
      secretReferences: [{ ...secretReference, token: "secret-token" }],
    }),
  );
  assert.throws(() => controlCommandSchema.parse(command("follow_up", { message: "x", apiKey: "x" })));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, workspaceArchive: "blob" }));
});

test("rejects unsafe evidence locations and oversized fields", () => {
  assert.deepEqual(evidenceReferenceSchema.parse(evidence), evidence);
  for (const uri of [
    "http://artifacts.example/report.json",
    "https://user:password@artifacts.example/report.json",
    "https://artifacts.example/report.json?token=secret",
    "file:///workspace/secret",
    "javascript:alert(1)",
    "s3://bucket",
    "artifact://other-host/report.json",
  ]) {
    assert.throws(() => evidenceReferenceSchema.parse({ ...evidence, uri }));
  }
  assert.throws(() => evidenceReferenceSchema.parse({ ...evidence, sizeBytes: 1_000_000_001 }));
  assert.throws(() =>
    workItemRequestSchema.parse({
      ...workItem,
      acceptanceCriteria: ["x".repeat(2_001)],
    }),
  );
  assert.throws(() =>
    controlCommandSchema.parse(command("follow_up", { message: "x".repeat(8_001) })),
  );
});

test("rejects event IDs that do not match the logical transition", () => {
  const transitionKey = "sequence-complete";
  const transitionId = createTransitionId({ workflowId: "workflow-123", transitionKey });
  assert.throws(() =>
    workflowEventSchema.parse({
      version: contractVersions.event,
      eventId: createEventId({ workflowId: "workflow-123", transitionId: "transition:wrong" }),
      transitionId,
      transitionKey,
      workflowId: "workflow-123",
      runId: "run-123",
      workItemId: "plane:2fdebb4c",
      state: "completed",
      baseSha: sha,
      occurredAt: now,
      summary: "Complete.",
      evidence: [],
    }),
  );
});
