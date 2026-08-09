import assert from "node:assert/strict";
import test from "node:test";
import {
  applySessionRuntimeCompletion,
  buildSessionRuntimeDispatch,
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchSchema,
} from "../dist/session-broker-runtime.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const dispatchId = "44444444-4444-4444-8444-444444444444";
const completedAt = "2026-08-04T16:55:00.000Z";
const promptMaterial = {
  response: "I updated the focused implementation and verified the result.",
  stopReason: "end_turn",
};
const actions = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive", "delete",
];

function capabilities(enabled) {
  return actions.map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
    generation: 3,
    state: "running",
    identity: {
      repository: "anulman/renoconcierge",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "workflow-155",
      runId: "run-155",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 3,
      status: "active",
      holderId: "worker-3",
      acquiredAt: "2026-08-04T16:30:00.000Z",
      expiresAt: "2026-08-04T17:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(["prompt", "cancel", "checkpoint", "hibernate"]),
    updatedAt: "2026-08-04T16:40:00.000Z",
    ...overrides,
  };
}

function command(type, overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type,
    ...(type === "prompt" ? { prompt: "Continue the focused implementation." } : {}),
    ...overrides,
  };
}

function dispatch(type, snapshotOverrides = {}, commandOverrides = {}) {
  return buildSessionRuntimeDispatch({
    dispatchId,
    principalId: "access:aidan@example.com",
    command: command(type, commandOverrides),
    snapshot: snapshot(snapshotOverrides),
    dispatchedAt: "2026-08-04T16:50:00.000Z",
  });
}

function completion(type, material) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    observedEventCursor: 184,
    type,
    ...(material ? { material } : {}),
    completedAt,
  };
}

const context = {
  commandId: "55555555-5555-4555-8555-555555555555",
  committedAt: completedAt,
};

test("builds only an exact enabled ACP runtime dispatch", () => {
  const value = dispatch("prompt");
  assert.equal(sessionRuntimeDispatchSchema.parse(value).command.type, "prompt");
  assert.throws(() => buildSessionRuntimeDispatch({
    ...value,
    command: { ...value.command, generation: 2 },
  }), /exact session generation and lease/);
  assert.throws(() => dispatch("resume", {}, { checkpointId }), /enabled session capability/);
  assert.throws(() => buildSessionRuntimeDispatch({
    ...value,
    principalId: "bad principal",
  }));
});

test("commits one prompt and assistant response as ordered transcript events", () => {
  const mutation = applySessionRuntimeCompletion(
    dispatch("prompt"),
    completion("prompt", promptMaterial),
    context,
  );
  assert.equal(mutation.result.type, "prompt");
  assert.equal(mutation.result.snapshot.state, "running");
  assert.equal(mutation.result.eventCursor, 186);
  assert.deepEqual(mutation.events.map(({ type, cursor }) => [type, cursor]), [
    ["command_committed", 185],
    ["acp_update", 186],
  ]);
  assert.deepEqual(mutation.events.map(({ message }) => message), [
    { role: "user", text: "Continue the focused implementation." },
    {
      role: "assistant",
      text: promptMaterial.response,
      stopReason: promptMaterial.stopReason,
    },
  ]);
});

test("commits ordered ACP execution updates, message boundaries, and attachments", () => {
  const updates = [
    { kind: "user_content", messageId: "prompt-echo", content: { type: "text", text: "Continue the focused implementation." } },
    { kind: "user_content", messageId: "external-review", content: { type: "text", text: "Please also cover the PR review note." } },
    { kind: "plan", entries: [{ content: "Inspect the boundary", priority: "high", status: "in_progress" }] },
    { kind: "thought", messageId: "thought-1", content: { type: "text", text: "I need to inspect the exact contract." } },
    { kind: "tool_call", toolCallId: "tool-1", title: "Read contract", toolKind: "read", status: "in_progress" },
    { kind: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Contract loaded." } }] },
    { kind: "assistant_content", messageId: "message-1", content: { type: "text", text: "The contract is valid." } },
    { kind: "assistant_content", messageId: "message-2", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
    { kind: "assistant_content", messageId: "message-2", content: { type: "text", text: "Here is the visual proof." } },
  ];
  const mutation = applySessionRuntimeCompletion(
    dispatch("prompt"),
    completion("prompt", { ...promptMaterial, updates }),
    context,
  );
  assert.equal(mutation.result.eventCursor, 193);
  assert.equal(mutation.events.length, 9);
  assert.equal(
    mutation.events.filter(({ message }) => message?.role === "user").length,
    2,
    "the broker prompt appears once and the external user prompt is retained",
  );
  assert.equal(
    mutation.events.find(({ message }) => message?.text === "Please also cover the PR review note.")?.message?.role,
    "user",
  );
  assert.equal(
    mutation.events.find(({ message }) => message?.text === "Please also cover the PR review note.")?.message?.messageId,
    "external-review",
  );
  assert.deepEqual(mutation.events.filter(({ message }) => message?.role === "assistant").map(({ message }) => message), [
    { role: "assistant", text: "The contract is valid.", messageId: "message-1" },
    { role: "assistant", text: "Here is the visual proof.", messageId: "message-2", stopReason: "end_turn" },
  ]);
  assert.deepEqual(mutation.events.filter(({ update }) => update).map(({ update }) => update.kind), [
    "plan", "thought", "tool_call", "tool_call_update", "assistant_content",
  ]);
  const laterMatchingPrompt = applySessionRuntimeCompletion(
    dispatch("prompt"),
    completion("prompt", {
      ...promptMaterial,
      updates: [
        updates[2],
        { kind: "user_content", messageId: "external-later", content: { type: "text", text: "Continue the focused implementation." } },
        updates[6],
      ],
    }),
    context,
  );
  assert.equal(
    laterMatchingPrompt.events.filter(({ message }) => message?.role === "user").length,
    2,
    "only a leading ACP prompt echo is removed",
  );
});

test("commits a prompt after one exact permission request and decision", () => {
  const permissionResolved = snapshot({
    eventCursor: 186,
    updatedAt: "2026-08-04T16:54:00.000Z",
  });
  const mutation = applySessionRuntimeCompletion(
    dispatch("prompt"),
    completion("prompt", promptMaterial),
    context,
    permissionResolved,
  );
  assert.equal(mutation.result.eventCursor, 188);
  assert.deepEqual(mutation.events.map(({ type, cursor }) => [type, cursor]), [
    ["command_committed", 187],
    ["acp_update", 188],
  ]);
  assert.throws(() => applySessionRuntimeCompletion(
    dispatch("prompt"),
    completion("prompt", promptMaterial),
    context,
    snapshot({
      eventCursor: 186,
      generation: 4,
      lease: { ...snapshot().lease, generation: 4 },
    }),
  ), /exact dispatch lineage/);
});

test("rejects a completion that drifts from its exact dispatch snapshot", () => {
  const current = dispatch("prompt");
  for (const drift of [
    { dispatchId: "66666666-6666-4666-8666-666666666666" },
    { idempotencyKey: "77777777-7777-4777-8777-777777777777" },
    { observedEventCursor: 183 },
    { completedAt: "2026-08-04T16:49:59.000Z" },
    { type: "checkpoint", material: {
      checkpointId,
      patchDigest: `sha256:${"d".repeat(64)}`,
      acpSessionId: "acp-ses-91a4",
      evidenceReferences: [],
    } },
  ]) {
    assert.throws(() => applySessionRuntimeCompletion(
      current,
      { ...completion("prompt", promptMaterial), ...drift },
      context,
    ), /exact dispatch|Invalid/);
  }
});

test("adapts checkpoint and hibernate completions without trusting identity fields", () => {
  const material = {
    checkpointId,
    patchDigest: `sha256:${"d".repeat(64)}`,
    acpSessionId: "acp-ses-91a4",
    evidenceReferences: ["evidence-1"],
  };
  for (const type of ["checkpoint", "hibernate"]) {
    const mutation = applySessionRuntimeCompletion(
      dispatch(type),
      completion(type, material),
      context,
    );
    assert.equal(mutation.result.snapshot.checkpoint.sessionId, "ses_91a4");
    assert.equal(mutation.result.snapshot.checkpoint.generation, 3);
    assert.equal(mutation.result.snapshot.checkpoint.baseSha, "a".repeat(40));
    assert.equal(
      mutation.result.snapshot.state,
      type === "hibernate" ? "hibernated" : "running",
    );
  }
});

test("adapts exact resume and fork runtime lease material", () => {
  const checkpoint = {
    version: "codeops.session-checkpoint/v1",
    checkpointId,
    sessionId: "ses_91a4",
    generation: 3,
    baseSha: "a".repeat(40),
    patchDigest: `sha256:${"b".repeat(64)}`,
    acpSessionId: "acp-parent",
    eventCursor: 184,
    evidenceReferences: [],
    createdAt: "2026-08-04T16:40:00.000Z",
  };
  const released = {
    leaseId,
    generation: 3,
    status: "released",
    releasedAt: "2026-08-04T16:40:00.000Z",
  };
  const runtimeLease = {
    leaseId: "77777777-7777-4777-8777-777777777777",
    holderId: "worker-4",
    acquiredAt: completedAt,
    expiresAt: "2026-08-04T17:15:00.000Z",
  };
  const resume = applySessionRuntimeCompletion(
    dispatch(
      "resume",
      {
        state: "hibernated",
        lease: released,
        checkpoint,
        capabilities: capabilities(["resume", "fork", "archive"]),
      },
      { checkpointId },
    ),
    completion("resume", runtimeLease),
    context,
  );
  assert.equal(resume.result.snapshot.generation, 4);
  assert.equal(resume.result.snapshot.lease.leaseId, runtimeLease.leaseId);

  const fork = applySessionRuntimeCompletion(
    dispatch(
      "fork",
      {
        state: "completed",
        lease: released,
        checkpoint,
        capabilities: capabilities(["fork", "archive"]),
      },
      { checkpointId, parentEventCursor: 184, title: "Alternative" },
    ),
    completion("fork", {
      ...runtimeLease,
      sessionId: "ses_child",
      branch: "feat/agents-ui-child",
      workflowId: "workflow-child",
      runId: "run-child",
    }),
    context,
  );
  assert.equal(fork.result.snapshot.identity.parentSessionId, "ses_91a4");
  assert.equal(fork.result.snapshot.eventCursor, 1);
  assert.equal(sessionRuntimeCompletionSchema.parse(completion("resume", runtimeLease)).type, "resume");
});
