import { createHash, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { authenticateBearer } from "./bearer-auth.js";
import {
  canonicalJsonText,
  sessionRuntimeDispatchSchema,
  checkpointCleanupDecisionSchema,
  checkpointDescriptorSchema,
  checkpointPathEntrySchema,
  checkpointHoldEventSchema,
  checkpointReceiptSchema,
  checkpointRetentionDecisionSchema,
  restoreReceiptSchema,
  sha256CanonicalJsonDigest,
  type CheckpointCleanupDecision,
  type CheckpointDescriptor,
  type CheckpointHoldEvent,
  type CheckpointReceipt,
  type CheckpointRetentionDecision,
  type RestoreReceipt,
} from "@codeops/codeops-contracts";
import type { SessionCommandResult } from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import { loadClaimedDispatchAuthority } from "./claimed-dispatch-authority.js";

const operatorAuthority = Symbol("checkpoint-operator-authority");
const operators = new WeakSet<object>();

export interface AuthenticatedCheckpointOperator {
  readonly principalId: string;
  readonly [operatorAuthority]: true;
}

/** This constructor belongs at the authenticated operator HTTP boundary. A
 * runtime Session identity is rejected even if it is syntactically valid. */
export function authenticatedCheckpointOperator(
  input: { readonly headers: IncomingHttpHeaders; readonly token: string },
): AuthenticatedCheckpointOperator {
  const principalId = input.headers["x-codeops-principal"];
  if (!authenticateBearer(typeof input.headers.authorization === "string"
      ? input.headers.authorization : undefined, input.token) ||
      typeof principalId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(principalId) ||
      /^(?:session-runtime|session-job|workspace-runtime|runtime(?:-worker)?|worker)(?:$|[:/])/i.test(principalId)) {
    throw new Error("checkpoint hold authority requires an authenticated operator");
  }
  const authority = Object.freeze({ principalId, [operatorAuthority]: true as const });
  operators.add(authority);
  return authority;
}

function requireOperator(value: AuthenticatedCheckpointOperator): void {
  if (!operators.has(value)) {
    throw new Error("checkpoint control requires authenticated operator authority");
  }
}

async function databaseClock(client: TransactionClient): Promise<string> {
  const value = (await client.query<{ database_now: unknown }>(
    "SELECT clock_timestamp() AS database_now")).rows[0]?.database_now;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

async function fenceCheckpointAuthority(client: TransactionClient, checkpointId: string): Promise<void> {
  // A row lock alone does not refresh a SERIALIZABLE snapshot taken before a
  // competing hold writer commits. Touch the existing Session row, without
  // changing any logical state or history, so that stale contenders receive
  // 40001 and retry the whole decision through the existing request owner.
  await client.query(`UPDATE codeops.sessions SET generation=generation
    WHERE session_id=(SELECT session_id FROM codeops.workspace_checkpoint_descriptors
      WHERE checkpoint_id=$1)`, [checkpointId]);
}

async function lockLiveWorkspace(client: TransactionClient, sessionId: string) {
  const session = (await client.query<{ generation: unknown; snapshot_json: unknown }>(
    `SELECT generation,snapshot_json FROM codeops.sessions
      WHERE session_id=$1 FOR UPDATE`, [sessionId])).rows[0];
  const snapshot = session?.snapshot_json as Record<string, unknown> | undefined;
  const identity = snapshot?.identity as Record<string, unknown> | undefined;
  // A resume advances the Session lease, not the immutable Job generation.
  // A newer reconciled Job supersedes that binding; never invent a storage UID.
  const progress = (await client.query<{ job_uid: unknown;
    resource_configuration_digest: unknown; run_id: unknown }>(
    `SELECT job_uid,resource_configuration_digest,run_id
       FROM codeops.session_runtime_job_progress
      WHERE session_id=$1 AND generation <= $2
      ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
    [sessionId, session?.generation])).rows[0];
  if (!snapshot || snapshot.sessionId !== sessionId ||
      snapshot.generation !== Number(session?.generation) ||
      identity?.version !== "codeops.session-workspace-identity/v1" ||
      progress?.run_id !== identity.runId || typeof progress?.job_uid !== "string" ||
      typeof progress.resource_configuration_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(progress.resource_configuration_digest)) {
    throw new Error("workspace requires exact live Session and reconciled Job state");
  }
  return { snapshot, generation: Number(session!.generation),
    jobUid: progress.job_uid,
    resourceConfigurationDigest: progress.resource_configuration_digest,
    workspaceConfigurationDigest: sha256CanonicalJsonDigest({ workspace: identity.workspace,
      policy: identity.policy }),
    workspaceManifestDigest: sha256CanonicalJsonDigest(identity.workspace) };
}

async function lockCheckpointClaim(client: TransactionClient,
  input: { dispatchId: string; claimToken: string; workerId: string },
  allowedCommandTypes: readonly ("checkpoint" | "hibernate" | "resume")[]) {
  await client.query(`SELECT dispatch_id FROM codeops.session_runtime_outbox
    WHERE dispatch_id=$1 FOR UPDATE`, [input.dispatchId]);
  const now = await databaseClock(client);
  const authority = await loadClaimedDispatchAuthority(client, {
    ...input, now: () => new Date(now), allowedCommandTypes, requireClaimCount: true,
  });
  const live = await lockLiveWorkspace(client, authority.dispatch.command.sessionId);
  // Budget is a read-time ledger projection. Its existing completion owner
  // fences it; artifact access binds the durable lifecycle snapshot instead.
  const { budget: _claimedBudget, ...claimedSnapshot } = authority.snapshot;
  const { budget: _liveBudget, ...liveSnapshot } = live.snapshot;
  if (Date.parse(await databaseClock(client)) >= Date.parse(authority.claimExpiresAt) ||
      canonicalJsonText(liveSnapshot) !== canonicalJsonText(claimedSnapshot)) {
    throw new Error("checkpoint claim no longer binds the live Session snapshot");
  }
  return { authority, live };
}

export async function loadClaimedCheckpointWorkspaceBinding(
  client: TransactionClient,
  input: { readonly dispatchId: string; readonly claimToken: string;
    readonly workerId: string },
): Promise<{ readonly jobUid: string;
  readonly resourceConfigurationDigest: string;
  readonly workspaceConfigurationDigest: string }> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const { live } = await lockCheckpointClaim(client, input, ["checkpoint", "hibernate"]);
    await client.query("COMMIT");
    return { jobUid: live.jobUid,
      resourceConfigurationDigest: live.resourceConfigurationDigest,
      workspaceConfigurationDigest: live.workspaceConfigurationDigest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const recoveryChunkBytes = 512 * 1024;

export async function readClaimedCheckpointRecovery(
  client: TransactionClient,
  input: { readonly dispatchId: string; readonly claimToken: string;
    readonly workerId: string; readonly artifactId?: string;
    readonly offset?: number },
): Promise<Record<string, unknown>> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const { authority, live } = await lockCheckpointClaim(client, input, ["resume"]);
    const checkpointId = authority.snapshot.checkpoint?.checkpointId;
    if (checkpointId === undefined) {
      throw new Error("claimed resume has no exact checkpoint");
    }
    const stored = (await client.query<{ readonly descriptor_json: unknown }>(
      `SELECT descriptor_json FROM codeops.workspace_checkpoint_descriptors
        WHERE checkpoint_id=$1 FOR SHARE`, [checkpointId])).rows[0];
    if (!stored) throw new Error("legacy checkpoint is not verified recovery evidence");
    const descriptor = checkpointDescriptorSchema.parse(stored.descriptor_json);
    if (descriptor.manifest.binding.sessionId !== authority.dispatch.command.sessionId ||
          descriptor.manifest.binding.generation > authority.dispatch.command.generation ||
          descriptor.manifest.binding.workspaceConfigurationDigest !== live.workspaceConfigurationDigest ||
          descriptor.manifest.binding.workspaceManifestDigest !== live.workspaceManifestDigest ||
          descriptor.manifestDigest !== sha256CanonicalJsonDigest(descriptor.manifest)) {
      throw new Error("restore descriptor drifted from the claimed workspace");
    }
    if (input.artifactId === undefined) {
      const progress = { job_uid: live.jobUid,
        resource_configuration_digest: live.resourceConfigurationDigest };
      const workspaceConfigurationDigest = live.workspaceConfigurationDigest;
      const proposedOperationId = randomUUID();
      const inserted = await client.query<{
        readonly restore_operation_id: unknown;
        readonly dispatch_id?: unknown; readonly session_id?: unknown;
        readonly source_generation?: unknown; readonly workspace_job_uid?: unknown;
        readonly resource_configuration_digest?: unknown;
        readonly workspace_configuration_digest?: unknown;
        readonly restored_path_set_digest?: unknown }>(
        `INSERT INTO codeops.workspace_checkpoint_restore_operations
          (restore_operation_id,checkpoint_id,dispatch_id,session_id,
           source_generation,workspace_job_uid,resource_configuration_digest,
           workspace_configuration_digest,restored_path_set_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (dispatch_id) DO NOTHING
         RETURNING restore_operation_id`,
        [proposedOperationId,checkpointId,input.dispatchId,
          authority.dispatch.command.sessionId,authority.dispatch.command.generation,
          progress.job_uid,progress.resource_configuration_digest,
          workspaceConfigurationDigest,descriptor.manifest.pathSetDigest]);
      const operation = inserted.rows[0] ?? (await client.query<{
        readonly restore_operation_id: unknown;
        readonly dispatch_id: unknown; readonly session_id: unknown;
        readonly source_generation: unknown; readonly workspace_job_uid: unknown;
        readonly resource_configuration_digest: unknown;
        readonly workspace_configuration_digest: unknown;
        readonly restored_path_set_digest: unknown }>(
        `SELECT restore_operation_id,dispatch_id,session_id,
                source_generation,workspace_job_uid,
                resource_configuration_digest,workspace_configuration_digest,
                restored_path_set_digest
           FROM codeops.workspace_checkpoint_restore_operations
          WHERE dispatch_id=$1 FOR UPDATE`, [input.dispatchId])).rows[0];
      if (operation?.dispatch_id !== undefined && (
          operation.dispatch_id !== input.dispatchId ||
          operation.session_id !== authority.dispatch.command.sessionId ||
          Number(operation.source_generation) !== authority.dispatch.command.generation ||
          operation.workspace_job_uid !== progress.job_uid ||
          operation.resource_configuration_digest !==
            progress.resource_configuration_digest ||
          operation.workspace_configuration_digest !== workspaceConfigurationDigest ||
          operation.restored_path_set_digest !== descriptor.manifest.pathSetDigest)) {
        throw new Error("checkpoint restore operation replay drifted");
      }
      await client.query("COMMIT");
      return { version: "codeops.checkpoint-recovery-read/v1", descriptor,
        restoreOperationId:
          String(operation!.restore_operation_id),
        workspaceBinding: { jobUid: progress.job_uid,
          resourceConfigurationDigest:
            progress.resource_configuration_digest,
          workspaceConfigurationDigest } };
    }
    const expected = [...descriptor.manifest.sourcePatches,
      descriptor.manifest.scratchArtifact].find(({ artifactId }) =>
      artifactId === input.artifactId);
    const offset = input.offset ?? 0;
    if (!expected || !Number.isSafeInteger(offset) || offset < 0 ||
        offset > expected.bytes) {
      throw new Error("checkpoint artifact read is outside its exact claim");
    }
    const artifact = (await client.query<{ readonly artifact_digest: unknown;
      readonly artifact_bytes: unknown; readonly artifact_content: unknown }>(
      `SELECT artifact_digest,artifact_bytes,
              substring(artifact_content FROM $2 FOR $3) AS artifact_content
         FROM codeops.workspace_checkpoint_artifacts
        WHERE artifact_id=$1 AND checkpoint_id=$4 FOR SHARE`,
      [input.artifactId, offset + 1, recoveryChunkBytes, checkpointId])).rows[0];
    if (!artifact || artifact.artifact_digest !== expected.digest ||
        Number(artifact.artifact_bytes) !== expected.bytes ||
        !(artifact.artifact_content instanceof Buffer)) {
      throw new Error("checkpoint artifact durable readback drifted");
    }
    const nextOffset = offset + artifact.artifact_content.byteLength;
    await client.query("COMMIT");
    return { version: "codeops.checkpoint-recovery-read/v1",
      artifactId: input.artifactId, offset,
      contentBase64: artifact.artifact_content.toString("base64"),
      nextOffset, complete: nextOffset === expected.bytes,
      bytes: expected.bytes, digest: expected.digest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function finalizeVerifiedCheckpoint(
  client: TransactionClient,
  input: {
    readonly descriptor: unknown;
    readonly result: SessionCommandResult;
    readonly finalizedAt: string;
  },
): Promise<CheckpointReceipt> {
  const descriptor = checkpointDescriptorSchema.parse(input.descriptor);
  const manifest = descriptor.manifest;
  if (descriptor.manifestDigest !== sha256CanonicalJsonDigest(manifest) ||
      !["committed", "duplicate"].includes(input.result.disposition) ||
      input.result.sessionId !== manifest.binding.sessionId ||
      input.result.generation !== manifest.binding.generation ||
      input.result.snapshot.checkpoint?.checkpointId !== manifest.checkpointId) {
    throw new Error("checkpoint descriptor does not match the committed Session result");
  }
  const artifacts = [...manifest.sourcePatches, manifest.scratchArtifact];
  const live = await lockLiveWorkspace(client, manifest.binding.sessionId);
  if (live.generation !== manifest.binding.generation ||
      live.jobUid !== manifest.binding.workspaceJobUid ||
      live.resourceConfigurationDigest !== manifest.binding.resourceConfigurationDigest ||
      live.workspaceConfigurationDigest !== manifest.binding.workspaceConfigurationDigest ||
      live.workspaceManifestDigest !== manifest.binding.workspaceManifestDigest) {
    throw new Error("checkpoint workspace binding does not match durable live Job state");
  }
  const workspace = (live.snapshot.identity as { workspace: { scratchPath: string; sources: {
    catalogKey: string; repository: string; checkoutPath: string; resolvedSha: string;
  }[] } }).workspace;
  if (canonicalJsonText(manifest.sourcePatches.map(source => ({ catalogKey: source.catalogKey,
    repository: source.repository, checkoutPath: source.checkoutPath, baseSha: source.baseSha }))) !==
      canonicalJsonText(workspace.sources.map(source => ({ catalogKey: source.catalogKey,
        repository: source.repository, checkoutPath: source.checkoutPath, baseSha: source.resolvedSha })))) {
    throw new Error("checkpoint source paths do not match the live workspace manifest");
  }
  const readback = await client.query<{
    readonly artifact_id: unknown; readonly session_id: unknown;
    readonly generation: unknown; readonly checkpoint_id: unknown;
    readonly artifact_digest: unknown; readonly artifact_bytes: unknown;
    readonly artifact_content: unknown;
  }>(`SELECT artifact_id,session_id,generation,checkpoint_id,
             artifact_digest,artifact_bytes,artifact_content
        FROM codeops.workspace_checkpoint_artifacts
       WHERE checkpoint_id=$1
       ORDER BY artifact_id
       FOR SHARE`, [manifest.checkpointId]);
  const rows = [...readback.rows].sort((left, right) =>
    String(left.artifact_id).localeCompare(String(right.artifact_id)));
  const expected = [...artifacts].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId));
  if (rows.length !== expected.length || rows.some((row, index) => {
    const artifact = expected[index]!;
    return row.artifact_id !== artifact.artifactId ||
      row.session_id !== manifest.binding.sessionId ||
      Number(row.generation) !== manifest.binding.generation ||
      row.checkpoint_id !== manifest.checkpointId ||
      row.artifact_digest !== artifact.digest ||
      Number(row.artifact_bytes) !== artifact.bytes ||
      !(row.artifact_content instanceof Buffer) ||
      row.artifact_content.byteLength !== artifact.bytes ||
      `sha256:${createHash("sha256").update(row.artifact_content).digest("hex")}` !== artifact.digest;
  })) {
    throw new Error("checkpoint artifact live readback is incomplete or stale");
  }
  const scratch = rows.find(row => row.artifact_id === manifest.scratchArtifact.artifactId)!;
  const bundle = JSON.parse((scratch.artifact_content as Buffer).toString("utf8")) as {
    version?: unknown; entries?: Record<string, unknown>[];
  };
  if (bundle?.version !== "codeops.scratch-artifact/v1" || !Array.isArray(bundle.entries) ||
      bundle.entries.length > 10_000 || bundle.entries[0]?.path !== "." ||
      bundle.entries[0]?.type !== "directory") {
    throw new Error("checkpoint scratch artifact manifest is invalid");
  }
  let contentBytes = 0;
  let pathBytes = 1;
  const paths = [
    ...manifest.sourcePatches.map(source => checkpointPathEntrySchema.parse({
      path: source.checkoutPath, type: "file", bytes: source.bytes,
      digest: source.digest, executable: false,
    })),
    ...bundle.entries.slice(1).map(entry => {
      if (!entry || typeof entry.path !== "string") throw new Error("checkpoint scratch path is invalid");
      pathBytes += Buffer.byteLength(entry.path);
      const path = `${workspace.scratchPath}/${entry.path}`;
      if (entry.type === "directory") return checkpointPathEntrySchema.parse({ path, type: "directory", bytes: 0 });
      if (entry.type !== "file" || typeof entry.contentBase64 !== "string") {
        throw new Error("checkpoint scratch artifact contains a special file");
      }
      const content = Buffer.from(entry.contentBase64, "base64");
      contentBytes += content.byteLength;
      if (content.toString("base64") !== entry.contentBase64 || entry.bytes !== content.byteLength ||
          entry.digest !== `sha256:${createHash("sha256").update(content).digest("hex")}`) {
        throw new Error("checkpoint scratch content drifted from its path manifest");
      }
      return checkpointPathEntrySchema.parse({ path, type: "file", bytes: entry.bytes,
        digest: entry.digest, executable: entry.executable });
    }),
  ];
  if (contentBytes > 10_000_000 || pathBytes > 2_000_000 || paths.length !== manifest.pathCount ||
      new Set(paths.map(entry => entry.path)).size !== paths.length ||
      sha256CanonicalJsonDigest(paths) !== manifest.pathSetDigest) {
    throw new Error("checkpoint artifact path set does not match its descriptor");
  }
  const descriptorDigest = sha256CanonicalJsonDigest(descriptor);
  const finalizedAt = await databaseClock(client);
  const receipt = checkpointReceiptSchema.parse({
    version: "codeops.checkpoint-receipt/v1",
    checkpointId: manifest.checkpointId,
    binding: manifest.binding,
    descriptorDigest,
    manifestDigest: descriptor.manifestDigest,
    issuedAt: finalizedAt,
  });
  const inserted = await client.query<{ readonly checkpoint_receipt_json: unknown }>(
    `INSERT INTO codeops.workspace_checkpoint_descriptors
       (checkpoint_id,session_id,generation,workspace_job_uid,
        resource_configuration_digest,workspace_configuration_digest,
        workspace_manifest_digest,
        descriptor_digest,manifest_digest,descriptor_json,
        checkpoint_receipt_json,checkpoint_receipt_digest,finalized_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::timestamptz)
     ON CONFLICT (checkpoint_id) DO NOTHING
     RETURNING checkpoint_receipt_json`,
    [manifest.checkpointId, manifest.binding.sessionId, manifest.binding.generation,
      manifest.binding.workspaceJobUid, manifest.binding.resourceConfigurationDigest,
      manifest.binding.workspaceConfigurationDigest,
      manifest.binding.workspaceManifestDigest, descriptorDigest,
      descriptor.manifestDigest, canonicalJsonText(descriptor), canonicalJsonText(receipt),
      sha256CanonicalJsonDigest(receipt), finalizedAt],
  );
  const stored = inserted.rows[0] ?? (await client.query<{
    readonly checkpoint_receipt_json: unknown;
  }>(`SELECT checkpoint_receipt_json
        FROM codeops.workspace_checkpoint_descriptors
       WHERE checkpoint_id=$1 FOR UPDATE`, [manifest.checkpointId])).rows[0];
  const replay = checkpointReceiptSchema.parse(stored?.checkpoint_receipt_json);
  if (canonicalJsonText({ ...replay, issuedAt: receipt.issuedAt }) !== canonicalJsonText(receipt)) {
    throw new Error("checkpoint receipt replay conflicts with durable evidence");
  }
  return replay;
}

export async function recordRestoreReceiptInCompletionTransaction(
  client: TransactionClient,
  input: { readonly checkpointId: string; readonly dispatchId?: string },
): Promise<RestoreReceipt> {
  const row = (await client.query<{ descriptor_json: unknown; checkpoint_receipt_json: unknown }>(
    `SELECT descriptor_json,checkpoint_receipt_json FROM codeops.workspace_checkpoint_descriptors
      WHERE checkpoint_id=$1 FOR UPDATE`, [input.checkpointId])).rows[0];
  if (!row) throw new Error("legacy checkpoint is not verified recovery evidence");
  const descriptor = checkpointDescriptorSchema.parse(row.descriptor_json);
  const checkpointReceipt = checkpointReceiptSchema.parse(row.checkpoint_receipt_json);
  const operation = (await client.query<{ restore_operation_id: unknown; dispatch_id: unknown;
    session_id: unknown; source_generation: unknown; workspace_job_uid: unknown;
    resource_configuration_digest: unknown; workspace_configuration_digest: unknown;
    restored_path_set_digest: unknown }>(
    `SELECT * FROM codeops.workspace_checkpoint_restore_operations
      WHERE checkpoint_id=$1 AND ($2::uuid IS NULL OR dispatch_id=$2)
      ORDER BY source_generation DESC,created_at DESC LIMIT 1 FOR UPDATE`,
    [input.checkpointId, input.dispatchId ?? null])).rows[0];
  if (!operation) throw new Error("restore operation is missing");
  const live = await lockLiveWorkspace(client, descriptor.manifest.binding.sessionId);
  const outbox = (await client.query<{ status: unknown; dispatch_json: unknown;
    completion_json: unknown; result_json: unknown }>(
    `SELECT status,dispatch_json,completion_json,result_json FROM codeops.session_runtime_outbox
      WHERE dispatch_id=$1 FOR UPDATE`, [operation.dispatch_id])).rows[0];
  const execution = (await client.query<{ status: unknown; result_json: unknown;
    dispatch_digest: unknown }>(
    `SELECT status,result_json,dispatch_digest FROM codeops.session_runtime_execution_receipts
      WHERE dispatch_id=$1 FOR UPDATE`, [operation.dispatch_id])).rows[0];
  const dispatch = sessionRuntimeDispatchSchema.parse(outbox?.dispatch_json);
  const completion = outbox?.completion_json as Record<string, unknown> | undefined;
  const material = completion?.material as Record<string, unknown> | undefined;
  const verification = material?.restoreVerification as Record<string, unknown> | undefined;
  const result = outbox?.result_json as Record<string, unknown> | undefined;
  const resultSnapshot = result?.snapshot as Record<string, unknown> | undefined;
  const checkpoint = live.snapshot.checkpoint as Record<string, unknown> | undefined;
  if (outbox?.status !== "completed" || execution?.status !== "completed" ||
      result?.disposition !== "committed" || dispatch.command.type !== "resume" ||
      dispatch.command.sessionId !== live.snapshot.sessionId ||
      dispatch.snapshot.checkpoint?.checkpointId !== input.checkpointId ||
      dispatch.command.generation !== Number(operation.source_generation) ||
      live.generation !== Number(operation.source_generation) + 1 ||
      resultSnapshot?.generation !== live.generation ||
      checkpoint?.checkpointId !== input.checkpointId ||
      operation.session_id !== descriptor.manifest.binding.sessionId ||
      operation.workspace_job_uid !== live.jobUid ||
      operation.resource_configuration_digest !== live.resourceConfigurationDigest ||
      operation.workspace_configuration_digest !== live.workspaceConfigurationDigest ||
      descriptor.manifest.binding.workspaceConfigurationDigest !== live.workspaceConfigurationDigest ||
      descriptor.manifest.binding.workspaceManifestDigest !== live.workspaceManifestDigest ||
      operation.restored_path_set_digest !== descriptor.manifest.pathSetDigest ||
      verification?.operationId !== operation.restore_operation_id ||
      !verification?.descriptor ||
      canonicalJsonText(verification.descriptor) !== canonicalJsonText(descriptor) ||
      descriptor.manifestDigest !== sha256CanonicalJsonDigest(descriptor.manifest) ||
      checkpointReceipt.descriptorDigest !== sha256CanonicalJsonDigest(descriptor) ||
      checkpointReceipt.manifestDigest !== descriptor.manifestDigest ||
      canonicalJsonText(checkpointReceipt.binding) !== canonicalJsonText(descriptor.manifest.binding) ||
      execution.dispatch_digest !== `sha256:${createHash("sha256")
        .update(JSON.stringify(dispatch)).digest("hex")}` ||
      canonicalJsonText(execution.result_json) !== canonicalJsonText({ type: "resume", material })) {
    throw new Error("restore verification does not match committed execution and live workspace state");
  }
  const prior = (await client.query<{ restore_receipt_json: unknown }>(
    `SELECT restore_receipt_json FROM codeops.workspace_checkpoint_restore_receipts
      WHERE restore_operation_id=$1 FOR UPDATE`, [operation.restore_operation_id])).rows[0];
  const receipt = restoreReceiptSchema.parse({
    version: "codeops.restore-receipt/v1", checkpointId: input.checkpointId,
    binding: descriptor.manifest.binding,
    descriptorDigest: checkpointReceipt.descriptorDigest,
    manifestDigest: descriptor.manifestDigest,
    restoreOperationId: operation.restore_operation_id,
    restoredWorkspaceJobUid: live.jobUid,
    restoredResourceConfigurationDigest: live.resourceConfigurationDigest,
    restoredGeneration: live.generation, restoredPathSetDigest: descriptor.manifest.pathSetDigest,
    restoredAt: prior ? restoreReceiptSchema.parse(prior.restore_receipt_json).restoredAt
      : await databaseClock(client),
  });
  if (prior) {
    if (canonicalJsonText(prior.restore_receipt_json) !== canonicalJsonText(receipt)) {
      throw new Error("restore receipt replay conflicts with durable evidence");
    }
    return receipt;
  }
  await client.query(`INSERT INTO codeops.workspace_checkpoint_restore_receipts
    (checkpoint_id,session_id,generation,restore_operation_id,restored_workspace_job_uid,
     restored_resource_configuration_digest,restored_generation,restore_receipt_digest,
     restore_receipt_json,restored_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`,
    [receipt.checkpointId,receipt.binding.sessionId,receipt.binding.generation,
      receipt.restoreOperationId,receipt.restoredWorkspaceJobUid,
      receipt.restoredResourceConfigurationDigest,receipt.restoredGeneration,
      sha256CanonicalJsonDigest(receipt),canonicalJsonText(receipt),receipt.restoredAt]);
  return receipt;
}

export async function recordRestoreReceipt(
  client: TransactionClient,
  input: { readonly checkpointId: string },
): Promise<RestoreReceipt> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const receipt = await recordRestoreReceiptInCompletionTransaction(client, input);
    await client.query("COMMIT");
    return receipt;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function appendHoldEvent(
  client: TransactionClient,
  input: { readonly operator: AuthenticatedCheckpointOperator;
    readonly checkpointId: string; readonly action: "placed" | "released";
    readonly reason: string; readonly eventId?: string },
): Promise<CheckpointHoldEvent> {
  requireOperator(input.operator);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await fenceCheckpointAuthority(client, input.checkpointId);
    await client.query(`SELECT checkpoint_id FROM codeops.workspace_checkpoint_descriptors
      WHERE checkpoint_id=$1 FOR UPDATE`, [input.checkpointId]);
    if (input.eventId !== undefined) {
      const replayed = (await client.query<{ readonly event_json: unknown }>(
        `SELECT event_json FROM codeops.workspace_checkpoint_hold_events
          WHERE event_id=$1 FOR UPDATE`, [input.eventId])).rows[0];
      if (replayed) {
        const replay = checkpointHoldEventSchema.parse(replayed.event_json);
        if (replay.checkpointId !== input.checkpointId || replay.action !== input.action ||
            replay.operatorPrincipalId !== input.operator.principalId ||
            replay.reason !== input.reason) {
          throw new Error("checkpoint hold event replay conflicts with durable evidence");
        }
        await client.query("COMMIT");
        return replay;
      }
    }
    const latest = (await client.query<{ readonly revision: unknown;
      readonly action: unknown }>(
      `SELECT revision,action
         FROM codeops.workspace_checkpoint_hold_events
        WHERE checkpoint_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [input.checkpointId])).rows[0];
    if (input.action === "placed" && latest?.action === "placed" ||
        input.action === "released" && latest?.action !== "placed") {
      throw new Error(`checkpoint hold cannot be ${input.action}`);
    }
    const databaseNow = (await client.query<{ readonly database_now: unknown }>(
      "SELECT clock_timestamp() AS database_now")).rows[0]!.database_now;
    const event = checkpointHoldEventSchema.parse({
      version: "codeops.checkpoint-hold-event/v1",
      eventId: input.eventId ?? randomUUID(), checkpointId: input.checkpointId,
      revision: Number(latest?.revision ?? 0) + 1, action: input.action,
      operatorPrincipalId: input.operator.principalId,
      reason: input.reason,
      occurredAt: databaseNow instanceof Date
        ? databaseNow.toISOString() : String(databaseNow),
    });
    await client.query(`INSERT INTO codeops.workspace_checkpoint_hold_events
      (event_id,checkpoint_id,revision,action,operator_principal_id,event_json,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
      [event.eventId,event.checkpointId,event.revision,event.action,
        event.operatorPrincipalId,canonicalJsonText(event),event.occurredAt]);
    await client.query("COMMIT");
    return event;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export const placeCheckpointHold = (client: TransactionClient,
  input: Omit<Parameters<typeof appendHoldEvent>[1], "action">) =>
  appendHoldEvent(client, { ...input, action: "placed" });
export const releaseCheckpointHold = (client: TransactionClient,
  input: Omit<Parameters<typeof appendHoldEvent>[1], "action">) =>
  appendHoldEvent(client, { ...input, action: "released" });

export async function configureCheckpointRetention(
  client: TransactionClient,
  input: { readonly operator: AuthenticatedCheckpointOperator;
    readonly checkpointId: string; readonly retainForSeconds: number;
    readonly authorityForSeconds: number; readonly decisionId?: string },
): Promise<CheckpointRetentionDecision> {
  requireOperator(input.operator);
  if (!Number.isSafeInteger(input.retainForSeconds) || input.retainForSeconds < 1 ||
      input.retainForSeconds > 31_536_000 ||
      !Number.isSafeInteger(input.authorityForSeconds) ||
      input.authorityForSeconds < 1 || input.authorityForSeconds > 86_400) {
    throw new Error("retention durations are outside their bounded policy range");
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await fenceCheckpointAuthority(client, input.checkpointId);
    await client.query(`SELECT checkpoint_id FROM codeops.workspace_checkpoint_descriptors
      WHERE checkpoint_id=$1 FOR UPDATE`, [input.checkpointId]);
    if (input.decisionId !== undefined) {
      const replayed = (await client.query<{ readonly decision_json: unknown }>(
        `SELECT decision_json FROM codeops.workspace_checkpoint_retention_decisions
          WHERE decision_id=$1 FOR UPDATE`, [input.decisionId])).rows[0];
      if (replayed) {
        const replay = checkpointRetentionDecisionSchema.parse(replayed.decision_json);
        if (replay.checkpointId !== input.checkpointId ||
            replay.operatorPrincipalId !== input.operator.principalId ||
            (Date.parse(replay.retainUntil) - Date.parse(replay.decidedAt)) / 1000 !==
              input.retainForSeconds ||
            (Date.parse(replay.expiresAt) - Date.parse(replay.retainUntil)) / 1000 !==
              input.authorityForSeconds) {
          throw new Error("retention decision replay conflicts with durable evidence");
        }
        await client.query("COMMIT");
        return replay;
      }
    }
    const latest = (await client.query<{ readonly policy_revision: unknown }>(
      `SELECT policy_revision
         FROM codeops.workspace_checkpoint_retention_decisions
        WHERE checkpoint_id=$1 ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE`,
      [input.checkpointId])).rows[0];
    const databaseNow = (await client.query<{ readonly database_now: unknown }>(
      "SELECT clock_timestamp() AS database_now")).rows[0]!.database_now;
    const decidedAt = databaseNow instanceof Date
      ? databaseNow : new Date(String(databaseNow));
    const retainUntil = new Date(decidedAt.getTime() + input.retainForSeconds * 1000);
    const decision = checkpointRetentionDecisionSchema.parse({
      version: "codeops.checkpoint-retention-decision/v1",
      decisionId: input.decisionId ?? randomUUID(), checkpointId: input.checkpointId,
      policyRevision: Number(latest?.policy_revision ?? 0) + 1, configured: true,
      decidedAt: decidedAt.toISOString(), retainUntil: retainUntil.toISOString(),
      expiresAt: new Date(retainUntil.getTime() +
        input.authorityForSeconds * 1000).toISOString(),
      operatorPrincipalId: input.operator.principalId,
    });
    const inserted = await client.query<{ readonly decision_json: unknown }>(
      `INSERT INTO codeops.workspace_checkpoint_retention_decisions
      (decision_id,checkpoint_id,policy_revision,decision_json,retain_until,expires_at,decided_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz,$6::timestamptz,$7::timestamptz)
      ON CONFLICT (decision_id) DO NOTHING RETURNING decision_json`,
      [decision.decisionId,decision.checkpointId,decision.policyRevision,
        canonicalJsonText(decision),decision.retainUntil,decision.expiresAt,decision.decidedAt]);
    if (!inserted.rows[0]) {
      const replay = checkpointRetentionDecisionSchema.parse((await client.query<{
        readonly decision_json: unknown }>(
        `SELECT decision_json FROM codeops.workspace_checkpoint_retention_decisions
          WHERE decision_id=$1 FOR UPDATE`, [decision.decisionId])).rows[0]?.decision_json);
      if (canonicalJsonText(replay) !== canonicalJsonText(decision)) {
        throw new Error("retention decision replay conflicts with durable evidence");
      }
    }
    await client.query("COMMIT");
    return decision;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

interface CleanupEvidence {
  readonly descriptor: CheckpointDescriptor;
  readonly checkpointReceipt: CheckpointReceipt | null;
  readonly restoreReceipt: RestoreReceipt | null;
  readonly retentionDecision: CheckpointRetentionDecision | null;
  readonly holdEvents: readonly CheckpointHoldEvent[];
  readonly live: {
    readonly sessionId: string; readonly generation: number;
    readonly state: "queued" | "running" | "waiting_permission" | "checkpointing" |
      "hibernated" | "completed" | "failed" | "cancelled" | "archived";
    readonly checkpointId: string | null; readonly workspaceJobUid: string;
    readonly resourceConfigurationDigest: string;
    readonly workspaceConfigurationDigest: string;
    readonly workspaceManifestDigest: string;
  };
}

export function evaluateCheckpointCleanup(input: {
  readonly evidence: CleanupEvidence; readonly now: string;
  readonly decisionId?: string;
}): CheckpointCleanupDecision {
  const { evidence } = input;
  const refused = (reason: Extract<CheckpointCleanupDecision,
    { authorized: false }>["reason"]): CheckpointCleanupDecision =>
    checkpointCleanupDecisionSchema.parse({
      version: "codeops.checkpoint-cleanup-decision/v1",
      decisionId: input.decisionId ?? randomUUID(),
      checkpointId: evidence.descriptor.manifest.checkpointId,
      authorized: false, reason, decidedAt: input.now,
    });
  if (evidence.retentionDecision === null) return refused("policy-not-configured");
  const binding = evidence.descriptor.manifest.binding;
  if (evidence.checkpointReceipt === null) return refused("checkpoint-receipt-missing");
  if (evidence.restoreReceipt === null) return refused("restore-receipt-missing");
  const descriptorDigest = sha256CanonicalJsonDigest(evidence.descriptor);
  if (evidence.descriptor.manifestDigest !== sha256CanonicalJsonDigest(evidence.descriptor.manifest) ||
      evidence.checkpointReceipt.checkpointId !== evidence.descriptor.manifest.checkpointId ||
      evidence.restoreReceipt.checkpointId !== evidence.descriptor.manifest.checkpointId ||
      evidence.retentionDecision.checkpointId !== evidence.descriptor.manifest.checkpointId ||
      evidence.checkpointReceipt.manifestDigest !== evidence.descriptor.manifestDigest ||
      evidence.restoreReceipt.manifestDigest !== evidence.descriptor.manifestDigest ||
      evidence.restoreReceipt.restoredPathSetDigest !== evidence.descriptor.manifest.pathSetDigest ||
      evidence.checkpointReceipt.descriptorDigest !== descriptorDigest ||
      evidence.restoreReceipt.descriptorDigest !== descriptorDigest ||
      canonicalJsonText(evidence.checkpointReceipt.binding) !== canonicalJsonText(binding) ||
      canonicalJsonText(evidence.restoreReceipt.binding) !== canonicalJsonText(binding)) {
    return refused("receipt-mismatch");
  }
  if (evidence.live.sessionId !== binding.sessionId ||
      evidence.live.checkpointId !== evidence.descriptor.manifest.checkpointId ||
      evidence.live.workspaceConfigurationDigest !==
        binding.workspaceConfigurationDigest ||
      evidence.live.workspaceManifestDigest !== binding.workspaceManifestDigest) {
    return refused("stale-readback");
  }
  if (evidence.live.generation !== evidence.restoreReceipt.restoredGeneration ||
      evidence.live.workspaceJobUid !==
        evidence.restoreReceipt.restoredWorkspaceJobUid ||
      evidence.live.resourceConfigurationDigest !==
        evidence.restoreReceipt.restoredResourceConfigurationDigest) {
    return refused("later-generation");
  }
  if (!["completed", "failed", "cancelled", "archived"].includes(evidence.live.state)) {
    return refused("session-not-terminal");
  }
  const latestHold = [...evidence.holdEvents].sort((a, b) => b.revision - a.revision)[0];
  if (latestHold?.action === "placed") return refused("active-hold");
  const now = Date.parse(input.now);
  if (now < Date.parse(evidence.retentionDecision.retainUntil)) {
    return refused("retention-not-expired");
  }
  if (now >= Date.parse(evidence.retentionDecision.expiresAt)) {
    return refused("retention-expired");
  }
  return checkpointCleanupDecisionSchema.parse({
    version: "codeops.checkpoint-cleanup-decision/v1",
    decisionId: input.decisionId ?? randomUUID(),
    checkpointId: evidence.descriptor.manifest.checkpointId,
    authorized: true,
    checkpointReceipt: evidence.checkpointReceipt,
    restoreReceipt: evidence.restoreReceipt,
    retentionDecision: evidence.retentionDecision,
    holdRevision: latestHold?.revision ?? 0,
    retentionRevision: evidence.retentionDecision.policyRevision,
    liveGeneration: evidence.live.generation,
    decidedAt: input.now,
    consumedAt: input.now,
  });
}

async function lockCleanupEvidence(client: TransactionClient, checkpointId: string): Promise<CleanupEvidence | null> {
  // Hold and policy writers take this same parent lock, including when no
  // revision exists yet. Serializable conflicts are retried by the caller.
  await fenceCheckpointAuthority(client, checkpointId);
  const row = (await client.query<{ descriptor_json: unknown; checkpoint_receipt_json: unknown }>(
    `SELECT descriptor_json,checkpoint_receipt_json FROM codeops.workspace_checkpoint_descriptors
      WHERE checkpoint_id=$1 FOR UPDATE`, [checkpointId])).rows[0];
  if (!row) return null;
  const descriptor = checkpointDescriptorSchema.parse(row.descriptor_json);
  const live = await lockLiveWorkspace(client, descriptor.manifest.binding.sessionId);
  const restore = (await client.query<{ restore_receipt_json: unknown }>(
    `SELECT restore_receipt_json FROM codeops.workspace_checkpoint_restore_receipts
      WHERE checkpoint_id=$1 ORDER BY restored_generation DESC LIMIT 1 FOR UPDATE`, [checkpointId])).rows[0];
  const receipt = restore ? restoreReceiptSchema.parse(restore.restore_receipt_json) : null;
  const operation = (await client.query<{ restore_operation_id: unknown; workspace_job_uid: unknown;
    resource_configuration_digest: unknown; source_generation: unknown }>(
    `SELECT restore_operation_id,workspace_job_uid,resource_configuration_digest,source_generation
       FROM codeops.workspace_checkpoint_restore_operations WHERE restore_operation_id=$1 FOR UPDATE`,
    [receipt?.restoreOperationId ?? null])).rows[0];
  if (receipt && (!operation || operation.restore_operation_id !== receipt.restoreOperationId ||
      operation.workspace_job_uid !== receipt.restoredWorkspaceJobUid ||
      operation.resource_configuration_digest !== receipt.restoredResourceConfigurationDigest ||
      Number(operation.source_generation) + 1 !== receipt.restoredGeneration)) {
    throw new Error("restore receipt operation binding drifted");
  }
  const retention = (await client.query<{ decision_json: unknown }>(
    `SELECT decision_json FROM codeops.workspace_checkpoint_retention_decisions
      WHERE checkpoint_id=$1 ORDER BY policy_revision DESC LIMIT 1 FOR UPDATE`, [checkpointId])).rows[0];
  const hold = (await client.query<{ event_json: unknown }>(
    `SELECT event_json FROM codeops.workspace_checkpoint_hold_events
      WHERE checkpoint_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [checkpointId])).rows[0];
  const recovering = await client.query(`SELECT dispatch_id FROM codeops.session_runtime_outbox
    WHERE session_id=$1 AND status IN ('pending','claimed')
      AND dispatch_json#>>'{command,type}'='resume'
      AND (dispatch_json#>>'{command,generation}')::bigint=$2 FOR UPDATE`,
    [live.snapshot.sessionId, live.generation]);
  return { descriptor, checkpointReceipt: checkpointReceiptSchema.parse(row.checkpoint_receipt_json),
    restoreReceipt: receipt,
    retentionDecision: retention ? checkpointRetentionDecisionSchema.parse(retention.decision_json) : null,
    holdEvents: hold ? [checkpointHoldEventSchema.parse(hold.event_json)] : [],
    live: { sessionId: String(live.snapshot.sessionId), generation: live.generation,
      state: recovering.rows.length ? "running" : live.snapshot.state as CleanupEvidence["live"]["state"],
      checkpointId: String((live.snapshot.checkpoint as Record<string, unknown> | null)?.checkpointId ?? ""),
      workspaceJobUid: live.jobUid, resourceConfigurationDigest: live.resourceConfigurationDigest,
      workspaceConfigurationDigest: live.workspaceConfigurationDigest,
      workspaceManifestDigest: live.workspaceManifestDigest } };
}

function sameCleanupAuthority(prior: CheckpointCleanupDecision, current: CheckpointCleanupDecision): boolean {
  return canonicalJsonText({ ...prior, decidedAt: current.decidedAt,
    ...(prior.authorized && current.authorized ? { consumedAt: current.consumedAt } : {}) }) ===
    canonicalJsonText(current);
}

/** The sole fail-closed handoff to COAUTO-15. This consumes one decision under
 * the evidence locks. It performs no deletion and is not a reusable deletion
 * capability. Any subsequent consumer must revalidate under the same locks. */
export async function authorizeCheckpointCleanup(
  client: TransactionClient,
  input: { readonly operator: AuthenticatedCheckpointOperator;
    readonly checkpointId: string; readonly decisionId?: string },
): Promise<CheckpointCleanupDecision> {
  requireOperator(input.operator);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const evidence = await lockCleanupEvidence(client, input.checkpointId);
    const now = await databaseClock(client);
    const decisionId = input.decisionId ?? randomUUID();
    let current = evidence ? evaluateCheckpointCleanup({ evidence, now, decisionId })
      : checkpointCleanupDecisionSchema.parse({ version: "codeops.checkpoint-cleanup-decision/v1",
        decisionId, checkpointId: input.checkpointId, authorized: false,
        reason: "legacy-unverified", decidedAt: now });
    if (current.authorized) {
      const consumed = await client.query<{ decision_id: unknown }>(`SELECT decision_id
        FROM codeops.workspace_checkpoint_cleanup_decisions
        WHERE checkpoint_id=$1 AND authorized FOR UPDATE`, [input.checkpointId]);
      if (consumed.rows[0] && consumed.rows[0].decision_id !== decisionId) {
        current = checkpointCleanupDecisionSchema.parse({ version: current.version,
          decisionId, checkpointId: input.checkpointId, authorized: false,
          reason: "authority-drift", decidedAt: now });
      }
    }
    const prior = (await client.query<{ decision_json: unknown }>(
      `SELECT decision_json FROM codeops.workspace_checkpoint_cleanup_decisions
        WHERE decision_id=$1 FOR UPDATE`, [decisionId])).rows[0];
    if (prior) {
      const replay = checkpointCleanupDecisionSchema.parse(prior.decision_json);
      if (!sameCleanupAuthority(replay, current)) {
        throw new Error("cleanup decision replay conflicts with current authority");
      }
      await client.query("COMMIT");
      return replay;
    }
    if (!evidence) { await client.query("COMMIT"); return current; }
    const decision = current;
    await client.query(`INSERT INTO codeops.workspace_checkpoint_cleanup_decisions
      (decision_id,checkpoint_id,authorized,hold_revision,retention_revision,
       live_generation,decision_json,decision_digest,decided_at,consumed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
      [decision.decisionId,decision.checkpointId,decision.authorized,
        decision.authorized ? decision.holdRevision : null,
        decision.authorized ? decision.retentionRevision : null,
        decision.authorized ? decision.liveGeneration : null,
        canonicalJsonText(decision),sha256CanonicalJsonDigest(decision),decision.decidedAt,
        decision.authorized ? decision.consumedAt : null]);
    await client.query("COMMIT");
    return decision;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function validateCleanupDecisionReadback(
  client: TransactionClient, decisionId: string,
): Promise<Extract<CheckpointCleanupDecision, { authorized: true }>> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Read the immutable pointer first; lock the evidence parent before the
    // decision row, in the same order as authorization and policy writers.
    const stored = (await client.query<{ decision_json: unknown }>(
      `SELECT decision_json FROM codeops.workspace_checkpoint_cleanup_decisions
        WHERE decision_id=$1`, [decisionId])).rows[0];
    const decision = checkpointCleanupDecisionSchema.parse(stored?.decision_json);
    if (!decision.authorized) throw new Error("cleanup decision is not authorized");
    const evidence = await lockCleanupEvidence(client, decision.checkpointId);
    const now = await databaseClock(client);
    if (!evidence || !sameCleanupAuthority(decision,
      evaluateCheckpointCleanup({ evidence, now, decisionId }))) {
      throw new Error("cleanup authority drifted after its decision");
    }
    await client.query("COMMIT");
    return decision;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
