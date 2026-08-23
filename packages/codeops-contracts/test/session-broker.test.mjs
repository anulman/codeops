import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  allowedSessionActionsForState,
  SESSION_BROKER_VERSION,
  sessionActionTypeSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionEventSchema,
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  migrateLegacyWorkspaceSessionSnapshot,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionResultSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionSnapshotSchema,
  workspaceSessionIdentitySchema,
  temporalCodeOpsSessionIdentitySchema,
} from "../dist/index.js";

const legacyWorkspaceFixtureUrl = new URL(
  "./fixtures/codeops-0.4.2-workspace-session.json",
  import.meta.url,
);

const sessionId = "ses_91a4";
const leaseId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

function capabilities(state = "running", hasCheckpoint = true) {
  const enabled = allowedSessionActionsForState(state, hasCheckpoint);
  return sessionActionTypeSchema.options.map((action) => ({
    action,
    availability: enabled.includes(action) ? "enabled" : "disabled",
    ...(enabled.includes(action) ? {} : { reason: "Unavailable in this state." }),
  }));
}

function snapshot() {
  return {
    version: SESSION_BROKER_VERSION.snapshot,
    sessionId,
    generation: 3,
    state: "running",
    identity: {
      repository: "example-org/example-repository",
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
      acquiredAt: "2026-08-04T03:00:00.000Z",
      expiresAt: "2026-08-04T03:05:00.000Z",
    },
    checkpoint: {
      version: SESSION_BROKER_VERSION.checkpoint,
      checkpointId,
      sessionId,
      generation: 2,
      baseSha: "a".repeat(40),
      patchDigest: `sha256:${"b".repeat(64)}`,
      acpSessionId: "thread-123",
      eventCursor: 180,
      evidenceReferences: ["evidence:test-1"],
      createdAt: "2026-08-04T02:58:00.000Z",
    },
    pendingPermission: null,
    eventCursor: 184,
    capabilities: capabilities(),
    updatedAt: "2026-08-04T03:04:00.000Z",
  };
}

test("binds a root Job initialization request to one created snapshot", () => {
  const request = sessionJobInitializationRequestSchema.parse({
    version: "codeops.session-job-initialization/v1",
    sessionId,
    identity: snapshot().identity,
    leaseId,
    holderId: "job:agents-video-proof",
    ownerPrincipalId: "access:aidan@example.com",
  });
  assert.equal(request.identity.parentSessionId, null);
  assert.throws(() =>
    sessionJobInitializationRequestSchema.parse({
      ...request,
      identity: {
        ...request.identity,
        parentSessionId: "ses_parent",
        forkedAtCursor: 9,
      },
    }),
  );
  assert.equal(
    sessionJobInitializationResponseSchema.parse({
      version: "codeops.session-job-initialization-result/v1",
      disposition: "created",
      snapshot: { ...snapshot(), generation: 3 },
    }).snapshot.sessionId,
    sessionId,
  );
});

test("keeps work-item identity optional for generic Agent Sessions", () => {
  const request = sessionJobInitializationRequestSchema.parse({
    version: "codeops.session-job-initialization/v1",
    sessionId,
    identity: snapshot().identity,
    leaseId,
    holderId: "job:generic-session",
    ownerPrincipalId: "access:aidan@example.com",
  });
  assert.equal(request.identity.workItemId, undefined);
});

test("admits a first-class scratch or multi-source workspace identity", () => {
  const identity = workspaceSessionIdentitySchema.parse({
    version: "codeops.session-workspace-identity/v1",
    policy: {
      version: "codeops.session-policy/v1",
      mode: "review",
      workspaceAccess: "read-only",
      modelCalls: "allowed",
      modelPolicy: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    },
    workspace: {
      version: "codeops.workspace/v1",
      sources: [
        {
          catalogKey: "example-app",
          repository: "example-org/Example-App",
          checkoutPath: "sources/example-app",
          requestedRef: "main",
          resolvedSha: "c".repeat(40),
        },
        {
          catalogKey: "codeops",
          repository: "anulman/CodeOps",
          checkoutPath: "sources/codeops",
          requestedRef: "main",
          resolvedSha: "d".repeat(40),
        },
      ],
      scratchPath: "scratch",
    },
    workflowId: "workspace-launch",
    runId: "launch-123",
    displayName: "Investigate the estimator",
    parentSessionId: null,
    forkedAtCursor: null,
  });
  assert.equal(identity.workspace.sources.length, 2);
  assert.equal(identity.displayName, "Investigate the estimator");
  assert.equal(
    workspaceSessionIdentitySchema.parse({
      ...identity,
      workspace: { ...identity.workspace, sources: [] },
    }).workspace.sources.length,
    0,
  );
  assert.throws(() =>
    sessionJobInitializationRequestSchema.parse({
      version: "codeops.session-job-initialization/v1",
      sessionId,
      identity: { ...identity, repository: "example-org/escape" },
      leaseId,
      holderId: "job:workspace",
      ownerPrincipalId: "access:aidan@example.com",
    }),
  );
});

test("projects a serialized 0.4.2 workspace snapshot into implement policy without changing rollback bytes", async () => {
  const fixtureBytes = await readFile(legacyWorkspaceFixtureUrl, "utf8");
  const fixture = JSON.parse(fixtureBytes);
  const originalSnapshotBytes = JSON.stringify(fixture.snapshot);
  const originalEvidenceBytes = JSON.stringify(fixture.evidence);

  assert.equal(fixture.source.release, "v0.4.2");
  assert.equal(Object.hasOwn(fixture.snapshot.identity, "policy"), false);
  assert.equal(
    Object.hasOwn(fixture.snapshot.identity, "contextAttachments"),
    false,
  );

  const migrated = sessionSnapshotSchema.parse(fixture.snapshot);
  assert.deepEqual(migrated.identity.policy, {
    version: "codeops.session-policy/v1",
    mode: "implement",
    workspaceAccess: "bounded-writes",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
  });
  assert.deepEqual(migrated.identity.contextAttachments, []);
  assert.equal(migrated.sessionId, fixture.snapshot.sessionId);
  assert.equal(migrated.eventCursor, fixture.snapshot.eventCursor);
  assert.deepEqual(migrated.checkpoint, fixture.snapshot.checkpoint);
  assert.equal(JSON.stringify(fixture.snapshot), originalSnapshotBytes);
  assert.equal(JSON.stringify(fixture.evidence), originalEvidenceBytes);
  assert.deepEqual(
    migrateLegacyWorkspaceSessionSnapshot(migrated),
    migrated,
  );
});

test("fails closed for partial or invalid legacy workspace policy state", async () => {
  const fixture = JSON.parse(await readFile(legacyWorkspaceFixtureUrl, "utf8"));
  const partial = structuredClone(fixture.snapshot);
  partial.identity.contextAttachments = [];
  assert.throws(() => sessionSnapshotSchema.parse(partial));

  const selected = structuredClone(fixture.snapshot);
  selected.identity.policy = {
    version: "codeops.session-policy/v1",
    mode: "explore",
    workspaceAccess: "bounded-writes",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
  };
  assert.throws(() => sessionSnapshotSchema.parse(selected));
});

test("requires work-item, role, and round at the Temporal CodeOps boundary", () => {
  assert.throws(
    () => temporalCodeOpsSessionIdentitySchema.parse(snapshot().identity),
    /Plane work item identity/,
  );
  const identity = temporalCodeOpsSessionIdentitySchema.parse({
    ...snapshot().identity,
    workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
    agentRole: "coding",
    round: 1,
  });
  assert.equal(identity.workItemId, "088a83b9-a53f-4dda-b2bc-c860cf455997");
});

test("binds pull request number and head SHA as one optional identity", () => {
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      identity: { ...snapshot().identity, pullRequestNumber: 159 },
    }),
  );
  const parsed = sessionSnapshotSchema.parse({
    ...snapshot(),
    identity: {
      ...snapshot().identity,
      pullRequestNumber: 159,
      pullRequestHeadSha: "c".repeat(40),
    },
  });
  assert.equal(parsed.identity.pullRequestHeadSha, "c".repeat(40));
});

test("requires one explicit capability decision for every session action", () => {
  const parsed = sessionSnapshotSchema.parse(snapshot());
  assert.deepEqual(
    parsed.capabilities.map(({ action }) => action),
    sessionActionTypeSchema.options,
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().slice(1),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: [...capabilities().slice(1), capabilities()[1]],
    }),
  );
});

test("binds one durable permission request to waiting state", () => {
  const pendingPermission = {
    requestId: "permission-1",
    title: "Run database migration?",
    description: "Apply the reviewed migration to the session database.",
    operation: {
      kind: "command",
      command: "npm run migrate",
      cwd: "/workspace",
    },
    operationDigest: `sha256:${"a".repeat(64)}`,
    options: [
      { optionId: "allow_once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ],
    requestedAt: "2026-08-04T03:04:00.000Z",
  };
  assert.doesNotThrow(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "waiting_permission",
      pendingPermission,
      capabilities: capabilities("waiting_permission", true),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({ ...snapshot(), pendingPermission }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "waiting_permission",
      capabilities: capabilities("waiting_permission", true),
    }),
  );
});

test("fails closed on state-incompatible broker capabilities", () => {
  assert.deepEqual(allowedSessionActionsForState("cancelled", true), [
    "fork",
    "archive",
  ]);
  assert.deepEqual(allowedSessionActionsForState("cancelled", false), [
    "archive",
  ]);
  assert.doesNotThrow(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().map((capability) =>
        capability.availability === "enabled" && capability.action !== "prompt"
          ? {
              action: capability.action,
              availability: "disabled",
              reason: "Temporarily unavailable at the broker.",
            }
          : capability,
      ),
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      capabilities: capabilities().map((capability) =>
        capability.action === "archive"
          ? { action: "archive", availability: "enabled" }
          : capability,
      ),
    }),
  );
});

test("binds snapshots, checkpoints, and leases to one session generation", () => {
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      lease: { ...snapshot().lease, generation: 2 },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      checkpoint: { ...snapshot().checkpoint, sessionId: "ses_foreign" },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      identity: {
        ...snapshot().identity,
        parentSessionId: "ses_parent",
        forkedAtCursor: null,
      },
    }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({ ...snapshot(), lease: null }),
  );
  assert.throws(() =>
    sessionSnapshotSchema.parse({
      ...snapshot(),
      state: "archived",
      lease: {
        leaseId,
        generation: 3,
        status: "released",
        releasedAt: "2026-08-04T03:04:00.000Z",
      },
      checkpoint: null,
      capabilities: capabilities("archived", true),
    }),
  );
});

test("every mutation carries exact generation, lease, and idempotency identity", () => {
  const common = {
    version: SESSION_BROKER_VERSION.command,
    sessionId,
    generation: 3,
    leaseId,
    idempotencyKey,
  };
  const commands = [
    { ...common, type: "prompt", prompt: "Continue the review." },
    {
      ...common,
      type: "respond_permission",
      permissionRequestId: "permission-1",
      decision: { outcome: "selected", optionId: "allow_once" },
    },
    { ...common, type: "cancel", reason: "Operator cancelled." },
    { ...common, type: "checkpoint" },
    { ...common, type: "hibernate" },
    { ...common, type: "resume", checkpointId },
    {
      ...common,
      type: "fork",
      checkpointId,
      parentEventCursor: 184,
      title: "Try an alternate fix",
    },
    { ...common, type: "archive", reason: "Review retained." },
  ];
  assert.deepEqual(
    commands.map((command) => sessionCommandSchema.parse(command).type),
    sessionActionTypeSchema.options,
  );
  for (const field of ["generation", "leaseId", "idempotencyKey"]) {
    assert.throws(() => {
      const command = { ...commands[0] };
      delete command[field];
      sessionCommandSchema.parse(command);
    });
  }
});

test("returns a committed durable snapshot for success and retry", () => {
  const common = {
    version: SESSION_BROKER_VERSION.commandResult,
    commandId: "55555555-5555-4555-8555-555555555555",
    sessionId,
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "prompt",
    eventCursor: 185,
    snapshot: { ...snapshot(), eventCursor: 185 },
    committedAt: "2026-08-04T03:04:01.000Z",
  };
  assert.equal(
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "committed",
    }).disposition,
    "committed",
  );
  assert.equal(
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "duplicate",
      originalCommandId: common.commandId,
    }).disposition,
    "duplicate",
  );
  assert.throws(() =>
    sessionCommandResultSchema.parse({
      ...common,
      disposition: "committed",
      snapshot: { ...snapshot(), sessionId: "ses_foreign" },
    }),
  );
});

test("binds durable transcript messages to their exact broker event types", () => {
  const common = {
    version: SESSION_BROKER_VERSION.event,
    eventId: `sha256:${"c".repeat(64)}`,
    sessionId,
    generation: 3,
    cursor: 185,
    occurredAt: "2026-08-04T03:04:01.000Z",
  };
  assert.deepEqual(sessionEventSchema.parse({
    ...common,
    type: "command_committed",
    message: { role: "user", text: "Continue the review." },
  }).message, { role: "user", text: "Continue the review." });
  assert.deepEqual(sessionEventSchema.parse({
    ...common,
    type: "acp_update",
    message: {
      role: "assistant",
      text: "I completed the review.",
      stopReason: "end_turn",
    },
  }).message, {
    role: "assistant",
    text: "I completed the review.",
    stopReason: "end_turn",
  });
  assert.deepEqual(sessionEventSchema.parse({
    ...common,
    type: "acp_update",
    message: { role: "user", text: "External review prompt." },
  }).message, { role: "user", text: "External review prompt." });
  assert.throws(() => sessionEventSchema.parse({
    ...common,
    type: "command_committed",
    message: { role: "assistant", text: "Wrong event binding.", stopReason: "end_turn" },
  }));
  assert.throws(() => sessionEventSchema.parse({
    ...common,
    type: "acp_update",
    message: { role: "assistant", text: "x".repeat(200_001), stopReason: "end_turn" },
  }));
  assert.equal(sessionEventSchema.parse({
    ...common,
    type: "acp_update",
    update: {
      kind: "tool_call",
      toolCallId: "tool-1",
      title: "Read contract",
      toolKind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Done." } }],
    },
  }).update.kind, "tool_call");
  assert.equal(sessionEventSchema.parse({
    ...common,
    type: "command_committed",
    action: {
      type: "respond_permission",
      decision: { outcome: "selected", optionLabel: "Allow once" },
    },
  }).action.decision.optionLabel, "Allow once");
  assert.throws(() => sessionEventSchema.parse({
    ...common,
    type: "acp_update",
    message: { role: "assistant", text: "Duplicate shape." },
    update: { kind: "thought", content: { type: "text", text: "Hidden duplicate." } },
  }));
});

test("binds ACP permission options to one durable broker request and decision", () => {
  const requestId = "prm_91a4";
  const claimToken = "55555555-5555-4555-8555-555555555555";
  const submission = {
    version: "codeops.session-runtime-permission-submission/v1",
    claimToken,
    request: {
      requestId,
      title: "Edit demo file",
      description: "The ACP agent wants to edit the synthetic demo file.",
      operation: {
        kind: "file_change",
        changes: [{
          path: "demo.txt",
          oldText: "before\n",
          newText: "after\n",
        }],
      },
      operationDigest: `sha256:${"b".repeat(64)}`,
      options: [
        { optionId: "opt_allow", label: "Allow once" },
        { optionId: "opt_deny", label: "Deny once" },
      ],
      requestedAt: "2026-08-05T03:26:00.000Z",
    },
    acpSessionId: "acp-session-1",
    toolCallId: "tool-call-1",
    options: [
      { optionId: "opt_allow", acpOptionId: "allow-once/raw" },
      { optionId: "opt_deny", acpOptionId: "reject-once/raw" },
    ],
  };
  assert.equal(
    sessionRuntimePermissionSubmissionSchema.parse(submission).request.requestId,
    requestId,
  );
  assert.throws(() =>
    sessionRuntimePermissionSubmissionSchema.parse({
      ...submission,
      options: submission.options.slice(0, 1),
    }),
  );
  assert.equal(
    sessionRuntimePermissionPollSchema.parse({
      version: "codeops.session-runtime-permission-poll/v1",
      claimToken,
      requestId,
    }).requestId,
    requestId,
  );
  assert.equal(
    sessionRuntimePermissionResultSchema.parse({
      version: "codeops.session-runtime-permission-result/v1",
      dispatchId: "66666666-6666-4666-8666-666666666666",
      requestId,
      disposition: "decided",
      decision: { outcome: "selected", acpOptionId: "allow-once/raw" },
    }).disposition,
    "decided",
  );
  assert.throws(() =>
    sessionRuntimePermissionResultSchema.parse({
      version: "codeops.session-runtime-permission-result/v1",
      dispatchId: "66666666-6666-4666-8666-666666666666",
      requestId,
      disposition: "pending",
      decision: { outcome: "denied" },
    }),
  );
});
