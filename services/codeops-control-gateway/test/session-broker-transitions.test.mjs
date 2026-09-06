import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCheckpointSessionTransition,
  applyForkSessionTransition,
  applyLocalSessionTransition,
  applyPermissionSessionTransition,
  applyPromptSessionTransition,
  applyResumeSessionTransition,
  applyRuntimePermissionRequestTransition,
} from "../dist/session-broker-transitions.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const checkpointId = "22222222-2222-4222-8222-222222222222";
const occurredAt = "2026-08-04T04:45:00.000Z";

const allActions = [
  "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
  "resume", "fork", "archive",
];

function capabilities(enabled) {
  return allActions.map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot({ state = "running", checkpoint = true, enabled = ["prompt", "cancel", "checkpoint", "hibernate"] } = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
    generation: 3,
    state,
    identity: {
      repository: "example-org/example-repository",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "workflow-155",
      runId: "run-155",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: state === "running" || state === "waiting_permission"
      ? {
          leaseId,
          generation: 3,
          status: "active",
          holderId: "worker-3",
          acquiredAt: "2026-08-04T04:30:00.000Z",
          expiresAt: "2026-08-04T04:50:00.000Z",
        }
      : {
          leaseId,
          generation: 3,
          status: "released",
          releasedAt: "2026-08-04T04:40:00.000Z",
        },
    checkpoint: checkpoint
      ? {
          version: "codeops.session-checkpoint/v1",
          checkpointId,
          sessionId: "ses_91a4",
          generation: 3,
          baseSha: "a".repeat(40),
          patchDigest: `sha256:${"b".repeat(64)}`,
          acpSessionId: "acp-ses-91a4",
          eventCursor: 184,
          evidenceReferences: [],
          createdAt: "2026-08-04T04:40:00.000Z",
        }
      : null,
    pendingPermission: state === "waiting_permission"
      ? {
          requestId: "permission-1",
          title: "Run database migration?",
          description: "Apply the reviewed migration.",
          options: [
            { optionId: "allow_once", label: "Allow once" },
            { optionId: "deny", label: "Deny" },
          ],
          requestedAt: "2026-08-04T04:39:00.000Z",
        }
      : null,
    eventCursor: 184,
    capabilities: capabilities(enabled),
    updatedAt: "2026-08-04T04:40:00.000Z",
  };
}

function command(type, overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    type,
    reason: "Operator requested lifecycle transition.",
    ...overrides,
  };
}

test("cancel releases the lease and retains a resumable checkpoint", () => {
  const result = applyLocalSessionTransition(snapshot(), command("cancel"), occurredAt);
  assert.equal(result.snapshot.state, "cancelled");
  assert.equal(result.snapshot.lease.status, "released");
  assert.equal(result.snapshot.checkpoint.checkpointId, checkpointId);
  assert.deepEqual(
    result.snapshot.capabilities.filter(({ availability }) => availability === "enabled").map(({ action }) => action),
    ["fork", "archive"],
  );
  assert.equal(result.event.type, "state_changed");
  assert.equal(result.event.cursor, 185);
});

test("permission response resolves only the exact pending request", () => {
  const current = snapshot({
    state: "waiting_permission",
    enabled: ["respond_permission", "cancel", "checkpoint", "hibernate"],
  });
  const permission = command("respond_permission", {
    permissionRequestId: "permission-1",
    decision: { outcome: "selected", optionId: "allow_once" },
  });
  const result = applyPermissionSessionTransition(
    current,
    permission,
    occurredAt,
  );
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.snapshot.pendingPermission, null);
  assert.equal(result.snapshot.lease.status, "active");
  assert.equal(result.event.type, "command_committed");
  assert.equal(result.event.cursor, 185);
  assert.deepEqual(result.event.action, {
    type: "respond_permission",
    decision: { outcome: "selected", optionLabel: "Allow once" },
  });
  const denied = applyPermissionSessionTransition(
    current,
    {
      ...permission,
      decision: { outcome: "denied" },
    },
    occurredAt,
  );
  assert.deepEqual(denied.event.action, {
    type: "respond_permission",
    decision: { outcome: "denied" },
  });
  assert.throws(() =>
    applyPermissionSessionTransition(
      current,
      { ...permission, permissionRequestId: "permission-other" },
      occurredAt,
    ),
  );
  assert.throws(() =>
    applyPermissionSessionTransition(
      current,
      { ...permission, decision: { outcome: "selected", optionId: "always" } },
      occurredAt,
    ),
  );
});

test("ACP runtime permission request durably pauses one running session", () => {
  const current = snapshot();
  const request = {
    requestId: "prm_91a4",
    title: "Edit demo file",
    description: "The ACP agent wants to edit the synthetic demo file.",
    operation: {
      kind: "file_change",
      changes: [{ path: "demo.txt", oldText: "before", newText: "after" }],
    },
    operationDigest: `sha256:${"a".repeat(64)}`,
    options: [
      { optionId: "opt_allow", label: "Allow once" },
      { optionId: "opt_deny", label: "Deny once" },
    ],
    requestedAt: occurredAt,
  };
  const result = applyRuntimePermissionRequestTransition(
    current,
    request,
    occurredAt,
  );
  assert.equal(result.snapshot.state, "waiting_permission");
  assert.deepEqual(result.snapshot.pendingPermission, request);
  assert.equal(result.snapshot.lease.status, "active");
  assert.deepEqual(
    result.snapshot.capabilities
      .filter(({ availability }) => availability === "enabled")
      .map(({ action }) => action),
    ["respond_permission", "cancel", "checkpoint", "hibernate"],
  );
  assert.equal(result.event.type, "permission_requested");
  assert.equal(result.event.cursor, 185);
  assert.throws(() =>
    applyRuntimePermissionRequestTransition(
      snapshot({
        state: "waiting_permission",
        enabled: ["respond_permission", "cancel", "checkpoint", "hibernate"],
      }),
      request,
      occurredAt,
    ),
  );
});

test("treats ACP usage updates as context telemetry, not provider requests", () => {
  const current = {
    ...snapshot({ checkpoint: false }),
    budget: {
      version: "codeops.session-budget/v1",
      startedAt: "2026-08-04T04:30:00.000Z",
      observedAt: "2026-08-04T04:40:00.000Z",
      limits: {
        elapsedSeconds: 3600,
        totalTokens: 50_000,
        modelRequests: 4,
        activeChildren: 2,
      },
      usage: {
        elapsedSeconds: 600,
        totalTokens: 10_000,
        modelRequests: 1,
        activeChildren: 1,
      },
      remaining: {
        elapsedSeconds: 3000,
        totalTokens: 40_000,
        modelRequests: 3,
        activeChildren: 1,
      },
      exhaustedLimit: null,
    },
  };
  const result = applyPromptSessionTransition(
    current,
    command("prompt", { prompt: "Continue the exact task." }),
    {
      response: "Done.",
      stopReason: "end_turn",
      updates: [{
        kind: "usage",
        usedTokens: 12_500,
        contextWindowTokens: 200_000,
      }],
    },
    occurredAt,
  );
  assert.deepEqual(result.snapshot.budget.usage, {
    elapsedSeconds: 900,
    totalTokens: 12_500,
    modelRequests: 1,
    activeChildren: 1,
  });
  assert.deepEqual(result.snapshot.budget.remaining, {
    elapsedSeconds: 2700,
    totalTokens: 37_500,
    modelRequests: 3,
    activeChildren: 1,
  });
  assert.equal(result.snapshot.budget.exhaustedLimit, null);
});

test("archive remains resumable only when a checkpoint exists", () => {
  for (const checkpoint of [true, false]) {
    const current = snapshot({
      state: "completed",
      checkpoint,
      enabled: checkpoint ? ["fork", "archive"] : ["archive"],
    });
    const result = applyLocalSessionTransition(current, command("archive"), occurredAt);
    assert.equal(result.snapshot.state, "archived");
    assert.equal(result.snapshot.lease.status, "released");
    const enabled = result.snapshot.capabilities
      .filter(({ availability }) => availability === "enabled")
      .map(({ action }) => action);
    assert.deepEqual(enabled, checkpoint ? ["resume", "fork"] : []);
    assert.equal(result.event.type, "session_archived");
  }
});

test("commits a checkpoint and hibernates with one released lease", () => {
  const current = snapshot({ checkpoint: false });
  const material = {
    checkpointId,
    patchDigest: `sha256:${"d".repeat(64)}`,
    acpSessionId: "acp-ses-91a4",
    evidenceReferences: ["evidence-1"],
  };
  const checkpointed = applyCheckpointSessionTransition(
    current,
    command("checkpoint"),
    material,
    occurredAt,
  );
  assert.equal(checkpointed.snapshot.state, "running");
  assert.equal(checkpointed.snapshot.checkpoint.eventCursor, 185);
  assert.equal(checkpointed.snapshot.eventCursor, 185);
  assert.deepEqual(checkpointed.events.map(({ type }) => type), [
    "checkpoint_committed",
  ]);

  const hibernated = applyCheckpointSessionTransition(
    current,
    command("hibernate", { reason: "Wait for review." }),
    material,
    occurredAt,
  );
  assert.equal(hibernated.snapshot.state, "hibernated");
  assert.equal(hibernated.snapshot.lease.status, "released");
  assert.equal(hibernated.snapshot.checkpoint.eventCursor, 185);
  assert.equal(hibernated.snapshot.eventCursor, 186);
  assert.deepEqual(hibernated.events.map(({ type, cursor }) => [type, cursor]), [
    ["checkpoint_committed", 185],
    ["lease_changed", 186],
  ]);
  assert.deepEqual(hibernated.events[0].action, {
    type: "hibernate",
    detail: "Wait for review.",
  });
});

test("resumes only the exact checkpoint into a new active generation", () => {
  const current = snapshot({
    state: "hibernated",
    enabled: ["resume", "fork", "archive"],
  });
  const command = {
    version: "codeops.session-command/v1",
    sessionId: current.sessionId,
    generation: current.generation,
    leaseId,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    type: "resume",
    checkpointId,
  };
  const result = applyResumeSessionTransition(
    current,
    command,
    {
      leaseId: "77777777-7777-4777-8777-777777777777",
      holderId: "worker-4",
      acquiredAt: occurredAt,
      expiresAt: "2026-08-04T05:05:00.000Z",
    },
    occurredAt,
  );
  assert.equal(result.snapshot.generation, 4);
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.snapshot.lease.generation, 4);
  assert.equal(result.snapshot.lease.status, "active");
  assert.equal(result.event.generation, 4);
  assert.equal(result.event.cursor, 185);
  assert.throws(() =>
    applyResumeSessionTransition(
      current,
      { ...command, checkpointId: "99999999-9999-4999-8999-999999999999" },
      {
        leaseId: "77777777-7777-4777-8777-777777777777",
        holderId: "worker-4",
        acquiredAt: occurredAt,
        expiresAt: "2026-08-04T05:05:00.000Z",
      },
      occurredAt,
    ),
  );
});

test("forks one generation-one child with independent cursor lineage", () => {
  const current = snapshot({
    state: "completed",
    enabled: ["fork", "archive"],
  });
  const command = {
    version: "codeops.session-command/v1",
    sessionId: current.sessionId,
    generation: current.generation,
    leaseId,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    type: "fork",
    checkpointId,
    parentEventCursor: 184,
    title: "Alternative implementation",
  };
  const result = applyForkSessionTransition(
    current,
    command,
    {
      sessionId: "ses_child",
      branch: "feat/agents-ui-child",
      workflowId: "workflow-child",
      runId: "run-child",
      leaseId: "77777777-7777-4777-8777-777777777777",
      holderId: "worker-child",
      acquiredAt: occurredAt,
      expiresAt: "2026-08-04T05:05:00.000Z",
    },
    occurredAt,
  );
  assert.equal(result.snapshot.sessionId, "ses_child");
  assert.equal(result.snapshot.generation, 1);
  assert.equal(result.snapshot.identity.parentSessionId, current.sessionId);
  assert.equal(result.snapshot.identity.forkedAtCursor, 184);
  assert.equal(result.snapshot.identity.workflowId, current.identity.workflowId);
  assert.equal(result.snapshot.identity.runId, "run-child");
  assert.equal(result.snapshot.identity.displayName, command.title);
  assert.equal(result.snapshot.eventCursor, 1);
  assert.equal(result.snapshot.budget.startedAt, occurredAt);
  assert.equal(result.snapshot.budget.usage.modelRequests, 0);
  assert.equal(result.event.cursor, 1);
  assert.equal(result.event.type, "session_created");
  assert.throws(() =>
    applyForkSessionTransition(
      current,
      { ...command, parentEventCursor: 183 },
      {
        sessionId: "ses_child",
        branch: "feat/agents-ui-child",
        workflowId: "workflow-child",
        runId: "run-child",
        leaseId: "77777777-7777-4777-8777-777777777777",
        holderId: "worker-child",
        acquiredAt: occurredAt,
        expiresAt: "2026-08-04T05:05:00.000Z",
      },
      occurredAt,
    ),
  );
});

test("uses legacy checkpoint and branch fork material for trusted Temporal v2 identity", () => {
  const trusted = snapshot({ checkpoint: false });
  trusted.identity = {
    version: "codeops.temporal-session-identity/v2",
    ...trusted.identity,
    workItemId: "44444444-4444-4444-8444-444444444444",
    pullRequestNumber: 94,
    pullRequestHeadSha: "a".repeat(40),
    agentRole: "coding",
    round: 1,
    planeWorkItem: {
      version: "codeops.trusted-plane-work-item-reference/v1",
      apiOrigin: "https://plane.example.com/",
      workspaceSlug: "engineering",
      workspaceId: "55555555-5555-4555-8555-555555555555",
      projectId: "66666666-6666-4666-8666-666666666666",
      projectIdentifier: "COAUTO",
      workItemId: "44444444-4444-4444-8444-444444444444",
      sequenceId: 19,
      reference: "COAUTO-19",
    },
  };
  const checkpoint = applyCheckpointSessionTransition(
    trusted,
    command("checkpoint"),
    {
      checkpointId,
      patchDigest: `sha256:${"c".repeat(64)}`,
      acpSessionId: "acp-trusted",
      evidenceReferences: [],
    },
    occurredAt,
  );
  assert.equal(checkpoint.snapshot.checkpoint.version, "codeops.session-checkpoint/v1");
  assert.throws(() =>
    applyCheckpointSessionTransition(
      trusted,
      command("checkpoint"),
      {
        version: "codeops.session-workspace-checkpoint-material/v1",
        checkpointId,
        workspaceManifestDigest: `sha256:${"d".repeat(64)}`,
        sourcePatches: [],
        scratchArtifactDigest: `sha256:${"e".repeat(64)}`,
        acpSessionId: "acp-trusted",
        evidenceReferences: [],
      },
      occurredAt,
    ),
    /workspace identity/,
  );

  const terminal = {
    ...checkpoint.snapshot,
    state: "completed",
    lease: {
      ...checkpoint.snapshot.lease,
      status: "released",
      releasedAt: occurredAt,
    },
    capabilities: capabilities(["fork", "archive"]),
  };
  const forkCommand = {
    ...command("fork"),
    checkpointId,
    parentEventCursor: terminal.eventCursor,
    title: "Trusted Plane fork",
  };
  const lease = {
    sessionId: "ses_trusted_child",
    workflowId: "trusted-child",
    runId: "trusted-child",
    leaseId: "77777777-7777-4777-8777-777777777777",
    holderId: "worker-child",
    acquiredAt: occurredAt,
    expiresAt: "2026-08-04T05:05:00.000Z",
  };
  const fork = applyForkSessionTransition(
    terminal,
    forkCommand,
    { ...lease, branch: "feat/agents-ui-trusted-child" },
    occurredAt,
  );
  assert.equal(fork.snapshot.identity.version, "codeops.temporal-session-identity/v2");
  assert.equal(fork.snapshot.identity.branch, "feat/agents-ui-trusted-child");
  assert.throws(() =>
    applyForkSessionTransition(
      terminal,
      forkCommand,
      { ...lease, workspace: true },
      occurredAt,
    ),
    /workspace identity/,
  );
});

test("budget-stop prompt completion commits its checkpoint in the same ordered history", () => {
  const before = snapshot({ checkpoint: false });
  const result = applyPromptSessionTransition(before, command("prompt", { prompt: "Implement." }), {
    response: "Budget closeout. Work is checkpointed; validation remains pending.",
    stopReason: "max_turn_requests",
    checkpoint: { checkpointId, patchDigest: `sha256:${"b".repeat(64)}`,
      acpSessionId: "acp-budget", evidenceReferences: [`artifact:${checkpointId}:source:repository`] },
  }, occurredAt);
  assert.equal(result.snapshot.checkpoint.checkpointId, checkpointId);
  assert.equal(result.snapshot.checkpoint.generation, before.generation);
  assert.equal(result.snapshot.lease.leaseId, before.lease.leaseId);
  assert.equal(result.events.at(-1).type, "checkpoint_committed");
  assert.equal(result.snapshot.eventCursor, result.events.at(-1).cursor);
  assert.equal(result.events.at(-2).message.stopReason, "max_turn_requests");
});
