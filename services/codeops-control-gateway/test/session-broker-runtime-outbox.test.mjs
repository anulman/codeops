import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionBudget, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import {
  ImmutableSessionRuntimeDispatchConflictError,
  claimSessionRuntimeDispatch,
  completeSessionRuntimeDispatch,
  enqueueSessionRuntimeDispatch,
  renewSessionRuntimeDispatchClaim,
} from "../dist/session-broker-runtime-outbox.js";

const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const runtimeRequirements = {
  version: "codeops.runtime-requirements/v1", capabilities: ["acp"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1280, ephemeralStorageMiB: 1280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "compatible-substitution-v1",
};
const runtimeRequirementDigest = sha256CanonicalJsonDigest(runtimeRequirements);
const runtimeProfile = {
  version: "codeops.runtime-profile/v1", profileId: "standard-v1",
  releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"],
  capabilityDigest: sha256CanonicalJsonDigest(["acp"]),
  resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
  authority: runtimeRequirements.maximumAuthority,
  compatibilityPolicyRevision: "compatible-substitution-v1",
  images: { agent: `example/agent@sha256:${"8".repeat(64)}`, worker: `example/worker@sha256:${"9".repeat(64)}`,
    sessionGateway: `example/gateway@sha256:${"a".repeat(64)}` },
};
const runtimeLaunchBinding = {
  version: "codeops.runtime-launch-binding/v1",
  requirementDigest: runtimeRequirementDigest,
  profile: runtimeProfile,
  selectedAt: "2026-08-04T17:00:00.000Z",
};
const promptMaterial = {
  response: "I updated the focused implementation and verified the result.",
  stopReason: "end_turn",
};

const claimAuthority = () => ({
  sessionId: snapshot().sessionId,
  generation: snapshot().generation,
  leaseId: snapshot().lease.leaseId,
  identity: snapshot().identity,
  runtimeProfileId: runtimeProfile.profileId,
  runtimeReleaseDigest: runtimeProfile.releaseDigest,
  runtimeCapabilityDigest: runtimeProfile.capabilityDigest,
  runtimeProfile,
});

function snapshot(overrides = {}) {
  const enabled = new Set(["prompt", "cancel", "checkpoint", "hibernate"]);
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_91a4",
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
      acquiredAt: "2026-08-04T17:30:00.000Z",
      expiresAt: "2026-08-04T18:30:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 184,
    capabilities: [
      "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
      "resume", "fork", "archive",
    ].map((action) => enabled.has(action)
      ? { action, availability: "enabled" }
      : { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-08-04T17:40:00.000Z",
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    type: "prompt",
    prompt: "Continue the focused implementation.",
    ...overrides,
  };
}

class EnqueueClient {
  constructor(existing = null, committed = null) {
    this.existing = existing;
    this.committed = committed;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: snapshot() }] };
    }
    if (text.includes("FROM codeops.session_commands")) {
      return {
        rowCount: this.committed ? 1 : 0,
        rows: this.committed ? [{ command_json: this.committed }] : [],
      };
    }
    if (text.includes("FROM codeops.session_runtime_outbox")) {
      return {
        rowCount: this.existing ? 1 : 0,
        rows: this.existing ? [{ dispatch_json: this.existing }] : [],
      };
    }
    return { rowCount: 1, rows: [] };
  }
}

const enqueue = (client, overrides = {}) => enqueueSessionRuntimeDispatch(client, {
  command: command(),
  principalId: "access:aidan@example.com",
  now: () => new Date("2026-08-04T18:00:00.000Z"),
  dispatchId: () => dispatchId,
  ...overrides,
});

test("atomically enqueues one exact immutable runtime dispatch", async () => {
  const client = new EnqueueClient();
  const dispatch = await enqueue(client);
  assert.equal(dispatch.dispatchId, dispatchId);
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[2].text, /session_commands[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /session_runtime_outbox[\s\S]*FOR UPDATE/);
  const insert = client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.session_runtime_outbox"));
  assert.deepEqual(insert.values.slice(0, 4), [
    dispatchId,
    "ses_91a4",
    idempotencyKey,
    "access:aidan@example.com",
  ]);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("shares one immutable idempotency namespace with committed commands", async () => {
  const client = new EnqueueClient(null, command());
  await assert.rejects(enqueue(client), ImmutableSessionRuntimeDispatchConflictError);
  assert.equal(
    client.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
    false,
  );
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("replays an exact outbox identity and rejects immutable conflicts", async () => {
  const original = await enqueue(new EnqueueClient());
  const replayClient = new EnqueueClient(original);
  assert.equal((await enqueue(replayClient)).dispatchId, original.dispatchId);
  assert.equal(
    replayClient.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
    false,
  );

  const conflictClient = new EnqueueClient(original);
  await assert.rejects(
    enqueue(conflictClient, { command: command({ prompt: "Different." }) }),
    ImmutableSessionRuntimeDispatchConflictError,
  );
  assert.equal(conflictClient.calls.at(-1).text, "ROLLBACK");
});

test("fails before enqueue when the exact generation, lease, or capability drifted", async () => {
  for (const drift of [
    { generation: 2 },
    { leaseId: "99999999-9999-4999-8999-999999999999" },
    { type: "resume", checkpointId: "22222222-2222-4222-8222-222222222222", prompt: undefined },
  ]) {
    const client = new EnqueueClient();
    await assert.rejects(enqueue(client, { command: command(drift) }));
    assert.equal(
      client.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_runtime_outbox")),
      false,
    );
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});

class ClaimClient {
  constructor(row, owner = undefined) {
    this.row = row;
    this.owner = owner;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("AS workspace_launch_id")) {
      return { rowCount: 1, rows: [{
        root_session_id: this.owner?.root_session_id ?? snapshot().sessionId,
        workspace_launch_id: snapshot().identity.runId,
      }] };
    }
    if (text.includes("WITH RECURSIVE lineage")) {
      return { rowCount: 1, rows: [this.owner ?? {
        root_session_id: snapshot().sessionId,
        claimant_legacy_runtime_worker_compatible: false,
        session_runtime_requirements_json: null,
        session_runtime_requirement_digest: null,
        session_runtime_launch_binding_json: null,
        legacy_runtime_worker_compatible: false,
        workspace_state: "ready",
        workspace_runtime_requirements_json: runtimeRequirements,
        workspace_runtime_requirement_digest: runtimeRequirementDigest,
        workspace_runtime_launch_binding_json: runtimeLaunchBinding,
      }] };
    }
    if (text.includes("WITH candidate AS")) {
      const legacy = values[13] === true;
      return {
        rowCount: this.row ? 1 : 0,
        rows: this.row ? [{
          ...this.row,
          is_admitted_initial_dispatch:
            this.row.is_admitted_initial_dispatch ?? false,
          runtime_binding_json: legacy ? null : JSON.parse(values[8]),
          runtime_claim_protocol: legacy ? "legacy-unproven-v1" : "bound-v2",
        }] : [],
      };
    }
    return { rowCount: 0, rows: [] };
  }
}

class RenewClient extends ClaimClient {
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("UPDATE codeops.session_runtime_outbox AS outbox")) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [this.row] : [] };
    }
    return { rowCount: 0, rows: [] };
  }
}

test("upgrades only pre-migration active roots for older running workers", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const row = {
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 1,
  };
  const legacyOwner = {
    root_session_id: snapshot().sessionId,
    claimant_legacy_runtime_worker_compatible: true,
    session_runtime_requirements_json: null,
    session_runtime_requirement_digest: null,
    session_runtime_launch_binding_json: null,
    legacy_runtime_worker_compatible: true,
    workspace_state: null,
    workspace_runtime_requirements_json: null,
    workspace_runtime_requirement_digest: null,
    workspace_runtime_launch_binding_json: null,
  };
  const client = new ClaimClient(row, legacyOwner);
  const claim = await claimSessionRuntimeDispatch(client, {
    workerId: "acp-worker:legacy",
    sessionId: snapshot().sessionId,
    generation: snapshot().generation,
    leaseId: snapshot().lease.leaseId,
    identity: snapshot().identity,
    fallbackRuntimeOwner: {
      requirements: runtimeRequirements,
      launchBinding: runtimeLaunchBinding,
    },
    leaseMs: 5 * 60_000,
    now: () => new Date("2026-08-04T18:00:00.000Z"),
    claimToken: () => claimToken,
  });
  assert.equal(claim.runtimeBinding, undefined);
  assert.equal(client.calls[4].values[13], true);
  assert.match(client.calls[4].text, /SET runtime_requirements_json/);
  assert.equal(client.calls[4].values[15], true);
  assert.equal(client.calls[5].text, "COMMIT");

  await assert.rejects(
    claimSessionRuntimeDispatch(new ClaimClient(row, {
      ...legacyOwner,
      claimant_legacy_runtime_worker_compatible: false,
      legacy_runtime_worker_compatible: false,
    }), {
      workerId: "acp-worker:new-unbound",
      sessionId: snapshot().sessionId,
      generation: snapshot().generation,
      leaseId: snapshot().lease.leaseId,
      identity: snapshot().identity,
      fallbackRuntimeOwner: {
        requirements: runtimeRequirements,
        launchBinding: runtimeLaunchBinding,
      },
      leaseMs: 5 * 60_000,
    }),
    /legacy-runtime-unbound/,
  );
});

test("rejects ambiguous workspace and session root ownership", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 1,
  }, {
    root_session_id: snapshot().sessionId,
    claimant_legacy_runtime_worker_compatible: false,
    session_runtime_requirements_json: runtimeRequirements,
    session_runtime_requirement_digest: runtimeRequirementDigest,
    session_runtime_launch_binding_json: runtimeLaunchBinding,
    legacy_runtime_worker_compatible: false,
    workspace_state: "ready",
    workspace_runtime_requirements_json: runtimeRequirements,
    workspace_runtime_requirement_digest: runtimeRequirementDigest,
    workspace_runtime_launch_binding_json: runtimeLaunchBinding,
  });
  await assert.rejects(
    claimSessionRuntimeDispatch(client, {
      workerId: "acp-worker:ambiguous",
      ...claimAuthority(),
      leaseMs: 5 * 60_000,
    }),
    /ambiguous durable owners/,
  );
});

test("does not inherit tuple-less migration compatibility into a new child", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 1,
  }, {
    root_session_id: "migration-active-root",
    claimant_legacy_runtime_worker_compatible: false,
    session_runtime_requirements_json: runtimeRequirements,
    session_runtime_requirement_digest: runtimeRequirementDigest,
    session_runtime_launch_binding_json: runtimeLaunchBinding,
    legacy_runtime_worker_compatible: true,
    workspace_state: null,
    workspace_runtime_requirements_json: null,
    workspace_runtime_requirement_digest: null,
    workspace_runtime_launch_binding_json: null,
  });
  await assert.rejects(claimSessionRuntimeDispatch(client, {
    workerId: "acp-worker:new-child",
    sessionId: snapshot().sessionId,
    generation: snapshot().generation,
    leaseId: snapshot().lease.leaseId,
    identity: snapshot().identity,
    leaseMs: 5 * 60_000,
  }), /runtime-release-mismatch/);
});

test("claims one pending or expired dispatch with a bounded renewable lease", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 2,
    is_admitted_initial_dispatch: false,
  });
  const claim = await claimSessionRuntimeDispatch(client, {
    workerId: "acp-worker:7",
    ...claimAuthority(),
    leaseMs: 5 * 60_000,
    now: () => new Date("2026-08-04T18:00:00.000Z"),
    claimToken: () => claimToken,
  });
  assert.equal(claim.dispatch.dispatchId, dispatchId);
  assert.equal(claim.claimToken, claimToken);
  assert.equal(claim.claimCount, 2);
  assert.equal(claim.isAdmittedInitialDispatch, false);
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /WITH RECURSIVE lineage/);
  assert.match(client.calls[2].text, /workspace_launches[\s\S]*FOR UPDATE/);
  assert.match(client.calls[3].text, /FOR UPDATE OF root/);
  assert.match(client.calls[4].text, /FOR UPDATE OF outbox SKIP LOCKED/);
  assert.match(client.calls[4].text, /status = 'pending'/);
  assert.match(client.calls[4].text, /claim_expires_at <= \$1/);
  assert.match(client.calls[4].text, /claim_count = outbox\.claim_count \+ 1/);
  assert.match(client.calls[4].text, /outbox\.session_id = \$5/);
  assert.match(client.calls[4].text, /session\.snapshot_json->'identity' = \$8::jsonb/);
  assert.match(client.calls[4].text, /LEFT JOIN codeops\.admitted_child_materializations/);
  assert.match(client.calls[4].text, /initial_dispatch\.status = 'completed'/);
  assert.match(client.calls[4].text, /outbox\.dispatch_digest = materialization\.initial_dispatch_digest/);
  assert.match(client.calls[4].text, /outbox\.dispatch_json = materialization\.input_json->'initialDispatch'/);
  assert.ok(client.calls[4].text.indexOf("CASE WHEN materialization.admission_id") <
    client.calls[4].text.indexOf("outbox.available_at ASC"));
  assert.deepEqual(client.calls[4].values.slice(0, 8), [
    "2026-08-04T18:00:00.000Z",
    claimToken,
    "acp-worker:7",
    "2026-08-04T18:05:00.000Z",
    "ses_91a4",
    3,
    leaseId,
    JSON.stringify(Object.fromEntries(Object.entries(snapshot().identity).sort())),
  ]);
  assert.equal(claim.runtimeBinding.selectedReleaseDigest, runtimeProfile.releaseDigest);
  assert.match(client.calls[5].text, /SET state = 'not_attempted'/);
  assert.match(client.calls[5].text, /attempted_at IS NULL/);
  assert.deepEqual(client.calls[5].values, [
    "2026-08-04T18:00:00.000Z", dispatchId, claimToken,
  ]);
  assert.match(client.calls[6].text, /FOR UPDATE OF manifest/);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("preserves millisecond precision when pg returns a Date for the claim expiry", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: new Date("2026-08-04T18:05:00.123Z"),
    claim_count: 1,
    is_admitted_initial_dispatch: false,
  });
  const claim = await claimSessionRuntimeDispatch(client, {
    workerId: "acp-worker:7",
    ...claimAuthority(),
    leaseMs: 5 * 60_000,
    now: () => new Date("2026-08-04T18:00:00.123Z"),
    claimToken: () => claimToken,
  });
  assert.equal(claim.claimExpiresAt, "2026-08-04T18:05:00.123Z");
});

test("renews only the exact live dispatch claim without changing its identity", async () => {
  const dispatch = await enqueue(new EnqueueClient());
  const client = new RenewClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:10:00.000Z",
    claim_count: 2,
    is_admitted_initial_dispatch: false,
  });
  const renewed = await renewSessionRuntimeDispatchClaim(client, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    leaseMs: 10 * 60_000,
    now: () => new Date("2026-08-04T18:00:00.000Z"),
  });
  assert.equal(renewed.dispatch.dispatchId, dispatchId);
  assert.equal(renewed.claimToken, claimToken);
  assert.equal(renewed.claimCount, 2);
  assert.equal(renewed.claimExpiresAt, "2026-08-04T18:10:00.000Z");
  assert.match(client.calls[0].text, /outbox\.claim_expires_at > \$5::timestamptz/);
  assert.match(client.calls[0].text, /snapshot_json->'lease'->>'status' = 'active'/);
  assert.match(client.calls[0].text, /snapshot_json->'identity' =/);
  assert.deepEqual(client.calls[0].values, [
    dispatchId,
    claimToken,
    "acp-worker:7",
    "2026-08-04T18:10:00.000Z",
    "2026-08-04T18:00:00.000Z",
  ]);
});

test("rejects renewal after exact dispatch authority expires", async () => {
  await assert.rejects(
    renewSessionRuntimeDispatchClaim(new RenewClient(null), {
      dispatchId,
      claimToken,
      workerId: "acp-worker:7",
      leaseMs: 5 * 60_000,
    }),
    ImmutableSessionRuntimeDispatchConflictError,
  );
});

test("rejects a claim rebound to another session after persistence", async () => {
  const dispatch = structuredClone(await enqueue(new EnqueueClient()));
  dispatch.command.sessionId = "ses_other";
  dispatch.snapshot.sessionId = "ses_other";
  const client = new ClaimClient({
    dispatch_json: dispatch,
    claim_token: claimToken,
    claim_expires_at: "2026-08-04T18:05:00.000Z",
    claim_count: 1,
    is_admitted_initial_dispatch: false,
  });
  await assert.rejects(
    claimSessionRuntimeDispatch(client, {
      workerId: "acp-worker:7",
      ...claimAuthority(),
      leaseMs: 5 * 60_000,
      now: () => new Date("2026-08-04T18:00:00.000Z"),
      claimToken: () => claimToken,
    }),
    /different session authority/,
  );
});

test("returns null when no dispatch is claimable and validates claim bounds", async () => {
  assert.equal(await claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "acp-worker:7",
    ...claimAuthority(),
    leaseMs: 1_000,
  }), null);
  await assert.rejects(claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "bad worker",
    ...claimAuthority(),
    leaseMs: 1_000,
  }), /audit identity/);
  await assert.rejects(claimSessionRuntimeDispatch(new ClaimClient(null), {
    workerId: "acp-worker:7",
    ...claimAuthority(),
    leaseMs: 999,
  }), /between 1 second and 15 minutes/);
});

function completion(overrides = {}) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    observedEventCursor: 184,
    type: "prompt",
    material: promptMaterial,
    completedAt: "2026-08-04T19:05:00.000Z",
    ...overrides,
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    );
  }
  return value;
}

class CompletionClient {
  constructor({ dispatch, reservedDispatch = dispatch, status = "claimed", token = claimToken, workerId = "acp-worker:7", expiresAt = "2026-08-04T19:20:00.000Z", current = snapshot(), completed = null, completionValue = null, completeCount = 1, permission = null } = {}) {
    this.dispatch = dispatch;
    this.reservedDispatch = reservedDispatch;
    this.status = status;
    this.token = token;
    this.workerId = workerId;
    this.expiresAt = expiresAt;
    this.current = current;
    this.completed = completed;
    this.completionValue = completionValue;
    this.completeCount = completeCount;
    this.permission = permission;
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.session_runtime_permission_requests AS request")) {
      return {
        rowCount: this.permission ? 1 : 0,
        rows: this.permission ? [{
          request_id: this.permission?.requestId ?? null,
          request_json: this.permission?.submission ?? null,
          command_json: this.permission?.command ?? null,
          result_json: this.permission?.result ?? null,
        }] : [],
      };
    }
    if (text.includes("WHERE dispatch_id = $1") && text.startsWith("SELECT")) {
      return {
        rowCount: this.dispatch ? 1 : 0,
        rows: this.dispatch ? [{
          dispatch_json: this.dispatch,
          status: this.status,
          completion_json: this.completionValue,
          result_json: this.completed,
          completed_by: this.workerId,
        }] : [],
      };
    }
    if (text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: this.current }] };
    }
    if (text.includes("FROM codeops.session_runtime_outbox")) {
      return {
        rowCount: 1,
        rows: [{
          dispatch_id: dispatchId,
          dispatch_json: this.reservedDispatch,
          status: this.status,
          claim_token: this.token,
          claimed_by: this.workerId,
          claim_expires_at: this.expiresAt,
        }],
      };
    }
    if (text.includes("FROM codeops.session_commands")) {
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith("UPDATE codeops.session_runtime_outbox")) {
      return { rowCount: this.completeCount, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

async function runtimeDispatch() {
  return enqueue(new EnqueueClient(), {
    now: () => new Date("2026-08-04T19:00:00.000Z"),
  });
}

test("atomically commits only an exact unexpired claim completion", async () => {
  const rawDispatch = await runtimeDispatch();
  const budget = projectSessionBudget({
    startedAt: "2026-08-04T17:30:00.000Z",
    observedAt: "2026-08-04T19:09:00.000Z",
  });
  const dispatch = {
    ...rawDispatch,
    snapshot: { ...rawDispatch.snapshot, budget },
  };
  const client = new CompletionClient({
    dispatch,
    reservedDispatch: reverseObjectKeys(dispatch),
    current: reverseObjectKeys(snapshot({ budget })),
  });
  const result = await completeSessionRuntimeDispatch(client, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    completion: completion(),
    now: () => new Date("2026-08-04T19:10:00.000Z"),
    commandId: () => "66666666-6666-4666-8666-666666666666",
  });
  assert.equal(result.disposition, "committed");
  assert.equal(result.eventCursor, 186);
  const transaction = client.calls.findIndex(({ text }) =>
    text === "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.ok(transaction > 1);
  assert.match(client.calls[transaction + 1].text, /codeops\.sessions[\s\S]*FOR UPDATE/);
  assert.match(client.calls[transaction + 1].text, /COALESCE\(\$3::timestamptz, CURRENT_TIMESTAMP\)/);
  assert.equal(client.calls[transaction + 1].values[2], budget.observedAt);
  assert.match(client.calls[transaction + 2].text, /session_runtime_outbox[\s\S]*FOR UPDATE/);
  const completed = client.calls.find(({ text }) =>
    text.startsWith("UPDATE codeops.session_runtime_outbox"));
  assert.match(completed.text, /status = 'completed'/);
  assert.match(completed.text, /claim_token = NULL/);
  assert.match(completed.text, /claimed_by = \$3/);
  assert.match(completed.text, /claim_expires_at > \$4/);
  assert.equal(completed.values[2], "acp-worker:7");
  assert.equal(completed.values[4], dispatchId);
  assert.equal(completed.values[5], claimToken);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("commits a prompt against the exact permission-mediated snapshot", async () => {
  const dispatch = await runtimeDispatch();
  const current = snapshot({
    eventCursor: 186,
    updatedAt: "2026-08-04T19:09:00.000Z",
  });
  const requestId = "permission-1";
  const permissionCommand = {
    version: "codeops.session-command/v1",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
    type: "respond_permission",
    permissionRequestId: requestId,
    decision: { outcome: "selected", optionId: "allow-once" },
  };
  const permissionResult = {
    version: "codeops.session-command-result/v1",
    commandId: "88888888-8888-4888-8888-888888888888",
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey: permissionCommand.idempotencyKey,
    type: "respond_permission",
    eventCursor: 186,
    snapshot: current,
    committedAt: "2026-08-04T19:09:00.000Z",
    disposition: "committed",
  };
  const client = new CompletionClient({
    dispatch,
    current,
    permission: {
      requestId,
      submission: {
        version: "codeops.session-runtime-permission-submission/v1",
        claimToken,
        request: {
          requestId,
          title: "Allow write?",
          description: "The agent wants to update one file.",
          operation: { kind: "command", command: "npm test", cwd: "/workspace" },
          operationDigest: `sha256:${"a".repeat(64)}`,
          options: [{ optionId: "allow-once", label: "Allow once" }],
          requestedAt: "2026-08-04T19:05:00.000Z",
        },
        acpSessionId: "acp-session-1",
        toolCallId: "tool-call-1",
        options: [{ optionId: "allow-once", acpOptionId: "opaque-allow-once" }],
      },
      command: permissionCommand,
      result: permissionResult,
    },
  });
  const result = await completeSessionRuntimeDispatch(client, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    completion: completion({ completedAt: "2026-08-04T19:10:00.000Z" }),
    now: () => new Date("2026-08-04T19:10:00.000Z"),
    commandId: () => "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(result.eventCursor, 188);
  assert.equal(result.snapshot.eventCursor, 188);
});

test("rolls back stale tokens, expired claims, and changed snapshots", async () => {
  const dispatch = await runtimeDispatch();
  for (const client of [
    new CompletionClient({ dispatch, token: "77777777-7777-4777-8777-777777777777" }),
    new CompletionClient({ dispatch, workerId: "acp-worker:8" }),
    new CompletionClient({ dispatch, expiresAt: "2026-08-04T19:09:59.000Z" }),
    new CompletionClient({ dispatch, current: snapshot({ eventCursor: 185 }) }),
  ]) {
    await assert.rejects(completeSessionRuntimeDispatch(client, {
      dispatchId,
      claimToken,
      workerId: "acp-worker:7",
      completion: completion(),
      now: () => new Date("2026-08-04T19:10:00.000Z"),
    }), /claim|snapshot/);
    assert.equal(
      client.calls.some(({ text }) => text.includes("INSERT INTO codeops.session_events")),
      false,
    );
    if (client.calls.some(({ text }) => text === "BEGIN ISOLATION LEVEL SERIALIZABLE")) {
      assert.equal(client.calls.at(-1).text, "ROLLBACK");
    }
  }
});

test("replays one exact persisted completion and rejects completion drift", async () => {
  const dispatch = await runtimeDispatch();
  const first = new CompletionClient({ dispatch });
  const committed = await completeSessionRuntimeDispatch(first, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    completion: completion(),
    now: () => new Date("2026-08-04T19:10:00.000Z"),
    commandId: () => "66666666-6666-4666-8666-666666666666",
  });
  const replay = new CompletionClient({
    dispatch,
    status: "completed",
    completed: committed,
    completionValue: completion(),
  });
  const result = await completeSessionRuntimeDispatch(replay, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    completion: completion(),
  });
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.originalCommandId, committed.commandId);
  assert.equal(replay.calls.length, 1);
  await assert.rejects(completeSessionRuntimeDispatch(replay, {
    dispatchId,
    claimToken,
    workerId: "acp-worker:7",
    completion: completion({ completedAt: "2026-08-04T19:06:00.000Z" }),
  }), ImmutableSessionRuntimeDispatchConflictError);
});
