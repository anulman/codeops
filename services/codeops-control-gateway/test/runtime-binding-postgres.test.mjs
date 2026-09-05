import { listInteractiveRuntimeCandidates, recordInteractiveRuntimeJobProgress, reconcileInteractiveRuntimeTerminal } from "../dist/session-runtime-terminal-reconciler.js";
import { reconcileWorkspaceLaunch } from "../dist/workspace-launch-controller.js";
import { requireDisposablePostgres } from "../../../infra/scripts/disposable-postgres.mjs";
import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import {
  canonicalJsonText,
  projectSessionBudgetV2,
  sha256CanonicalJsonDigest,
  workspaceLaunchSchema,
} from "@codeops/codeops-contracts";
import { workspaceLaunchSessionId } from "@codeops/codeops-contracts/workspace-launch";
import {
  applySessionBrokerMigration,
  migrateSessionBroker,
} from "../dist/session-broker-migration.js";
import { buildSessionRuntimeDispatch } from "../dist/session-broker-runtime.js";
import { claimSessionRuntimeDispatch } from "../dist/session-broker-runtime-outbox.js";
import { initializeSessionFromJob } from "../dist/session-job-initialization.js";
import { bindWorkspaceLaunchRuntime } from "../dist/workspace-launch.js";
import { listActiveWorkspaceLaunchIds, updateWorkspaceLaunch } from "../dist/workspace-launch-store.js";

const databaseUrl = process.env.CODEOPS_TEST_POSTGRES_URL?.trim();
if (databaseUrl !== undefined) await requireDisposablePostgres(databaseUrl);
const skip = databaseUrl === undefined
  ? "CODEOPS_TEST_POSTGRES_URL is not configured"
  : false;
let suiteLock;
before(async () => {
  if (skip !== false) return;
  suiteLock = new Client({connectionString: databaseUrl});
  await suiteLock.connect();
  await suiteLock.query("SELECT pg_advisory_lock(hashtext('codeops-control-gateway-postgres-tests'))");
});
after(async () => { if (suiteLock) await suiteLock.end(); });
const launchId = "launch-0123456789abcdef01234567";
const leaseId = "11111111-1111-4111-8111-111111111111";
const requirements = {
  version: "codeops.runtime-requirements/v1", capabilities: ["acp"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1280, ephemeralStorageMiB: 1280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "policy-7",
};
const requirementDigest = sha256CanonicalJsonDigest(requirements);
const profile = {
  version: "codeops.runtime-profile/v1", profileId: "standard-v1",
  releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"],
  capabilityDigest: sha256CanonicalJsonDigest(["acp"]),
  resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
  authority: requirements.maximumAuthority, compatibilityPolicyRevision: "policy-7",
  images: {
    agent: `example/agent@sha256:${"8".repeat(64)}`,
    worker: `example/worker@sha256:${"9".repeat(64)}`,
    sessionGateway: `example/gateway@sha256:${"a".repeat(64)}`,
  },
};
const launchBinding = {
  version: "codeops.runtime-launch-binding/v1", requirementDigest,
  profile, selectedAt: "2026-08-31T08:00:00.000Z",
};
const preUpgradeLaunch = {
  version: "codeops.workspace-launch/v1",
  launchId: "launch-fedcba987654321001234567",
  idempotencyKey: "26262626-2626-4262-8262-262626262626",
  principalId: "access:user@example.com",
  requestDigest: `sha256:${"2".repeat(64)}`,
  policy: {
    version: "codeops.session-policy/v1", mode: "implement",
    workspaceAccess: "bounded-writes", modelCalls: "allowed",
    modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
  },
  contextAttachments: [],
  promptDigest: `sha256:${"3".repeat(64)}`,
  workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
  state: "queued",
  createdAt: "2026-08-31T08:00:00.000Z",
  updatedAt: "2026-08-31T08:00:00.000Z",
  deadlineAt: "2026-08-31T14:00:00.000Z",
  attemptCount: 0,
};

function snapshot(sessionId, runId, parentSessionId = null) {
  const enabled = new Set(["prompt", "cancel", "checkpoint", "hibernate"]);
  return {
    version: "codeops.session-snapshot/v1", sessionId, generation: 1,
    state: "running",
    identity: {
      repository: "example-org/example-repository", branch: "main",
      baseSha: "a".repeat(40), workflowId: parentSessionId === null ? "root" : "child",
      runId, parentSessionId, forkedAtCursor: parentSessionId === null ? null : 1,
    },
    lease: {
      leaseId, generation: 1, status: "active", holderId: `worker:${sessionId}`,
      acquiredAt: "2026-08-31T08:00:00.000Z", expiresAt: "2026-08-31T10:00:00.000Z",
    },
    checkpoint: null, pendingPermission: null, eventCursor: 1,
    capabilities: ["prompt", "respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
      .map((action) => enabled.has(action)
        ? { action, availability: "enabled" }
        : { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-08-31T08:00:00.000Z",
  };
}

async function insertDispatch(connection, current, dispatchId, idempotencyKey, ownBinding = false) {
  const command = {
    version: "codeops.session-command/v1", sessionId: current.sessionId,
    generation: 1, leaseId, idempotencyKey, type: "prompt",
    prompt: "Execute the exact admitted work.",
  };
  const dispatch = buildSessionRuntimeDispatch({
    dispatchId, principalId: "access:user@example.com", command,
    snapshot: current, dispatchedAt: "2026-08-31T08:01:00.000Z",
  });
  await connection.query(
    `INSERT INTO codeops.sessions
       (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id,
        runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
     VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com',
       $5::jsonb,$6,$7::jsonb)`,
    [current.sessionId, leaseId, canonicalJsonText(current), current.updatedAt,
      ownBinding ? canonicalJsonText(requirements) : null,
      ownBinding ? requirementDigest : null,
      ownBinding ? canonicalJsonText(launchBinding) : null],
  );
  await connection.query(
    `INSERT INTO codeops.session_runtime_outbox
       (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,available_at,created_at)
     VALUES($1,$2,$3,'access:user@example.com',$4::jsonb,'pending',$5::timestamptz,$5::timestamptz)`,
    [dispatchId, current.sessionId, idempotencyKey, canonicalJsonText(dispatch), dispatch.dispatchedAt],
  );
  return current;
}

async function observeBlockingWriters(observer, blockedProcessId) {
  // UNION deduplicates the graph, including any deadlock cycle. A waiter can
  // block behind a tuple-lock waiter rather than directly behind its owner.
  const observed = await observer.query(
    `WITH RECURSIVE blockers(pid) AS (
       SELECT unnest(pg_blocking_pids($1::integer))
       UNION
       SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
     )
     SELECT pg_blocking_pids($1::integer) AS direct,
            ARRAY(SELECT pid FROM blockers ORDER BY pid) AS ancestors`,
    [blockedProcessId],
  );
  return observed.rows[0];
}

async function waitForBlockingWriter(writer, blockedProcessId) {
  let observed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    observed = await observeBlockingWriters(writer, blockedProcessId);
    if (observed.ancestors.includes(writer.processID)) return observed;
    await delay(10);
  }
  assert.fail(`backend ${blockedProcessId} did not wait for writer ${writer.processID}: ${JSON.stringify(observed)}`);
}

test("blocking observer requires the exact writer through direct and transitive waits", { skip }, async () => {
  const holder = new Client({ connectionString: databaseUrl });
  const middle = new Client({ connectionString: databaseUrl });
  const leaf = new Client({ connectionString: databaseUrl });
  await Promise.all([holder.connect(), middle.connect(), leaf.connect()]);
  let middleWait;
  let leafWait;
  try {
    for (const client of [holder, middle, leaf]) {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
    }
    await holder.query("SELECT pg_advisory_xact_lock(731901, 1)");
    await middle.query("SELECT pg_advisory_xact_lock(731901, 2)");
    middleWait = settled(middle.query("SELECT pg_advisory_xact_lock(731901, 1)"));
    const direct = await waitForBlockingWriter(holder, middle.processID);
    assert.deepEqual(direct.direct, [holder.processID]);
    leafWait = settled(leaf.query("SELECT pg_advisory_xact_lock(731901, 2)"));
    const transitive = await waitForBlockingWriter(holder, leaf.processID);
    assert.deepEqual(transitive.direct, [middle.processID]);
    assert.equal(transitive.direct.includes(holder.processID), false);
    assert.deepEqual(transitive.ancestors, [holder.processID, middle.processID].sort((a, b) => a - b));
    assert.equal(transitive.ancestors.includes(suiteLock.processID), false);
    await holder.query("COMMIT");
    assert.equal((await middleWait).error, null);
    await middle.query("COMMIT");
    assert.equal((await leafWait).error, null);
    await leaf.query("COMMIT");
    assert.deepEqual(await observeBlockingWriters(holder, leaf.processID), { direct: [], ancestors: [] });
    console.log(JSON.stringify({event: "blocking_graph_proof", direct: true, transitive: true, unrelatedWriterRejected: true, releasedWaitRejected: true}));
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    if (middleWait) await middleWait;
    await middle.query("ROLLBACK").catch(() => undefined);
    if (leafWait) await leafWait;
    await leaf.query("ROLLBACK").catch(() => undefined);
    await Promise.all([holder.end(), middle.end(), leaf.end()]);
  }
});

function pauseAfterQuery(connection, pattern) {
  let reached;
  let release;
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  return {
    reached: reachedPromise,
    release,
    client: {
      async query(...args) {
        const result = await connection.query(...args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (pattern.test(text ?? "")) {
          reached();
          await releasePromise;
        }
        return result;
      },
    },
  };
}

function settled(operation) {
  return operation.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
}

async function runtimeRevertText() {
  return readFile(
    new URL("../sql/runtime-compatible-substitution-v1-revert.sql", import.meta.url),
    "utf8",
  );
}

async function seedMigrationRetainedWorkspace(connection, launchId, idempotencyKey) {
  await connection.query(await runtimeRevertText());
  const retainedLaunch = {
    ...preUpgradeLaunch,
    launchId,
    idempotencyKey,
    state: "provisioning",
  };
  const sessionId = workspaceLaunchSessionId(launchId);
  const retainedSnapshot = {
    ...snapshot(sessionId, launchId),
    budget: projectSessionBudgetV2({
      budgetId: sessionId,
      revision: 1,
      startedAt: "2026-08-31T08:00:00.000Z",
      observedAt: "2026-08-31T08:00:00.000Z",
    }),
  };
  await connection.query(
    `INSERT INTO codeops.workspace_launches
       (launch_id,principal_id,idempotency_key,request_digest,request_json,
        launch_json,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'provisioning',
       $7::timestamptz,$7::timestamptz)`,
    [retainedLaunch.launchId, retainedLaunch.principalId,
      retainedLaunch.idempotencyKey, retainedLaunch.requestDigest,
      canonicalJsonText({ idempotencyKey: retainedLaunch.idempotencyKey }),
      canonicalJsonText(retainedLaunch), retainedLaunch.createdAt],
  );
  await connection.query(
    `INSERT INTO codeops.sessions
       (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
     VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com')`,
    [sessionId, leaseId, canonicalJsonText(retainedSnapshot),
      retainedSnapshot.updatedAt],
  );
  const runtimeMigration = await readFile(
    new URL("../sql/runtime-compatible-substitution-v1.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    await applySessionBrokerMigration(
      connection,
      runtimeMigration,
      "runtime-compatible-substitution-v1",
    ),
    "applied",
  );
  const stored = await connection.query(
    `SELECT launch_json FROM codeops.workspace_launches WHERE launch_id=$1`,
    [launchId],
  );
  return {
    launch: workspaceLaunchSchema.parse(stored.rows[0].launch_json),
    snapshot: retainedSnapshot,
  };
}

function initializationRequest(current) {
  return {
    version: "codeops.session-job-initialization/v3",
    sessionId: current.sessionId,
    identity: current.identity,
    leaseId,
    holderId: `job:${current.sessionId}`,
    ownerPrincipalId: "access:user@example.com",
    runtimeProfileId: profile.profileId,
    runtimeReleaseDigest: profile.releaseDigest,
    runtimeCapabilityDigest: profile.capabilityDigest,
    runtimeProfile: profile,
  };
}

async function insertPendingDispatch(connection, current, dispatchId, idempotencyKey) {
  const command = {
    version: "codeops.session-command/v1", sessionId: current.sessionId,
    generation: 1, leaseId, idempotencyKey, type: "prompt",
    prompt: "Continue the migration-retained workspace.",
  };
  const dispatch = buildSessionRuntimeDispatch({
    dispatchId, principalId: "access:user@example.com", command,
    snapshot: current, dispatchedAt: "2026-08-31T08:01:00.000Z",
  });
  await connection.query(
    `INSERT INTO codeops.session_runtime_outbox
       (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
        available_at,created_at)
     VALUES($1,$2,$3,'access:user@example.com',$4::jsonb,'pending',
       $5::timestamptz,$5::timestamptz)`,
    [dispatchId, current.sessionId, idempotencyKey,
      canonicalJsonText(dispatch), dispatch.dispatchedAt],
  );
}

function runtimeClaimInput(current, workerId, claimToken) {
  return {
    workerId, sessionId: current.sessionId, generation: 1, leaseId,
    identity: current.identity, runtimeProfileId: profile.profileId,
    runtimeReleaseDigest: profile.releaseDigest,
    runtimeCapabilityDigest: profile.capabilityDigest,
    runtimeProfile: profile, leaseMs: 60_000, claimToken: () => claimToken,
    fallbackRuntimeOwner: { requirements, launchBinding },
    now: () => new Date("2026-08-31T08:02:00.000Z"),
  };
}

async function assertWorkspaceOnlyOwner(connection, launchId, sessionId) {
  const owners = await connection.query(
    `SELECT launch.runtime_launch_binding_json AS workspace_binding,
            session.runtime_launch_binding_json AS session_binding
       FROM codeops.workspace_launches launch
       JOIN codeops.sessions session ON session.session_id=$2
      WHERE launch.launch_id=$1`,
    [launchId, sessionId],
  );
  assert.deepEqual(owners.rows[0].workspace_binding, launchBinding);
  assert.equal(owners.rows[0].session_binding, null);
}

test("runtime claim and rollback complete without a lock-order deadlock", { skip }, async () => {
  const rollback = new Client({ connectionString: databaseUrl });
  const claimant = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_claim_lock_order_${process.pid}`;
  await Promise.all([rollback.connect(), claimant.connect()]);
  try {
    await rollback.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(rollback);
    const current = await insertDispatch(
      rollback,
      snapshot("lock-order-claim-root", "lock-order-claim-run"),
      "31313131-3131-4131-8131-313131313131",
      "32323232-3232-4232-8232-323232323232",
      true,
    );
    await rollback.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await rollback.query(`GRANT ${normalRole} TO CURRENT_USER`);
    await rollback.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await rollback.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA codeops TO ${normalRole}`);
    await claimant.query(`SET ROLE ${normalRole}`);
    const barrier = pauseAfterQuery(claimant, /FOR UPDATE OF root/);
    const claimOutcome = settled(claimSessionRuntimeDispatch(barrier.client, {
      workerId: "worker:lock-order-claim", sessionId: current.sessionId,
      generation: 1, leaseId, identity: current.identity,
      runtimeProfileId: profile.profileId,
      runtimeReleaseDigest: profile.releaseDigest,
      runtimeCapabilityDigest: profile.capabilityDigest,
      runtimeProfile: profile, leaseMs: 60_000,
      now: () => new Date("2026-08-31T08:02:00.000Z"),
    }));
    await barrier.reached;
    const revertOutcome = settled(rollback.query(await runtimeRevertText()));
    await waitForBlockingWriter(claimant, rollback.processID);
    barrier.release();
    const [claim, revert] = await Promise.all([claimOutcome, revertOutcome]);
    assert.equal(claim.error, null);
    assert.equal(claim.value?.dispatch.command.sessionId, current.sessionId);
    assert.notEqual(revert.error?.code, "40P01");
    assert.match(
      String(revert.error?.message),
      /cannot revert runtime compatible substitution while runtime-binding evidence exists/,
    );
  } finally {
    await claimant.query("ROLLBACK").catch(() => undefined);
    await claimant.query("RESET ROLE").catch(() => undefined);
    await rollback.query("ROLLBACK").catch(() => undefined);
    await rollback.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
    await rollback.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    await Promise.all([
      claimant.end().catch(() => undefined),
      rollback.end().catch(() => undefined),
    ]);
  }
});

test("session initialization and rollback complete without a lock-order deadlock", { skip }, async () => {
  const rollback = new Client({ connectionString: databaseUrl });
  const initializer = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_initialization_lock_order_${process.pid}`;
  await Promise.all([rollback.connect(), initializer.connect()]);
  try {
    await rollback.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(rollback);
    const initializationLaunchId = "launch-lock-order-initialization";
    const launchJson = {
      launchId: initializationLaunchId,
      principalId: "access:user@example.com",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      requestDigest: `sha256:${"4".repeat(64)}`,
      state: "provisioning",
      runtimeRequirements: requirements,
      runtimeRequirementDigest: requirementDigest,
      runtimeLaunchBinding: launchBinding,
    };
    await rollback.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,
          launch_json,state,created_at,updated_at,runtime_requirements_json,
          runtime_requirement_digest,runtime_launch_binding_json)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'provisioning',$7::timestamptz,
         $7::timestamptz,$8::jsonb,$9,$10::jsonb)`,
      [initializationLaunchId, launchJson.principalId, launchJson.idempotencyKey,
        launchJson.requestDigest,
        canonicalJsonText({ idempotencyKey: launchJson.idempotencyKey }),
        canonicalJsonText(launchJson), "2026-08-31T08:00:00.000Z",
        canonicalJsonText(requirements), requirementDigest,
        canonicalJsonText(launchBinding)],
    );
    await rollback.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await rollback.query(`GRANT ${normalRole} TO CURRENT_USER`);
    await rollback.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await rollback.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA codeops TO ${normalRole}`);
    await initializer.query(`SET ROLE ${normalRole}`);
    const request = {
      version: "codeops.session-job-initialization/v3",
      sessionId: "lock-order-initialized-session",
      identity: snapshot("unused", initializationLaunchId).identity,
      leaseId,
      holderId: "job:lock-order-initialization",
      ownerPrincipalId: "access:user@example.com",
      runtimeProfileId: profile.profileId,
      runtimeReleaseDigest: profile.releaseDigest,
      runtimeCapabilityDigest: profile.capabilityDigest,
      runtimeProfile: profile,
    };
    const barrier = pauseAfterQuery(
      initializer,
      /FROM codeops\.workspace_launches[\s\S]*FOR UPDATE/,
    );
    const initializationOutcome = settled(initializeSessionFromJob(barrier.client, {
      request,
      now: () => new Date("2026-08-31T08:02:00.000Z"),
    }));
    await barrier.reached;
    const revertOutcome = settled(rollback.query(await runtimeRevertText()));
    await waitForBlockingWriter(initializer, rollback.processID);
    barrier.release();
    const [initialization, revert] = await Promise.all([
      initializationOutcome,
      revertOutcome,
    ]);
    assert.equal(initialization.error, null);
    assert.equal(initialization.value?.disposition, "created");
    assert.notEqual(revert.error?.code, "40P01");
    assert.match(
      String(revert.error?.message),
      /cannot revert runtime compatible substitution while runtime-binding evidence exists/,
    );
  } finally {
    await initializer.query("ROLLBACK").catch(() => undefined);
    await initializer.query("RESET ROLE").catch(() => undefined);
    await rollback.query("ROLLBACK").catch(() => undefined);
    await rollback.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
    await rollback.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    await Promise.all([
      initializer.end().catch(() => undefined),
      rollback.end().catch(() => undefined),
    ]);
  }
});

test("normal-role workspace binding wins atomically before initialization and claim", { skip }, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  const binder = new Client({ connectionString: databaseUrl });
  const initializer = new Client({ connectionString: databaseUrl });
  const claimant = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_workspace_owner_first_${process.pid}`;
  await Promise.all([admin.connect(), binder.connect(), initializer.connect(), claimant.connect()]);
  try {
    await admin.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(admin);
    const retained = await seedMigrationRetainedWorkspace(
      admin,
      "launch-111111111111111111111111",
      "41414141-4141-4141-8141-414141414141",
    );
    await insertPendingDispatch(
      admin,
      retained.snapshot,
      "42424242-4242-4242-8242-424242424242",
      "43434343-4343-4343-8343-434343434343",
    );
    await admin.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await admin.query(`GRANT ${normalRole} TO CURRENT_USER`);
    await admin.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA codeops TO ${normalRole}`);
    await Promise.all([
      binder.query(`SET ROLE ${normalRole}`),
      initializer.query(`SET ROLE ${normalRole}`),
      claimant.query(`SET ROLE ${normalRole}`),
    ]);
    const boundLaunch = bindWorkspaceLaunchRuntime(
      retained.launch,
      launchBinding,
      () => new Date("2026-08-31T08:02:00.000Z"),
      requirements,
    );
    const bindingBarrier = pauseAfterQuery(
      binder,
      /SELECT runtime_launch_binding_json[\s\S]*FROM codeops\.workspace_launches/,
    );
    const bindingOutcome = settled(updateWorkspaceLaunch(bindingBarrier.client, boundLaunch));
    await bindingBarrier.reached;
    const initializationOutcome = settled(initializeSessionFromJob(initializer, {
      request: initializationRequest(retained.snapshot),
      runtimeOwner: { requirements, launchBinding },
      now: () => new Date("2026-08-31T08:02:00.000Z"),
    }));
    const claimOutcome = settled(claimSessionRuntimeDispatch(claimant, runtimeClaimInput(
      retained.snapshot,
      "worker:workspace-owner-first",
      "44444444-4444-4444-8444-444444444444",
    )));
    const blocking = await waitForBlockingWriter(binder, initializer.processID);
    console.log(JSON.stringify({event: "workspace_writer_wait", direct: blocking.direct.includes(binder.processID), transitive: blocking.ancestors.includes(binder.processID)}));
    bindingBarrier.release();
    const [binding, initialization, claim] = await Promise.all([
      bindingOutcome,
      initializationOutcome,
      claimOutcome,
    ]);
    assert.equal(binding.error, null);
    if (initialization.error !== null) assert.equal(initialization.error.code, "40001");
    if (claim.error !== null) assert.equal(claim.error.code, "40001");
    const replayedInitialization = initialization.value ??
      await initializeSessionFromJob(initializer, {
        request: initializationRequest(retained.snapshot),
        runtimeOwner: { requirements, launchBinding },
        now: () => new Date("2026-08-31T08:03:00.000Z"),
      });
    const replayedClaim = claim.value ?? await claimSessionRuntimeDispatch(
      claimant,
      runtimeClaimInput(
        retained.snapshot,
        "worker:workspace-owner-first-replay",
        "44444444-4444-4444-8444-444444444444",
      ),
    );
    assert.equal(replayedInitialization.disposition, "duplicate");
    assert.equal(replayedClaim.runtimeBinding.selectedReleaseDigest, profile.releaseDigest);
    await assertWorkspaceOnlyOwner(admin, retained.launch.launchId, retained.snapshot.sessionId);
  } finally {
    await Promise.all([binder, initializer, claimant].map(async (connection) => {
      await connection.query("ROLLBACK").catch(() => undefined);
      await connection.query("RESET ROLE").catch(() => undefined);
      await connection.end().catch(() => undefined);
    }));
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test("normal-role fallback rejects an active workspace then replays from its owner", { skip }, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  const binder = new Client({ connectionString: databaseUrl });
  const initializer = new Client({ connectionString: databaseUrl });
  const claimant = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_workspace_owner_replay_${process.pid}`;
  await Promise.all([admin.connect(), binder.connect(), initializer.connect(), claimant.connect()]);
  try {
    await admin.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(admin);
    const retained = await seedMigrationRetainedWorkspace(
      admin,
      "launch-222222222222222222222222",
      "45454545-4545-4545-8545-454545454545",
    );
    await insertPendingDispatch(
      admin,
      retained.snapshot,
      "46464646-4646-4646-8646-464646464646",
      "47474747-4747-4747-8747-474747474747",
    );
    await admin.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await admin.query(`GRANT ${normalRole} TO CURRENT_USER`);
    await admin.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA codeops TO ${normalRole}`);
    await Promise.all([
      binder.query(`SET ROLE ${normalRole}`),
      initializer.query(`SET ROLE ${normalRole}`),
      claimant.query(`SET ROLE ${normalRole}`),
    ]);
    await assert.rejects(
      initializeSessionFromJob(initializer, {
        request: initializationRequest(retained.snapshot),
        runtimeOwner: { requirements, launchBinding },
        now: () => new Date("2026-08-31T08:02:00.000Z"),
      }),
      /session Job has no durable runtime owner/,
    );
    const claimBarrier = pauseAfterQuery(
      claimant,
      /SELECT launch_id[\s\S]*FROM codeops\.workspace_launches/,
    );
    const firstClaimOutcome = settled(claimSessionRuntimeDispatch(
      claimBarrier.client,
      runtimeClaimInput(
        retained.snapshot,
        "worker:workspace-owner-replay-first",
        "48484848-4848-4848-8848-484848484848",
      ),
    ));
    await claimBarrier.reached;
    const boundLaunch = bindWorkspaceLaunchRuntime(
      retained.launch,
      launchBinding,
      () => new Date("2026-08-31T08:03:00.000Z"),
      requirements,
    );
    const bindingOutcome = settled(updateWorkspaceLaunch(binder, boundLaunch));
    await waitForBlockingWriter(claimant, binder.processID);
    claimBarrier.release();
    const [firstClaim, binding] = await Promise.all([
      firstClaimOutcome,
      bindingOutcome,
    ]);
    assert.match(String(firstClaim.error?.message), /legacy-runtime-unbound/);
    assert.equal(binding.error, null);
    const replayedInitialization = await initializeSessionFromJob(initializer, {
      request: initializationRequest(retained.snapshot),
      runtimeOwner: { requirements, launchBinding },
      now: () => new Date("2026-08-31T08:04:00.000Z"),
    });
    assert.equal(replayedInitialization.disposition, "duplicate");
    const replayedClaim = await claimSessionRuntimeDispatch(claimant, runtimeClaimInput(
      retained.snapshot,
      "worker:workspace-owner-replay-second",
      "49494949-4949-4949-8949-494949494949",
    ));
    assert.equal(replayedClaim.runtimeBinding.selectedReleaseDigest, profile.releaseDigest);
    await assertWorkspaceOnlyOwner(admin, retained.launch.launchId, retained.snapshot.sessionId);
  } finally {
    await Promise.all([binder, initializer, claimant].map(async (connection) => {
      await connection.query("ROLLBACK").catch(() => undefined);
      await connection.query("RESET ROLE").catch(() => undefined);
      await connection.end().catch(() => undefined);
    }));
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test("normal-role binding commits are rechecked under both rollback locks", { skip }, async () => {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!/^codeops[_-].*test$/i.test(databaseName)) {
    throw new Error("CODEOPS_TEST_POSTGRES_URL must name a dedicated codeops *test database");
  }
  const rollback = new Client({ connectionString: databaseUrl });
  const writer = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_rollback_race_${process.pid}`;
  await Promise.all([rollback.connect(), writer.connect()]);
  try {
    const runtimeRevert = await readFile(
      new URL("../sql/runtime-compatible-substitution-v1-revert.sql", import.meta.url),
      "utf8",
    );
    const workspaceRevert = await readFile(
      new URL("../sql/workspace-launch-revert.sql", import.meta.url),
      "utf8",
    );

    await rollback.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(rollback);
    const raceLaunch = {
      ...preUpgradeLaunch,
      launchId: "launch-runtime-revert-race-01",
      idempotencyKey: "41414141-4141-4141-8141-414141414141",
      runtimeRequirements: requirements,
      runtimeRequirementDigest: requirementDigest,
    };
    await rollback.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,
          launch_json,state,created_at,updated_at,runtime_requirements_json,
          runtime_requirement_digest)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,
         $7::timestamptz,$8::jsonb,$9)`,
      [raceLaunch.launchId, raceLaunch.principalId, raceLaunch.idempotencyKey,
        raceLaunch.requestDigest,
        canonicalJsonText({ idempotencyKey: raceLaunch.idempotencyKey }),
        canonicalJsonText(raceLaunch), raceLaunch.createdAt,
        canonicalJsonText(requirements), requirementDigest],
    );
    await rollback.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await rollback.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await rollback.query(`GRANT SELECT ON codeops.sessions, codeops.session_runtime_outbox, codeops.workspace_launches TO ${normalRole}`);
    await rollback.query(`GRANT UPDATE ON codeops.workspace_launches TO ${normalRole}`);
    await writer.query(`SET ROLE ${normalRole}`);
    await writer.query("BEGIN");
    await writer.query(
      `UPDATE codeops.workspace_launches
          SET state='provisioning',
              launch_json=$2::jsonb,
              runtime_launch_binding_json=$3::jsonb
        WHERE launch_id=$1`,
      [raceLaunch.launchId, canonicalJsonText({
        ...raceLaunch,
        state: "provisioning",
        runtimeLaunchBinding: launchBinding,
      }), canonicalJsonText(launchBinding)],
    );
    const runtimeRollback = rollback.query(runtimeRevert).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await waitForBlockingWriter(writer, rollback.processID);
    await writer.query("COMMIT");
    const runtimeOutcome = await runtimeRollback;
    assert.match(
      String(runtimeOutcome.error?.message),
      /cannot revert runtime compatible substitution while runtime-binding evidence exists/,
    );
    await rollback.query("ROLLBACK");
    const retainedRuntimeBinding = await rollback.query(
      `SELECT runtime_launch_binding_json FROM codeops.workspace_launches WHERE launch_id=$1`,
      [raceLaunch.launchId],
    );
    assert.deepEqual(
      retainedRuntimeBinding.rows[0].runtime_launch_binding_json,
      launchBinding,
    );

    await writer.query("RESET ROLE");
    await rollback.query("DROP SCHEMA codeops CASCADE");
    await rollback.query("CREATE SCHEMA codeops");
    await rollback.query("CREATE TABLE codeops.workspace_launches (launch_id text PRIMARY KEY, launch_json jsonb NOT NULL)");
    await rollback.query(
      `INSERT INTO codeops.workspace_launches VALUES ('launch-workspace-revert-race', '{}'::jsonb)`,
    );
    await rollback.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await rollback.query(`GRANT SELECT, UPDATE ON codeops.workspace_launches TO ${normalRole}`);
    await writer.query(`SET ROLE ${normalRole}`);
    await writer.query("BEGIN");
    await writer.query(
      `UPDATE codeops.workspace_launches
          SET launch_json=jsonb_set(launch_json,'{runtimeLaunchBinding}',$2::jsonb)
        WHERE launch_id=$1`,
      ["launch-workspace-revert-race", canonicalJsonText(launchBinding)],
    );
    const workspaceRollback = rollback.query(workspaceRevert).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await waitForBlockingWriter(writer, rollback.processID);
    await writer.query("COMMIT");
    const workspaceOutcome = await workspaceRollback;
    assert.match(
      String(workspaceOutcome.error?.message),
      /cannot revert workspace launch while runtime-binding evidence exists/,
    );
    await rollback.query("ROLLBACK");
    const retainedWorkspaceBinding = await rollback.query(
      `SELECT launch_json->'runtimeLaunchBinding' AS binding
         FROM codeops.workspace_launches WHERE launch_id=$1`,
      ["launch-workspace-revert-race"],
    );
    assert.deepEqual(retainedWorkspaceBinding.rows[0].binding, launchBinding);
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    await writer.query("RESET ROLE").catch(() => undefined);
    await rollback.query("ROLLBACK").catch(() => undefined);
    await writer.end().catch(() => undefined);
    const retainedRole = await rollback.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [normalRole],
    ).catch(() => ({ rows: [] }));
    if (retainedRole.rows.length === 1) {
      await rollback.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
      await rollback.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    }
    await rollback.end();
  }
});

test("normal-role PostgreSQL binds every root and lineage producer and rejects runtime evidence mutation", { skip }, async () => {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!/^codeops[_-].*test$/i.test(databaseName)) {
    throw new Error("CODEOPS_TEST_POSTGRES_URL must name a dedicated codeops *test database");
  }
  const connection = new Client({ connectionString: databaseUrl });
  const normalRole = `codeops_runtime_binding_test_${process.pid}`;
  await connection.connect();
  try {
    await connection.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(connection);
    const runtimeRevert = await readFile(
      new URL("../sql/runtime-compatible-substitution-v1-revert.sql", import.meta.url),
      "utf8",
    );
    await connection.query(runtimeRevert);
    const older = snapshot("older-running-root", "older-run");
    const olderCommand = {
      version: "codeops.session-command/v1", sessionId: older.sessionId,
      generation: 1, leaseId, idempotencyKey: "17171717-1717-4171-8171-171717171717",
      type: "prompt", prompt: "Continue after the compatible upgrade.",
    };
    const olderDispatch = buildSessionRuntimeDispatch({
      dispatchId: "18181818-1818-4181-8181-181818181818",
      principalId: "access:user@example.com", command: olderCommand,
      snapshot: older, dispatchedAt: "2026-08-31T08:01:00.000Z",
    });
    await connection.query(
      `INSERT INTO codeops.sessions
         (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
       VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com')`,
      [older.sessionId, leaseId, canonicalJsonText(older), older.updatedAt],
    );
    const idleLegacy = snapshot("older-idle-root", "older-idle-run");
    await connection.query(
      `INSERT INTO codeops.sessions
         (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
       VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com')`,
      [idleLegacy.sessionId, leaseId, canonicalJsonText(idleLegacy), idleLegacy.updatedAt],
    );
    const activePreclaimedLegacy = snapshot("older-preclaimed-root", "older-preclaimed-run");
    const preclaimedLegacy = {
      ...activePreclaimedLegacy,
      state: "cancelled",
      lease: {
        leaseId, generation: 1, status: "released",
        releasedAt: "2026-08-31T08:00:30.000Z",
      },
      updatedAt: "2026-08-31T08:00:30.000Z",
    };
    const preclaimedCommand = {
      version: "codeops.session-command/v1", sessionId: preclaimedLegacy.sessionId,
      generation: 1, leaseId,
      idempotencyKey: "41414141-4141-4141-8141-414141414141",
      type: "prompt", prompt: "Continue the already claimed legacy dispatch.",
    };
    const preclaimedDispatch = buildSessionRuntimeDispatch({
      dispatchId: "42424242-4242-4242-8242-424242424242",
      principalId: "access:user@example.com", command: preclaimedCommand,
      snapshot: activePreclaimedLegacy, dispatchedAt: "2026-08-31T08:01:00.000Z",
    });
    await connection.query(
      `INSERT INTO codeops.sessions
         (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
       VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com')`,
      [preclaimedLegacy.sessionId, leaseId, canonicalJsonText(preclaimedLegacy),
        preclaimedLegacy.updatedAt],
    );
    await connection.query(
      `INSERT INTO codeops.session_runtime_outbox
         (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
          available_at,created_at,claim_token,claimed_by,claimed_at,
          claim_expires_at,claim_count)
       VALUES($1,$2,$3,'access:user@example.com',$4::jsonb,'claimed',
         $5::timestamptz,$5::timestamptz,$6,'old-gateway-v1',$5::timestamptz,
         $5::timestamptz + interval '1 minute',1)`,
      [preclaimedDispatch.dispatchId, preclaimedLegacy.sessionId,
        preclaimedCommand.idempotencyKey, canonicalJsonText(preclaimedDispatch),
        preclaimedDispatch.dispatchedAt, "43434343-4343-4343-8343-434343434343"],
    );
    await connection.query(
      `INSERT INTO codeops.session_runtime_outbox
         (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,available_at,created_at)
       VALUES($1,$2,$3,'access:user@example.com',$4::jsonb,'pending',$5::timestamptz,$5::timestamptz)`,
      [olderDispatch.dispatchId, older.sessionId, olderCommand.idempotencyKey,
        canonicalJsonText(olderDispatch), olderDispatch.dispatchedAt],
    );
    await connection.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,
          launch_json,state,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,$7::timestamptz)`,
      [preUpgradeLaunch.launchId, preUpgradeLaunch.principalId,
        preUpgradeLaunch.idempotencyKey, preUpgradeLaunch.requestDigest,
        canonicalJsonText({ idempotencyKey: preUpgradeLaunch.idempotencyKey }),
        canonicalJsonText(preUpgradeLaunch), preUpgradeLaunch.createdAt],
    );
    const runtimeMigration = await readFile(
      new URL("../sql/runtime-compatible-substitution-v1.sql", import.meta.url),
      "utf8",
    );
    assert.equal(
      await applySessionBrokerMigration(
        connection,
        runtimeMigration,
        "runtime-compatible-substitution-v1",
      ),
      "applied",
    );
    const migratedPreclaimed = await connection.query(
      `SELECT status,claim_count,runtime_claim_protocol,runtime_binding_revision
         FROM codeops.session_runtime_outbox WHERE dispatch_id=$1`,
      [preclaimedDispatch.dispatchId],
    );
    assert.deepEqual(migratedPreclaimed.rows[0], {
      status: "claimed",
      claim_count: 1,
      runtime_claim_protocol: "legacy-unproven-v1",
      runtime_binding_revision: "0",
    });
    const migratedPreclaimedOwner = await connection.query(
      `SELECT legacy_runtime_worker_compatible
         FROM codeops.sessions WHERE session_id=$1`,
      [preclaimedLegacy.sessionId],
    );
    assert.equal(migratedPreclaimedOwner.rows[0].legacy_runtime_worker_compatible, true);
    const markedLaunch = await connection.query(
      `SELECT launch_json->>'legacyRuntimeCompatible' AS marker
         FROM codeops.workspace_launches WHERE launch_id=$1`,
      [preUpgradeLaunch.launchId],
    );
    assert.equal(markedLaunch.rows[0].marker, "true");
    const queuedRuntimeLaunch = {
      ...preUpgradeLaunch,
      launchId: "launch-queued-rollback-0000001",
      idempotencyKey: "31313131-3131-4131-8131-313131313131",
      runtimeRequirements: requirements,
      runtimeRequirementDigest: requirementDigest,
    };
    await connection.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,
          launch_json,state,created_at,updated_at,runtime_requirements_json,
          runtime_requirement_digest)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,
         $7::timestamptz,$8::jsonb,$9)`,
      [queuedRuntimeLaunch.launchId, queuedRuntimeLaunch.principalId,
        queuedRuntimeLaunch.idempotencyKey, queuedRuntimeLaunch.requestDigest,
        canonicalJsonText({ idempotencyKey: queuedRuntimeLaunch.idempotencyKey }),
        canonicalJsonText(queuedRuntimeLaunch), queuedRuntimeLaunch.createdAt,
        canonicalJsonText(requirements), requirementDigest],
    );
    await connection.query(
      `UPDATE codeops.workspace_launches
          SET state='failed',
              launch_json=jsonb_set(
                jsonb_set(launch_json,'{state}','"failed"'::jsonb),
                '{failureCode}','"provisioning-failed"'::jsonb
              )
        WHERE launch_id=$1`,
      [queuedRuntimeLaunch.launchId],
    );
    await connection.query(runtimeRevert);
    const oldLaunch = await connection.query(
      `SELECT launch_json FROM codeops.workspace_launches WHERE launch_id=$1`,
      [preUpgradeLaunch.launchId],
    );
    assert.equal("legacyRuntimeCompatible" in oldLaunch.rows[0].launch_json, false);
    assert.deepEqual(workspaceLaunchSchema.parse(oldLaunch.rows[0].launch_json), preUpgradeLaunch);
    const rolledBackQueuedLaunch = await connection.query(
      `SELECT launch_json FROM codeops.workspace_launches WHERE launch_id=$1`,
      [queuedRuntimeLaunch.launchId],
    );
    const expectedOldQueuedLaunch = {
      ...queuedRuntimeLaunch,
      state: "failed",
      failureCode: "provisioning-failed",
    };
    delete expectedOldQueuedLaunch.runtimeRequirements;
    delete expectedOldQueuedLaunch.runtimeRequirementDigest;
    assert.deepEqual(rolledBackQueuedLaunch.rows[0].launch_json, expectedOldQueuedLaunch);
    assert.deepEqual(
      workspaceLaunchSchema.parse(rolledBackQueuedLaunch.rows[0].launch_json),
      expectedOldQueuedLaunch,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.workspace_launches
            SET launch_json=jsonb_set(launch_json,'{attemptCount}','1'::jsonb)
          WHERE launch_id=$1`,
        [queuedRuntimeLaunch.launchId],
      ),
      /terminal workspace launch is immutable/,
    );
    assert.equal(
      await applySessionBrokerMigration(
        connection,
        runtimeMigration,
        "runtime-compatible-substitution-v1",
      ),
      "applied",
    );
    const upgraded = await connection.query(
      `SELECT legacy_runtime_worker_compatible
         FROM codeops.sessions WHERE session_id=$1`,
      [older.sessionId],
    );
    assert.equal(upgraded.rows[0].legacy_runtime_worker_compatible, true);
    const idleClaim = await claimSessionRuntimeDispatch(connection, {
      workerId: "worker:idle-legacy", sessionId: idleLegacy.sessionId, generation: 1,
      leaseId, identity: idleLegacy.identity, leaseMs: 60_000,
      fallbackRuntimeOwner: { requirements, launchBinding },
      now: () => new Date("2026-08-31T08:02:00.000Z"),
    });
    assert.equal(idleClaim, null);
    const idleOwner = await connection.query(
      `SELECT runtime_launch_binding_json FROM codeops.sessions WHERE session_id=$1`,
      [idleLegacy.sessionId],
    );
    assert.equal(idleOwner.rows[0].runtime_launch_binding_json, null);
    await assert.rejects(
      connection.query(
        `INSERT INTO codeops.sessions
           (session_id,generation,lease_id,snapshot_json,updated_at,
            owner_principal_id,legacy_runtime_worker_compatible)
         VALUES($1,1,$2,$3::jsonb,$4::timestamptz,
           'access:user@example.com',true)`,
        ["new-forged-legacy-session", leaseId,
          canonicalJsonText(snapshot("new-forged-legacy-session", "new-run")),
          "2026-08-31T08:00:00.000Z"],
      ),
      /new sessions cannot use legacy runtime worker compatibility/,
    );
    const forgedLegacyLaunch = {
      launchId: "launch-forged-legacy-00000001",
      principalId: "access:user@example.com",
      idempotencyKey: "23232323-2323-4232-8232-232323232323",
      requestDigest: `sha256:${"3".repeat(64)}`,
      state: "queued",
      legacyRuntimeCompatible: true,
    };
    await assert.rejects(
      connection.query(
        `INSERT INTO codeops.workspace_launches
           (launch_id,principal_id,idempotency_key,request_digest,request_json,
            launch_json,state,created_at,updated_at,legacy_runtime_compatible)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,
           $7::timestamptz,true)`,
        [forgedLegacyLaunch.launchId, forgedLegacyLaunch.principalId,
          forgedLegacyLaunch.idempotencyKey, forgedLegacyLaunch.requestDigest,
          canonicalJsonText({ idempotencyKey: forgedLegacyLaunch.idempotencyKey }),
          canonicalJsonText(forgedLegacyLaunch), "2026-08-31T08:00:00.000Z"],
      ),
      /new workspace launches cannot use legacy runtime compatibility/,
    );
    const unboundLaunch = {
      launchId: "launch-old-producer-000000001",
      principalId: "access:user@example.com",
      idempotencyKey: "24242424-2424-4242-8242-242424242424",
      requestDigest: `sha256:${"4".repeat(64)}`,
      state: "queued",
    };
    await assert.rejects(
      connection.query(
        `INSERT INTO codeops.workspace_launches
           (launch_id,principal_id,idempotency_key,request_digest,request_json,
            launch_json,state,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,$7::timestamptz)`,
        [unboundLaunch.launchId, unboundLaunch.principalId,
          unboundLaunch.idempotencyKey, unboundLaunch.requestDigest,
          canonicalJsonText({ idempotencyKey: unboundLaunch.idempotencyKey }),
          canonicalJsonText(unboundLaunch), "2026-08-31T08:00:00.000Z"],
      ),
      /new workspace launches require complete runtime admission/,
    );
    const incompleteBindingLaunch = {
      ...unboundLaunch,
      launchId: "launch-incomplete-binding-0001",
      idempotencyKey: "25252525-2525-4252-8252-252525252525",
      runtimeRequirements: requirements,
      runtimeRequirementDigest: requirementDigest,
    };
    await connection.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,
          launch_json,state,created_at,updated_at,runtime_requirements_json,
          runtime_requirement_digest)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'queued',$7::timestamptz,
         $7::timestamptz,$8::jsonb,$9)`,
      [incompleteBindingLaunch.launchId, incompleteBindingLaunch.principalId,
        incompleteBindingLaunch.idempotencyKey, incompleteBindingLaunch.requestDigest,
        canonicalJsonText({ idempotencyKey: incompleteBindingLaunch.idempotencyKey }),
        canonicalJsonText(incompleteBindingLaunch), "2026-08-31T08:00:00.000Z",
        canonicalJsonText(requirements), requirementDigest],
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.workspace_launches
            SET state='provisioning',
                launch_json=jsonb_set(launch_json,'{state}','"provisioning"'::jsonb)
          WHERE launch_id=$1`,
        [incompleteBindingLaunch.launchId],
      ),
      /workspace provisioning requires a complete runtime launch binding/,
    );
    const oldAgentRoot = snapshot("old-agent-producer-root", "old-agent-producer-run");
    await assert.rejects(
      connection.query(
        `INSERT INTO codeops.sessions
           (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
         VALUES($1,1,$2,$3::jsonb,$4::timestamptz,'access:user@example.com')`,
        [oldAgentRoot.sessionId, leaseId, canonicalJsonText(oldAgentRoot), oldAgentRoot.updatedAt],
      ),
      /new root sessions require a complete runtime launch binding/,
    );
    await connection.query(
      `UPDATE codeops.session_runtime_outbox
          SET status='claimed', claim_token=$2, claimed_by='old-gateway-v1',
              claimed_at='2026-08-31T08:02:00.000Z',
              claim_expires_at='2026-08-31T08:03:00.000Z',
              claim_count=claim_count+1
        WHERE dispatch_id=$1`,
      [olderDispatch.dispatchId, "30303030-3030-4030-8030-303030303030"],
    );
    const legacyProof = await connection.query(
      `SELECT runtime_claim_protocol, runtime_binding_json, runtime_release_digest
         FROM codeops.session_runtime_outbox WHERE dispatch_id=$1`,
      [olderDispatch.dispatchId],
    );
    assert.deepEqual(legacyProof.rows[0], {
      runtime_claim_protocol: "legacy-unproven-v1",
      runtime_binding_json: null,
      runtime_release_digest: null,
    });
    const persistedLegacyOwner = await connection.query(
      `SELECT runtime_launch_binding_json FROM codeops.sessions WHERE session_id=$1`,
      [older.sessionId],
    );
    assert.equal(persistedLegacyOwner.rows[0].runtime_launch_binding_json, null);
    const upgradedClaim = await claimSessionRuntimeDispatch(connection, {
      workerId: "worker:new-after-old", sessionId: older.sessionId, generation: 1,
      leaseId, identity: older.identity, runtimeProfileId: profile.profileId,
      runtimeReleaseDigest: profile.releaseDigest,
      runtimeCapabilityDigest: profile.capabilityDigest, runtimeProfile: profile,
      leaseMs: 60_000,
      fallbackRuntimeOwner: { requirements, launchBinding },
      now: () => new Date("2026-08-31T08:04:00.000Z"),
    });
    assert.equal(upgradedClaim.runtimeBinding.selectedReleaseDigest, profile.releaseDigest);
    const upgradedProof = await connection.query(
      `SELECT runtime_claim_protocol, runtime_binding_revision
         FROM codeops.session_runtime_outbox WHERE dispatch_id=$1`,
      [olderDispatch.dispatchId],
    );
    assert.deepEqual(upgradedProof.rows[0], {
      runtime_claim_protocol: "bound-v2",
      runtime_binding_revision: "1",
    });
    const launchJson = {
      launchId, principalId: "access:user@example.com",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestDigest: `sha256:${"1".repeat(64)}`, state: "provisioning",
      runtimeRequirements: requirements, runtimeRequirementDigest: requirementDigest,
      runtimeLaunchBinding: launchBinding,
    };
    await connection.query(
      `INSERT INTO codeops.workspace_launches
         (launch_id,principal_id,idempotency_key,request_digest,request_json,launch_json,state,
          created_at,updated_at,runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'provisioning',$7::timestamptz,$7::timestamptz,$8::jsonb,$9,$10::jsonb)`,
      [launchId, launchJson.principalId, launchJson.idempotencyKey, launchJson.requestDigest,
        canonicalJsonText({ idempotencyKey: launchJson.idempotencyKey }),
        canonicalJsonText(launchJson), "2026-08-31T08:00:00.000Z",
        canonicalJsonText(requirements), requirementDigest, canonicalJsonText(launchBinding)],
    );

    const root = await insertDispatch(connection, snapshot("workspace-root", launchId),
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const fork = await insertDispatch(connection, snapshot("workspace-fork", "fork-run", root.sessionId),
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const workItem = await insertDispatch(connection, snapshot("work-item-child", "work-item-run", fork.sessionId),
      "ffffffff-ffff-4fff-8fff-ffffffffffff", "12121212-1212-4121-8121-121212121212");
    const nonWorkspace = await insertDispatch(connection, snapshot("agent-job-root", "agent-job-run"),
      "13131313-1313-4131-8131-131313131313", "14141414-1414-4141-8141-141414141414", true);
    const disposable = await insertDispatch(connection, snapshot("disposable-root", "disposable-run"),
      "15151515-1515-4151-8151-151515151515", "16161616-1616-4161-8161-161616161616", true);

    for (const [index, current] of [root, fork, workItem, nonWorkspace, disposable].entries()) {
      const claim = await claimSessionRuntimeDispatch(connection, {
        workerId: `worker:${index}`, sessionId: current.sessionId, generation: 1,
        leaseId, identity: current.identity, runtimeProfileId: profile.profileId,
        runtimeReleaseDigest: profile.releaseDigest,
        runtimeCapabilityDigest: profile.capabilityDigest, runtimeProfile: profile,
        leaseMs: 60_000,
        now: () => new Date("2026-08-31T08:02:00.000Z"),
      });
      assert.equal(claim.runtimeBinding.selectedReleaseDigest, profile.releaseDigest);
    }

    await assert.rejects(claimSessionRuntimeDispatch(connection, {
      workerId: "worker:tupleless-child", sessionId: fork.sessionId, generation: 1,
      leaseId, identity: fork.identity, leaseMs: 60_000,
      now: () => new Date("2026-08-31T08:04:00.000Z"),
    }), /runtime-release-mismatch/);

    const bypass = await insertDispatch(connection, snapshot("claim-trigger-bypass", "bypass-run"),
      "19191919-1919-4191-8191-191919191919", "20202020-2020-4202-8202-202020202020", true);

    await connection.query(`CREATE ROLE ${normalRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await connection.query(`GRANT USAGE ON SCHEMA codeops TO ${normalRole}`);
    await connection.query(`GRANT SELECT ON codeops.sessions TO ${normalRole}`);
    await connection.query(`GRANT UPDATE (snapshot_json) ON codeops.sessions TO ${normalRole}`);
    await connection.query(`GRANT SELECT, UPDATE, INSERT ON codeops.workspace_launches, codeops.session_runtime_outbox TO ${normalRole}`);
    await connection.query(`SET ROLE ${normalRole}`);
    await assert.rejects(
      connection.query(
        `UPDATE codeops.sessions
            SET snapshot_json=jsonb_set(
              snapshot_json,'{identity,parentSessionId}',$2::jsonb
            )
          WHERE session_id=$1`,
        [fork.sessionId, JSON.stringify(nonWorkspace.sessionId)],
      ),
      /session lineage identity is immutable/,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.sessions
            SET snapshot_json=jsonb_set(
              snapshot_json,'{identity,runId}',$2::jsonb
            )
          WHERE session_id=$1`,
        [root.sessionId, JSON.stringify("substituted-workspace-owner")],
      ),
      /session lineage identity is immutable/,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.workspace_launches
            SET launch_json = jsonb_set(launch_json, '{runtimeLaunchBinding}', 'null'::jsonb)
          WHERE launch_id=$1`,
        [launchId],
      ),
      /immutable|workspace_launch_runtime_binding_complete/,
    );
    const replacementBinding = {
      ...launchBinding,
      profile: {
        ...profile,
        releaseDigest: `sha256:${"4".repeat(64)}`,
      },
    };
    await assert.rejects(
      connection.query(
        `UPDATE codeops.workspace_launches
            SET launch_json = jsonb_set(launch_json, '{runtimeLaunchBinding}', $2::jsonb),
                runtime_launch_binding_json = $2::jsonb
          WHERE launch_id=$1`,
        [launchId, canonicalJsonText(replacementBinding)],
      ),
      /workspace runtime requirements and launch binding are immutable/,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.workspace_launches
            SET launch_json = launch_json - 'runtimeLaunchBinding'
          WHERE launch_id=$1`,
        [launchId],
      ),
      /immutable|workspace_launch_runtime_binding_complete/,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.session_runtime_outbox
            SET runtime_binding_json=NULL, runtime_binding_revision=0,
                runtime_requirement_digest=NULL, runtime_profile_id=NULL,
                runtime_release_digest=NULL, runtime_capability_digest=NULL
          WHERE dispatch_id=$1`,
        ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ),
      /admitted runtime binding evidence is immutable/,
    );
    await assert.rejects(
      connection.query(
        `UPDATE codeops.session_runtime_outbox
            SET status='claimed', claimed_by='normal-role-bypass',
                claim_token='21212121-2121-4212-8212-212121212121',
                claimed_at='2026-08-31T08:05:00.000Z',
                claim_expires_at='2026-08-31T08:06:00.000Z'
          WHERE session_id=$1`,
        [bypass.sessionId],
      ),
      /claimed runtime dispatch requires bound-v2 or migration-owned legacy proof/,
    );
    const forgedOwnerBinding = {
      version: "codeops.runtime-binding/v1",
      requirementDigest,
      compatibilityPolicyRevision: requirements.compatibilityPolicyRevision,
      selectedProfileId: profile.profileId,
      selectedReleaseDigest: `sha256:${"4".repeat(64)}`,
      selectedCapabilityDigest: profile.capabilityDigest,
      selectedProfile: { ...profile, releaseDigest: `sha256:${"4".repeat(64)}` },
      selectedAt: launchBinding.selectedAt,
    };
    await assert.rejects(
      connection.query(
        `UPDATE codeops.session_runtime_outbox
            SET status='claimed', claimed_by='normal-forged-binding',
                claim_token='32323232-3232-4232-8232-323232323232',
                claimed_at='2026-08-31T08:05:00.000Z',
                claim_expires_at='2026-08-31T08:06:00.000Z',
                claim_count=claim_count+1,
                runtime_binding_revision=runtime_binding_revision+1,
                runtime_binding_json=$2::jsonb,
                runtime_requirement_digest=$3,
                runtime_profile_id=$4,
                runtime_release_digest=$5,
                runtime_capability_digest=$6,
                runtime_claim_protocol='bound-v2'
          WHERE session_id=$1`,
        [bypass.sessionId, canonicalJsonText(forgedOwnerBinding),
          requirementDigest, profile.profileId,
          forgedOwnerBinding.selectedReleaseDigest, profile.capabilityDigest],
      ),
      /bound-v2 runtime claim does not match immutable root owner/,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO codeops.session_runtime_outbox
           (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
            available_at,created_at,claim_token,claimed_by,claimed_at,claim_expires_at,claim_count)
         SELECT '27272727-2727-4272-8272-272727272727',session_id,
                '28282828-2828-4282-8282-282828282828',principal_id,dispatch_json,
                'claimed',available_at,created_at,
                '29292929-2929-4292-8292-292929292929','normal-insert-bypass',
                '2026-08-31T08:05:00.000Z','2026-08-31T08:06:00.000Z',1
           FROM codeops.session_runtime_outbox WHERE dispatch_id=$1`,
        ["19191919-1919-4191-8191-191919191919"],
      ),
      /claimed runtime dispatch requires bound-v2 or migration-owned legacy proof/,
    );
    await connection.query("RESET ROLE");
  } finally {
    await connection.query("RESET ROLE").catch(() => undefined);
    const retainedRole = await connection.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [normalRole],
    ).catch(() => ({ rows: [] }));
    if (retainedRole.rows.length === 1) {
      await connection.query(`DROP OWNED BY ${normalRole}`).catch(() => undefined);
      await connection.query(`DROP ROLE IF EXISTS ${normalRole}`).catch(() => undefined);
    }
    await connection.end();
  }
});

test("retained incident stays unchanged across selectors and direct reconcilers", { skip }, async () => {
  const connection = new Client({ connectionString: databaseUrl });
  await connection.connect();
  const retained = "launch-222222222222222222222222";
  const retainedSession = "ses_222222222222222222222222";
  const clean = "launch-333333333333333333333333";
  try {
    await connection.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(connection);
    for (const [id, uuid] of [[retained, "26262626-2626-4262-8262-262626262626"],
      [clean, "27272727-2727-4272-8272-272727272727"]]) {
      const value = { ...preUpgradeLaunch, launchId: id, idempotencyKey: uuid,
        runtimeRequirements: requirements, runtimeRequirementDigest: requirementDigest, runtimeLaunchBinding: launchBinding, state: "provisioning", sessionId: id === retained ? retainedSession : "ses_333333333333333333333333" };
      await connection.query(`INSERT INTO codeops.workspace_launches
        (launch_id,principal_id,idempotency_key,request_digest,request_json,launch_json,state,created_at,updated_at,runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
        VALUES($1,$2,$3,$4,'{}',$5,'provisioning',$6,$6,$7,$8,$9)`,
        [id,value.principalId,uuid,value.requestDigest,JSON.stringify(value),value.createdAt,JSON.stringify(requirements),requirementDigest,JSON.stringify(launchBinding)]);
    }
    await insertDispatch(connection, snapshot(retainedSession, retained),
      "46464646-4646-4646-8646-464646464646", "47474747-4747-4747-8747-474747474747");
    assert.ok(await claimSessionRuntimeDispatch(connection, runtimeClaimInput(snapshot(retainedSession, retained), "fixture-worker", "48484848-4848-4848-8848-484848484848")));
    const read = async () => (await connection.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(x)) FROM codeops.workspace_launches x WHERE launch_id=$1) launches,
      (SELECT jsonb_agg(to_jsonb(x)) FROM codeops.sessions x) sessions,
      (SELECT jsonb_agg(to_jsonb(x)) FROM codeops.session_runtime_outbox x) outbox`, [retained])).rows[0];
    for (const nextAttemptAt of [null, "2099-01-01T00:00:00Z"]) {
      await connection.query(`UPDATE codeops.workspace_launches SET launch_json =
        launch_json || jsonb_build_object('nextAttemptAt',$2::text) WHERE launch_id=$1`, [retained,nextAttemptAt]);
      const before = await read();
      assert.deepEqual(await listActiveWorkspaceLaunchIds(connection), [clean]);
      assert.deepEqual(await listInteractiveRuntimeCandidates(connection), []);
      assert.equal(await reconcileWorkspaceLaunch(retained, new Proxy({}, { get() { assert.fail("unexpected effect"); } })), null);
      const candidate = { sessionId: retainedSession, runId: retained, generation: 1, leaseId };
      assert.equal(await recordInteractiveRuntimeJobProgress(connection, {candidate, job: {}, observedAt: "2026-09-05T00:00:00Z"}), "stale");
      assert.deepEqual(await read(), before);
    }
  } finally { await connection.end(); }
});
