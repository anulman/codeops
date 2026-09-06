import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { Client } from "pg";
import { requireDisposablePostgres } from "../../../infra/scripts/disposable-postgres.mjs";
import { canonicalJsonText, sessionSnapshotSchema, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { migrateSessionBroker } from "../dist/session-broker-migration.js";
import { buildSessionRuntimeDispatch } from "../dist/session-broker-runtime.js";
import { completeSessionRuntimeDispatch } from "../dist/session-broker-runtime-outbox.js";
import { executeLocalSessionCommandTransaction } from "../dist/session-broker-command.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";
import { authenticatedCheckpointOperator, authorizeCheckpointCleanup,
  configureCheckpointRetention, placeCheckpointHold, releaseCheckpointHold,
  loadClaimedCheckpointWorkspaceBinding, readClaimedCheckpointRecovery,
  recordRestoreReceipt, validateCleanupDecisionReadback } from "../dist/checkpoint-recovery.js";
let captureVerifiedWorkspaceCheckpoint;
let restoreVerifiedWorkspaceCheckpoint;
let PostgresWorkspaceCheckpointArtifactStore;
let PostgresRuntimeExecutionReceiptStore;
let sessionRuntimeDispatchDigest;

const databaseUrl = process.env.CODEOPS_TEST_POSTGRES_URL?.trim();
const skip = databaseUrl === undefined ? "CODEOPS_TEST_POSTGRES_URL is not configured" : false;
let suiteLock;
const connect = async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); return client; };
before(async () => {
  if (skip) return;
  await requireDisposablePostgres(databaseUrl);
  // The qualification runner builds the worker before this cross-owner proof.
  ({ captureVerifiedWorkspaceCheckpoint } = await import("../../codeops-session-runtime-worker/dist/acp-workspace.js"));
  ({ restoreVerifiedWorkspaceCheckpoint } = await import("../../codeops-session-runtime-worker/dist/workspace-recovery.js"));
  ({ PostgresWorkspaceCheckpointArtifactStore } = await import("../../codeops-session-runtime-worker/dist/workspace-artifacts.js"));
  ({ PostgresRuntimeExecutionReceiptStore } = await import("../../codeops-session-runtime-worker/dist/postgres-receipts.js"));
  ({ sessionRuntimeDispatchDigest } = await import("../../codeops-session-runtime-worker/dist/lifecycle.js"));
  suiteLock = await connect();
  await suiteLock.query("SELECT pg_advisory_lock(hashtext('codeops-control-gateway-postgres-tests'))");
  await migrateSessionBroker(suiteLock);
});
after(async () => { if (suiteLock) await suiteLock.end(); });
const owner = "operator:checkpoint-test";
const workerId = "runtime:checkpoint-test";
const operator = authenticatedCheckpointOperator({ token: "t".repeat(32), headers: {
  authorization: `Bearer ${"t".repeat(32)}`, "x-codeops-principal": owner } });
const digest = (value) => `sha256:${value.repeat(64)}`;
const seededAt = "2026-09-06T00:00:00.000Z";
const runtimeRequirements = { version: "codeops.runtime-requirements/v1", capabilities: ["acp"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1280, ephemeralStorageMiB: 1280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "policy-7" };
const runtimeRequirementDigest = sha256CanonicalJsonDigest(runtimeRequirements);
const runtimeProfile = { version: "codeops.runtime-profile/v1", profileId: "standard-v1",
  releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"],
  capabilityDigest: sha256CanonicalJsonDigest(["acp"]),
  resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
  authority: runtimeRequirements.maximumAuthority, compatibilityPolicyRevision: "policy-7",
  images: { agent: `example/agent@sha256:${"8".repeat(64)}`, worker: `example/worker@sha256:${"9".repeat(64)}`,
    sessionGateway: `example/gateway@sha256:${"a".repeat(64)}` } };
const runtimeLaunchBinding = { version: "codeops.runtime-launch-binding/v1",
  requirementDigest: runtimeRequirementDigest, profile: runtimeProfile, selectedAt: seededAt };
const runtimeBinding = { version: "codeops.runtime-binding/v1", requirementDigest: runtimeRequirementDigest,
  compatibilityPolicyRevision: "policy-7", selectedProfileId: runtimeProfile.profileId,
  selectedReleaseDigest: runtimeProfile.releaseDigest, selectedCapabilityDigest: runtimeProfile.capabilityDigest,
  selectedProfile: runtimeProfile,
  selectedAt: seededAt };


async function seedClaim(client, snapshot, type) {
  const dispatch = buildSessionRuntimeDispatch({ dispatchId: randomUUID(), principalId: owner,
    snapshot, dispatchedAt: new Date().toISOString(), command: {
      version: "codeops.session-command/v1", sessionId: snapshot.sessionId,
      generation: snapshot.generation, leaseId: snapshot.lease.leaseId,
      idempotencyKey: randomUUID(), type,
      ...(type === "resume" ? { checkpointId: snapshot.checkpoint.checkpointId } : {}),
    } });
  const claimToken = randomUUID();
  await client.query(`INSERT INTO codeops.session_runtime_outbox
    (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
     available_at,created_at,claim_token,claimed_by,claimed_at,claim_expires_at,claim_count,
     runtime_binding_json,runtime_binding_revision,runtime_claim_protocol,
     runtime_requirement_digest,runtime_profile_id,runtime_release_digest,runtime_capability_digest)
    VALUES ($1,$2,$3,$4,$5::jsonb,'claimed',$6,$6,$7,$8,clock_timestamp(),
      clock_timestamp()+interval '15 minutes',1,$9::jsonb,1,'bound-v2',$10,$11,$12,$13)`,
  [dispatch.dispatchId,snapshot.sessionId,dispatch.command.idempotencyKey,owner,
    canonicalJsonText(dispatch),dispatch.dispatchedAt,claimToken,workerId,
    canonicalJsonText(runtimeBinding),runtimeRequirementDigest,runtimeProfile.profileId,
    runtimeProfile.releaseDigest,runtimeProfile.capabilityDigest]);
  return { dispatch, claimToken, workerId, dispatchId: dispatch.dispatchId };
}
async function finish(client, claim, result) {
  const receipts = new PostgresRuntimeExecutionReceiptStore(client);
  const dispatchDigest = sessionRuntimeDispatchDigest(claim.dispatch);
  await receipts.reserve({ dispatchId: claim.dispatchId, dispatchDigest });
  await receipts.complete({ dispatchId: claim.dispatchId, dispatchDigest, result });
  claim.completion = { version: "codeops.session-runtime-completion/v1", dispatchId: claim.dispatchId,
    sessionId: claim.dispatch.command.sessionId, generation: claim.dispatch.command.generation,
    leaseId: claim.dispatch.command.leaseId, idempotencyKey: claim.dispatch.command.idempotencyKey,
    observedEventCursor: claim.dispatch.snapshot.eventCursor, completedAt: new Date().toISOString(), ...result };
  return completeSessionRuntimeDispatch(client, { ...claim, completion: claim.completion });
}
async function fixture(client, legacy = false) {
  const now = new Date().toISOString();
  const sessionId = `ses_${randomUUID()}`;
  const leaseId = randomUUID();
  const jobUid = randomUUID();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "checkpoint-pg-source-"));
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "checkpoint-pg-private-"));
  await mkdir(path.join(workspace, "scratch"));
  await writeFile(path.join(workspace, "scratch", "notes.txt"), "durable scratch\n");
  const snapshot = sessionSnapshotSchema.parse({ version: "codeops.session-snapshot/v1",
    sessionId, generation: 1, state: "running", identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: { version: "codeops.session-policy/v1", mode: "implement",
        workspaceAccess: "bounded-writes", modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } },
      workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
      workflowId: "checkpoint-test", runId: "checkpoint-test",
      parentSessionId: null, forkedAtCursor: null },
    lease: { leaseId, generation: 1, status: "active", holderId: workerId,
      acquiredAt: now, expiresAt: new Date(Date.now()+3600_000).toISOString() },
    checkpoint: null, pendingPermission: null, eventCursor: 0,
    capabilities: sessionCapabilitiesFor("running", false), updatedAt: now });
  await client.query(`INSERT INTO codeops.sessions
    (session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id,
     runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
    VALUES ($1,1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8::jsonb)`,
  [sessionId,leaseId,canonicalJsonText(snapshot),now,owner,canonicalJsonText(runtimeRequirements),
    runtimeRequirementDigest,canonicalJsonText(runtimeLaunchBinding)]);
  await client.query(`INSERT INTO codeops.session_runtime_job_progress
    (session_id,generation,lease_id,run_id,job_name,job_uid,job_resource_version,observed_at,resource_configuration_digest)
    VALUES ($1,1,$2,'checkpoint-test',$3,$4,1,clock_timestamp(),$5)`,
  [sessionId,leaseId,`workspace-${jobUid}`,jobUid,digest("a")]);
  const captureClaim = await seedClaim(client, snapshot, "hibernate");
  const binding = await loadClaimedCheckpointWorkspaceBinding(client, captureClaim);
  assert.equal(binding.jobUid, jobUid);
  const checkpointId = randomUUID();
  const captured = await captureVerifiedWorkspaceCheckpoint({ workspaceRoot: workspace,
    manifest: snapshot.identity.workspace, captureRoot: privateRoot, checkpointId,
    sessionId, generation: 1, workspaceJobUid: binding.jobUid,
    resourceConfigurationDigest: binding.resourceConfigurationDigest,
    workspaceConfigurationDigest: binding.workspaceConfigurationDigest, capturedAt: now });
  const store = new PostgresWorkspaceCheckpointArtifactStore(client);
  await store.put({ artifactId: `artifact:${checkpointId}:scratch`, checkpointId,
    sessionId, generation: 1, kind: "scratch-bundle", digest: captured.captured.scratch.digest,
    content: captured.captured.scratch.content });
  const completion = await finish(client, captureClaim, { type: "hibernate", material: legacy ? {
    version: "codeops.session-workspace-checkpoint-material/v1", checkpointId,
    workspaceManifestDigest: captured.descriptor.manifest.binding.workspaceManifestDigest,
    sourcePatches: [], scratchArtifactDigest: captured.captured.scratch.digest,
    acpSessionId: "acp-checkpoint", evidenceReferences: [`artifact:${checkpointId}:scratch`],
  } : {
    version: "codeops.session-workspace-checkpoint-material/v2", descriptor: captured.descriptor,
    acpSessionId: "acp-checkpoint", evidenceReferences: [`artifact:${checkpointId}:scratch`] } });
  assert.equal(completion.disposition, "committed");
  const resumeClaim = await seedClaim(client, completion.snapshot, "resume");
  return { checkpointId, jobUid, privateRoot, resumeClaim, snapshot: completion.snapshot,
    descriptor: captured.descriptor };
}
async function restore(client, run) {
  const read = await readClaimedCheckpointRecovery(client, run.resumeClaim);
  const again = await readClaimedCheckpointRecovery(client, run.resumeClaim);
  assert.deepEqual(again, read);
  await assert.rejects(recordRestoreReceipt(client, { checkpointId: run.checkpointId }), /committed execution/);
  const artifacts = { get: async (artifactId) => {
    const chunk = await readClaimedCheckpointRecovery(client, { ...run.resumeClaim, artifactId, offset: 0 });
    return { artifactId, sessionId: run.snapshot.sessionId, generation: 1, checkpointId: run.checkpointId,
      kind: "scratch-bundle", digest: chunk.digest, content: Buffer.from(chunk.contentBase64, "base64") };
  } };
  const restored = await restoreVerifiedWorkspaceCheckpoint({ descriptor: read.descriptor,
    workspaceManifest: run.snapshot.identity.workspace, artifacts, privateRoot: run.privateRoot,
    restoreOperationId: read.restoreOperationId, restoredWorkspaceJobUid: read.workspaceBinding.jobUid,
    restoredResourceConfigurationDigest: read.workspaceBinding.resourceConfigurationDigest,
    restoredWorkspaceConfigurationDigest: read.workspaceBinding.workspaceConfigurationDigest,
    restoredGeneration: run.resumeClaim.dispatch.command.generation + 1, restoredAt: new Date().toISOString(), materializeBase: async () => assert.fail() });
  const result = { type: "resume", material: { leaseId: randomUUID(), holderId: workerId,
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600_000).toISOString(),
    restoreVerification: { operationId: read.restoreOperationId, descriptor: read.descriptor } } };
  const completed = await finish(client, run.resumeClaim, result);
  assert.equal(completed.disposition, "committed");
  run.snapshot = completed.snapshot;
  const receipt = await recordRestoreReceipt(client, { checkpointId: run.checkpointId,
    restoredWorkspaceJobUid: randomUUID(), restoredAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(receipt.restoredWorkspaceJobUid, run.jobUid);
  assert.equal(receipt.restoreOperationId, read.restoreOperationId);
  assert.equal(receipt.restoredPathSetDigest, restored.receipt.restoredPathSetDigest);
  assert.notEqual(receipt.restoredAt, "2099-01-01T00:00:00.000Z");
  assert.deepEqual(await recordRestoreReceipt(client, { checkpointId: run.checkpointId }), receipt);
  const replay = await completeSessionRuntimeDispatch(client, { ...run.resumeClaim, completion: run.resumeClaim.completion });
  assert.equal(replay.disposition, "duplicate");
}
async function local(client, run, type) {
  const result = await executeLocalSessionCommandTransaction(client, { principalId: owner, command: {
    version: "codeops.session-command/v1", type, sessionId: run.snapshot.sessionId,
    generation: run.snapshot.generation, leaseId: run.snapshot.lease.leaseId,
    idempotencyKey: randomUUID(), reason: "checkpoint cleanup qualification" } });
  assert.equal(result.disposition, "committed"); run.snapshot = result.snapshot;
}
async function retry(operation) {
  for (let attempt=0;;attempt++) { try { return await operation(); } catch (error) {
    if (attempt === 4 || !["40001", "40P01"].includes(error.code)) throw error;
  } }
}

test("public capture/completion, claimed restore, receipt, retention, hold and cleanup boundaries", { skip }, async () => {
  const client = await connect(); const peer = await connect();
  try {
    const run = await fixture(client);
    const input = { operator, checkpointId: run.checkpointId };
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "policy-not-configured");
    await configureCheckpointRetention(client, { ...input, retainForSeconds: 1, authorityForSeconds: 60 });
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "restore-receipt-missing");
    await restore(client, run);
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "session-not-terminal");
    await local(client, run, "cancel");
    const policy = await configureCheckpointRetention(client, { ...input, retainForSeconds: 1, authorityForSeconds: 60 });
    assert.equal((await authorizeCheckpointCleanup(client, { ...input, now: "2099-01-01T00:00:00Z" })).reason, "retention-not-expired");
    assert.deepEqual(await configureCheckpointRetention(client, { ...input, decisionId: policy.decisionId,
      retainForSeconds: 1, authorityForSeconds: 60 }), policy);
    const hold = await placeCheckpointHold(client, { ...input, reason: "review", eventId: randomUUID() });
    assert.deepEqual(await placeCheckpointHold(client, { ...input, reason: "review", eventId: hold.eventId }), hold);
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "active-hold");
    await releaseCheckpointHold(client, { ...input, reason: "review complete" });
    await local(client, run, "archive");
    run.resumeClaim = await seedClaim(client, run.snapshot, "resume");
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "session-not-terminal");
    await restore(client, run);
    assert.equal(run.snapshot.generation, 3);
    await local(client, run, "cancel");
    await local(client, run, "archive");
    await new Promise(resolve => setTimeout(resolve, 1100));
    const decisionId = randomUUID();
    const decisions = await Promise.all([client, peer].map(connection => retry(() =>
      authorizeCheckpointCleanup(connection, { ...input, decisionId }))));
    assert.equal(decisions[0].authorized, true); assert.deepEqual(decisions[0], decisions[1]);
    assert.deepEqual(await validateCleanupDecisionReadback(client, decisionId), decisions[0]);
    assert.equal((await authorizeCheckpointCleanup(client, input)).reason, "authority-drift");
    await placeCheckpointHold(client, { ...input, reason: "later hold" });
    await assert.rejects(validateCleanupDecisionReadback(client, decisionId), /authority drifted/);
    await assert.rejects(authorizeCheckpointCleanup(client, { ...input, decisionId }), /current authority/);
    await releaseCheckpointHold(client, { ...input, reason: "release later hold" });
    await configureCheckpointRetention(client, { ...input, retainForSeconds: 1, authorityForSeconds: 60 });
    await assert.rejects(validateCleanupDecisionReadback(client, decisionId), /authority drifted/);
  } finally { await peer.end(); await client.end(); }
});

test("legacy, stale claim, corruption, cancellation and failure cannot become restore evidence", { skip }, async () => {
  const client = await connect();
  try {
    assert.equal((await authorizeCheckpointCleanup(client, { operator, checkpointId: randomUUID() })).reason, "legacy-unverified");
    await assert.rejects(recordRestoreReceipt(client, { checkpointId: randomUUID() }), /legacy/);
    const legacy = await fixture(client, true);
    await assert.rejects(readClaimedCheckpointRecovery(client, legacy.resumeClaim), /legacy/);
    await assert.rejects(recordRestoreReceipt(client, { checkpointId: legacy.checkpointId }), /legacy/);
    assert.equal((await authorizeCheckpointCleanup(client, { operator, checkpointId: legacy.checkpointId })).reason, "legacy-unverified");
    const run = await fixture(client);
    await assert.rejects(readClaimedCheckpointRecovery(client, { ...run.resumeClaim, claimToken: randomUUID() }), /live dispatch claim/);
    await assert.rejects(readClaimedCheckpointRecovery(client, { ...run.resumeClaim, artifactId: `artifact:${randomUUID()}:scratch`, offset: 0 }), /exact claim/);
    await assert.rejects(client.query(`UPDATE codeops.workspace_checkpoint_artifacts
      SET artifact_content='corrupt'::bytea WHERE checkpoint_id=$1`, [run.checkpointId]), /append-only/);
    const recovery = await readClaimedCheckpointRecovery(client, run.resumeClaim);
    const bad = structuredClone(recovery.descriptor); bad.manifest.pathSetDigest = digest("f");
    bad.manifestDigest = sha256CanonicalJsonDigest(bad.manifest);
    await assert.rejects(finish(client, run.resumeClaim, { type: "resume", material: {
      leaseId: randomUUID(), holderId: workerId, acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now()+3600_000).toISOString(),
      restoreVerification: { operationId: recovery.restoreOperationId, descriptor: bad } } }), /restore verification/);
    assert.equal((await client.query("SELECT count(*) AS n FROM codeops.workspace_checkpoint_restore_receipts WHERE checkpoint_id=$1", [run.checkpointId])).rows[0].n, "0");
    await configureCheckpointRetention(client, { operator, checkpointId: run.checkpointId, retainForSeconds: 1, authorityForSeconds: 60 });
    for (const state of ["hibernated", "cancelled", "failed", "archived"]) {
      // Fixture a terminal observation projection; the public authority gate
      // must still refuse without a committed, verified resume.
      await client.query(`UPDATE codeops.sessions SET snapshot_json=jsonb_set(snapshot_json,'{state}',$2::jsonb)
        WHERE session_id=$1`, [run.snapshot.sessionId,JSON.stringify(state)]);
      assert.equal((await authorizeCheckpointCleanup(client, { operator, checkpointId: run.checkpointId })).reason, "restore-receipt-missing");
      await assert.rejects(recordRestoreReceipt(client, { checkpointId: run.checkpointId }), /committed execution/);
    }
  } finally { await client.end(); }
});

test("live Job/configuration and later generation drift invalidate consumed readback", { skip }, async () => {
  const client = await connect();
  try {
    const run = await fixture(client); await restore(client, run); await local(client, run, "cancel");
    const input = { operator, checkpointId: run.checkpointId };
    await configureCheckpointRetention(client, { ...input, retainForSeconds: 1, authorityForSeconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const decision = await authorizeCheckpointCleanup(client, input); assert.equal(decision.authorized, true);
    await client.query(`UPDATE codeops.session_runtime_job_progress SET resource_configuration_digest=$2 WHERE session_id=$1`, [run.snapshot.sessionId,digest("b")]);
    await assert.rejects(validateCleanupDecisionReadback(client, decision.decisionId), /authority drifted/);
    await client.query(`UPDATE codeops.session_runtime_job_progress SET resource_configuration_digest=$2 WHERE session_id=$1`, [run.snapshot.sessionId,digest("a")]);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await assert.rejects(authorizeCheckpointCleanup(client, { ...input, decisionId: decision.decisionId }), /current authority/);
    await client.query(`UPDATE codeops.sessions SET generation=3,snapshot_json=jsonb_set(jsonb_set(snapshot_json,'{generation}','3'),'{lease,generation}','3') WHERE session_id=$1`, [run.snapshot.sessionId]);
    await assert.rejects(validateCleanupDecisionReadback(client, decision.decisionId), /authority drifted/);
  } finally { await client.end(); }
});

test("a cleanup snapshot begun behind an uncommitted hold cannot consume stale authority", { skip }, async () => {
  const writer = await connect(); const contender = await connect(); const observer = await connect();
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let holding;
  const held = new Promise(resolve => { holding = resolve; });
  let placing; let deciding;
  try {
    const run = await fixture(writer); await restore(writer, run); await local(writer, run, "cancel");
    const input = { operator, checkpointId: run.checkpointId };
    await configureCheckpointRetention(writer, { ...input, retainForSeconds: 1, authorityForSeconds: 60 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const gated = { query: async (sql, values) => {
      const result = await writer.query(sql, values);
      if (sql.includes("INSERT INTO codeops.workspace_checkpoint_hold_events")) {
        holding(); await released;
      }
      return result;
    } };
    placing = placeCheckpointHold(gated, { ...input, reason: "concurrent review" });
    await held;
    deciding = authorizeCheckpointCleanup(contender, input).then(value => ({ value }), error => ({ error }));
    let blocked = false;
    for (let attempt=0; attempt<100; attempt++) {
      const result = await observer.query("SELECT pg_blocking_pids($1) AS blockers", [contender.processID]);
      if (result.rows[0].blockers.includes(writer.processID)) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "public cleanup did not wait on the hold's Session fence");
    release(); await placing;
    const outcome = await deciding;
    if (outcome.error) assert.equal(outcome.error.code, "40001");
    else assert.equal(outcome.value.reason, "active-hold");
    assert.equal((await authorizeCheckpointCleanup(contender, input)).reason, "active-hold");
    assert.equal((await observer.query(`SELECT count(*) AS n FROM codeops.workspace_checkpoint_cleanup_decisions
      WHERE checkpoint_id=$1 AND authorized`, [run.checkpointId])).rows[0].n, "0");
  } finally {
    release(); await Promise.allSettled([placing, deciding].filter(Boolean));
    await observer.end(); await contender.end(); await writer.end();
  }
});
