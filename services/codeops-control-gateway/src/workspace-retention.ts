import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalJsonText, sha256CanonicalJsonDigest, sessionSnapshotSchema,
  sessionRuntimeTerminalObservationSchema, workspaceLaunchSchema,
  workItemRetryDispositionRequestSchema,
  runtimeBindingSchema, sessionRuntimeDispatchSchema,
} from "@codeops/codeops-contracts";
import { lockCheckpointCleanupAuthority, requireCheckpointRetentionOperator,
  type AuthenticatedCheckpointOperator } from "./checkpoint-recovery.js";
import { isRetainedIncidentIdentity } from "./retained-incident-identities.js";
import type { TransactionClient } from "./session-broker-repository.js";

const name = z.string().min(1).max(253).regex(/^[a-z0-9][a-z0-9.-]*$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const retainedResourceSchema = z.object({
  kind: z.enum(["Job", "Pod", "PersistentVolumeClaim"]),
  name, uid: z.string().uuid(), configDigest: digest,
}).strict();
export const workspaceRetentionTargetSchema = z.object({
  namespace: name, sessionId: z.string().min(1).max(128),
  generation: z.number().int().positive(), leaseId: z.string().uuid(),
  launchId: z.string().min(1).max(128), requestDigest: digest,
  job: retainedResourceSchema.refine(r => r.kind === "Job"),
  pods: z.array(retainedResourceSchema.refine(r => r.kind === "Pod")).max(100),
  pvc: retainedResourceSchema.refine(r => r.kind === "PersistentVolumeClaim"),
  pv: z.object({ name, uid: z.string().uuid(), driver: z.string().min(1).max(253),
    volumeHandle: z.string().min(1).max(512) }).strict(),
}).strict().refine(t => new Set(t.pods.map(p => p.uid)).size === t.pods.length &&
  new Set(t.pods.map(p => p.name)).size === t.pods.length, "duplicate Pod identity");
export type WorkspaceRetentionTarget = z.infer<typeof workspaceRetentionTargetSchema>;
type Resource = z.infer<typeof retainedResourceSchema>;

export const workspaceCapacitySchema = z.object({
  workspaceVolumes: z.number().int().nonnegative(),
  providerVolumes: z.number().int().nonnegative(),
  volumeQuota: z.number().int().nonnegative(),
  releasedPvs: z.number().int().nonnegative(),
}).strict();
type Capacity = z.infer<typeof workspaceCapacitySchema>;

/** A complete, fresh inventory is required. Unknown/partial provider reads must
 * throw, never report absence. Include ALL Jobs and Pods referencing the PVC,
 * including materializers, other owners and terminating resources. */
export interface WorkspaceRetentionInventory {
  readonly observedAt: string;
  readonly capacity: Capacity;
  readonly jobs: readonly Resource[];
  readonly pods: readonly Resource[];
  readonly pvc: Resource | null;
  readonly pv: WorkspaceRetentionTarget["pv"] | null;
  readonly providerVolume: "present" | "absent" | "unknown";
  readonly pvcProtected: boolean;
  readonly explicitKeep: boolean;
  readonly successorAttached: boolean;
}

const inventorySchema = z.object({
  observedAt: z.string().datetime({ offset: true }), capacity: workspaceCapacitySchema,
  jobs: z.array(retainedResourceSchema).max(100), pods: z.array(retainedResourceSchema).max(100),
  pvc: retainedResourceSchema.nullable(), pv: workspaceRetentionTargetSchema.innerType().shape.pv.nullable(),
  providerVolume: z.enum(["present", "absent", "unknown"]),
  pvcProtected: z.boolean(), explicitKeep: z.boolean(), successorAttached: z.boolean(),
}).strict();

/** Trusted control-gateway adapter. deleteExact must GET and verify ownership,
 * then DELETE with UID AND resourceVersion preconditions, foreground for Jobs.
 * Never remove finalizers, PVs, provider volumes, or checkpoint artifacts. The
 * storage provisioner owns cascading storage deletion. */
export interface WorkspaceRetentionResources {
  observe(target: WorkspaceRetentionTarget): Promise<WorkspaceRetentionInventory>;
  deleteExact(target: WorkspaceRetentionTarget, resource: Resource): Promise<void>;
}

export type WorkspaceReclamationStep =
  | { readonly type: "delete"; readonly resource: Resource }
  | { readonly type: "wait"; readonly reason: "pvc-protection" | "provider-disappearance" }
  | { readonly type: "complete" };

function exact(a: unknown, b: unknown, message: string): void {
  if (canonicalJsonText(a) !== canonicalJsonText(b)) throw new Error(message);
}

/** Recompute from observations after every interruption; never advance from an
 * event's asserted phase. Replacement resources and new references fail closed. */
export function nextWorkspaceReclamationStep(
  target: WorkspaceRetentionTarget, inventory: WorkspaceRetentionInventory,
): WorkspaceReclamationStep {
  workspaceRetentionTargetSchema.parse(target);
  inventory = inventorySchema.parse(inventory);
  if (inventory.explicitKeep || inventory.successorAttached) throw new Error("workspace is held or attached");
  if (inventory.providerVolume === "unknown") throw new Error("provider inventory is ambiguous");
  if (inventory.jobs.length > 1) throw new Error("workspace has additional referencing Jobs");
  for (const job of inventory.jobs) exact(job, target.job, "Job identity drift");
  for (const pod of inventory.pods) {
    const retained = target.pods.find(p => p.uid === pod.uid);
    if (!retained) throw new Error("workspace has an unrecorded referencing Pod");
    exact(pod, retained, "Pod identity drift");
  }
  if (inventory.pvc) exact(inventory.pvc, target.pvc, "PVC identity drift");
  if (inventory.pv) exact(inventory.pv, target.pv, "PV identity drift");
  const job = inventory.jobs[0];
  if (job) return { type: "delete", resource: job };
  const pod = inventory.pods[0];
  if (pod) return { type: "delete", resource: pod };
  if (inventory.pvc) return inventory.pvcProtected
    ? { type: "wait", reason: "pvc-protection" }
    : { type: "delete", resource: inventory.pvc };
  if (inventory.pv || inventory.providerVolume !== "absent") {
    return { type: "wait", reason: "provider-disappearance" };
  }
  return { type: "complete" };
}

/** This projection deliberately does not reimplement COAUTO25's classifier. */
export function assertTerminalRetryDisposition(raw: unknown, target: WorkspaceRetentionTarget): void {
  const retry = workItemRetryDispositionRequestSchema.parse(raw);
  if (retry.kind !== "stop-terminal" || retry.successor !== null ||
      !["none", "failed", "succeeded", "reconciled_satisfied", "reconciled_not_observed", "operator_resolved"].includes(retry.providerEffect.state) ||
      retry.predecessorSessionId !== target.sessionId ||
      retry.authority.predecessorGeneration !== target.generation ||
      retry.authority.predecessorLeaseId !== target.leaseId ||
      retry.terminalObservation.job.uid !== target.job.uid) {
    throw new Error("retry disposition preserves this workspace");
  }
}

async function lockRetentionAuthority(client: TransactionClient, decisionId: string,
  target: WorkspaceRetentionTarget) {
  const cleanup = await lockCheckpointCleanupAuthority(client, decisionId);
  const binding = cleanup.checkpointReceipt.binding;
  if (binding.sessionId !== target.sessionId || binding.generation !== target.generation ||
      binding.workspaceJobUid !== target.job.uid ||
      binding.resourceConfigurationDigest !== target.job.configDigest ||
      cleanup.restoreReceipt.restoredWorkspaceJobUid === target.job.uid ||
      isRetainedIncidentIdentity(target.launchId, target.sessionId)) {
    throw new Error("retention target conflicts with checkpoint identity");
  }
  const sessionRow = (await client.query(`SELECT snapshot_json FROM codeops.sessions
    WHERE session_id=$1 FOR UPDATE`, [target.sessionId])).rows[0];
  const session = sessionSnapshotSchema.parse(sessionRow?.snapshot_json);
  if (!["completed", "failed", "cancelled", "archived"].includes(session.state) ||
      session.lease?.status === "active" || session.pendingPermission !== null) {
    throw new Error("Session retains runtime authority");
  }
  // Hold writers for every descriptor of this Session take the same Session
  // fence. Preserve an older held checkpoint of this exact workspace too.
  const holds = await client.query(`SELECT DISTINCT ON (h.checkpoint_id) h.checkpoint_id,h.action,h.revision
    FROM codeops.workspace_checkpoint_hold_events h
    JOIN codeops.workspace_checkpoint_descriptors d ON d.checkpoint_id=h.checkpoint_id
    WHERE d.session_id=$1 AND d.descriptor_json#>>'{manifest,binding,workspaceJobUid}'=$2
    ORDER BY h.checkpoint_id,h.revision DESC`, [target.sessionId,target.job.uid]);
  if (holds.rows.some(row => row.action !== "released")) throw new Error("workspace checkpoint is held");
  const launches = await client.query(`SELECT launch_json FROM codeops.workspace_launches
    WHERE launch_id=$1 OR launch_json#>>'{resourceBindings,workspaceStorage,uid}'=$2
    ORDER BY launch_id FOR UPDATE`, [target.launchId, target.pvc.uid]);
  if (launches.rows.length !== 1) throw new Error("storage has ambiguous or successor launch ownership");
  const launch = workspaceLaunchSchema.parse(launches.rows[0]?.launch_json);
  if (launch.state !== "ready" || launch.launchId !== target.launchId ||
      launch.sessionId !== target.sessionId || launch.requestDigest !== target.requestDigest ||
      !launch.runtimeLaunchBinding || !launch.runtimeRequirements ||
      launch.resourceBindings?.workspaceRuntime?.uid !== target.job.uid ||
      launch.resourceBindings.workspaceRuntime.configDigest !== target.job.configDigest ||
      launch.resourceBindings.workspaceStorage?.uid !== target.pvc.uid ||
      launch.resourceBindings.workspaceStorage.configDigest !== target.pvc.configDigest) {
    throw new Error("retention requires exact admitted launch bindings");
  }
  const observations = await client.query(`SELECT observation_json FROM codeops.session_runtime_terminal_observations
    WHERE session_id=$1 AND generation=$2 AND job_uid=$3 AND lease_id=$4 FOR UPDATE`,
  [target.sessionId, target.generation, target.job.uid, target.leaseId]);
  const terminal = sessionRuntimeTerminalObservationSchema.parse(observations.rows[0]?.observation_json);
  if (terminal.job.name !== target.job.name) throw new Error("terminal Job name drift");
  const outbox = await client.query(`SELECT dispatch_id,status,claim_token,claim_count,
      claimed_by,runtime_binding_json,runtime_claim_protocol,dispatch_json FROM codeops.session_runtime_outbox
    WHERE session_id=$1 ORDER BY dispatch_id FOR UPDATE`, [target.sessionId]);
  if (outbox.rows.length === 0 || outbox.rows.some(row => ["pending", "claimed"].includes(String(row.status)))) {
    throw new Error("runtime outbox retains authority or lacks durable history");
  }
  for (const row of outbox.rows) {
    const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
    const runtime = runtimeBindingSchema.parse(row.runtime_binding_json);
    if (row.runtime_claim_protocol !== "bound-v2" || dispatch.command.sessionId !== target.sessionId ||
        runtime.requirementDigest !== launch.runtimeRequirementDigest) {
      throw new Error("unverified runtime claim history");
    }
  }
  if (!outbox.rows.some(row => {
    const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
    return dispatch.command.generation === target.generation && dispatch.command.leaseId === target.leaseId &&
      Number(row.claim_count) > 0;
  })) throw new Error("exact terminal generation claim missing");
  const effects = await client.query(`SELECT effect_id,state FROM codeops.provider_effect_receipts
    WHERE session_id=$1 ORDER BY effect_id FOR UPDATE`, [target.sessionId]);
  if (effects.rows.some(row => !["failed", "succeeded", "reconciled_satisfied",
    "reconciled_not_observed", "operator_resolved"].includes(String(row.state)))) {
    throw new Error("unresolved provider effect retains workspace");
  }
  const admission = await client.query(`SELECT admission_id FROM codeops.work_item_admissions
    WHERE child_session_id=$1 FOR UPDATE`, [target.sessionId]);
  const retries = await client.query(`SELECT authority_json,authority_digest FROM codeops.work_item_retry_dispositions
    WHERE predecessor_session_id=$1 ORDER BY lineage_revision DESC FOR UPDATE`, [target.sessionId]);
  if (admission.rows.length && retries.rows.length !== 1) throw new Error("retry disposition missing or ambiguous");
  for (const row of retries.rows) {
    if (sha256CanonicalJsonDigest(row.authority_json) !== row.authority_digest) throw new Error("retry authority digest drift");
    const authority = row.authority_json as { requestAuthority: { request: unknown } };
    assertTerminalRetryDisposition(authority.requestAuthority.request, target);
  }
  return { cleanup, session, launch, terminal, holds: holds.rows,
    outbox: outbox.rows.map(row => ({ dispatchId: row.dispatch_id, status: row.status,
      claimCount: row.claim_count, claimedBy: row.claimed_by,
      claimTokenDigest: sha256CanonicalJsonDigest(row.claim_token),
      runtimeBinding: row.runtime_binding_json,
      dispatchDigest: sha256CanonicalJsonDigest(row.dispatch_json) })),
    effects: effects.rows, retries: retries.rows };
}

async function clock(client: TransactionClient): Promise<string> {
  const row = (await client.query("SELECT clock_timestamp() AS now")).rows[0];
  return new Date(String(row?.now)).toISOString();
}

async function observe(resources: WorkspaceRetentionResources, target: WorkspaceRetentionTarget,
  now: string): Promise<WorkspaceRetentionInventory> {
  const inventory = await resources.observe(target);
  const age = Date.parse(now) - Date.parse(inventory.observedAt);
  if (!Number.isFinite(age) || age > 30_000 || age < -30_000) throw new Error("stale storage inventory");
  nextWorkspaceReclamationStep(target, inventory);
  return inventory;
}

/** Prepare commits the exact target and authority before any Kubernetes effect.
 * Call only from the trusted operator/controller boundary, never from runtime
 * messages. Policy/hold authorization remains owned by checkpoint recovery. */
export async function prepareWorkspaceRetention(client: TransactionClient,
  resources: WorkspaceRetentionResources, input: { readonly operator: AuthenticatedCheckpointOperator;
    readonly decisionId: string; readonly target: unknown }) {
  requireCheckpointRetentionOperator(input.operator);
  const target = workspaceRetentionTargetSchema.parse(input.target);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const authority = await lockRetentionAuthority(client, input.decisionId, target);
    const prior = (await client.query(`SELECT decision_json FROM codeops.workspace_retention_decisions
      WHERE decision_id=$1 FOR UPDATE`, [input.decisionId])).rows[0];
    const authorityDigest = sha256CanonicalJsonDigest(authority);
    if (prior) {
      const decision = prior.decision_json as { target: unknown; authorityDigest: string };
      exact(decision.target, target, "retention replay target drift");
      exact(decision.authorityDigest, authorityDigest, "retention replay authority drift");
      await client.query("COMMIT");
      return prior.decision_json;
    }
    const now = await clock(client);
    const before = await observe(resources, target, now);
    if (!before.pvc || !before.pv || before.providerVolume !== "present") {
      throw new Error("cannot enroll missing storage or fabricate historical ownership");
    }
    const decision = { version: "codeops.workspace-retention-decision/v1", decisionId: input.decisionId,
      target, authority, authorityDigest, before, decidedAt: now,
      retainUntil: authority.cleanup.retentionDecision.retainUntil };
    await client.query(`INSERT INTO codeops.workspace_retention_decisions
      (decision_id,pvc_uid,decision_json,decision_digest,decided_at)
      VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz)`, [input.decisionId,target.pvc.uid,
      canonicalJsonText(decision),sha256CanonicalJsonDigest(decision),now]);
    await client.query("COMMIT");
    return decision;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** One bounded step per pass. Commit loss after DELETE is safe: the next pass
 * rereads exact identities and absence. No event can skip an observation. */
export async function reconcileWorkspaceRetention(client: TransactionClient,
  resources: WorkspaceRetentionResources, decisionId: string, operator: AuthenticatedCheckpointOperator) {
  requireCheckpointRetentionOperator(operator);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const row = (await client.query(`SELECT decision_json,decision_digest FROM codeops.workspace_retention_decisions
      WHERE decision_id=$1`, [decisionId])).rows[0];
    if (!row || sha256CanonicalJsonDigest(row.decision_json) !== row.decision_digest) throw new Error("retention receipt missing or corrupt");
    const decision = row.decision_json as { target: unknown; authorityDigest: string; before: WorkspaceRetentionInventory };
    const target = workspaceRetentionTargetSchema.parse(decision.target);
    // Replays of immutable completion perform no effects, even after policy expiry.
    const completed = (await client.query(`SELECT receipt_json,receipt_digest FROM codeops.workspace_cleanup_receipts
      WHERE decision_id=$1 AND completed`, [decisionId])).rows[0];
    if (completed) {
      const receipt = completed.receipt_json as { decisionId: string; decisionDigest: string; completed: boolean };
      if (sha256CanonicalJsonDigest(receipt) !== completed.receipt_digest ||
          receipt.decisionId !== decisionId || receipt.decisionDigest !== row.decision_digest || !receipt.completed) {
        throw new Error("cleanup completion receipt drift");
      }
      await client.query("COMMIT"); return receipt;
    }
    const authority = await lockRetentionAuthority(client, decisionId, target);
    exact(sha256CanonicalJsonDigest(authority), decision.authorityDigest, "retention authority changed");
    await client.query(`SELECT decision_id FROM codeops.workspace_retention_decisions
      WHERE decision_id=$1 FOR UPDATE`, [decisionId]);
    const now = await clock(client);
    const inventory = await observe(resources, target, now);
    const step = nextWorkspaceReclamationStep(target, inventory);
    if (step.type === "delete") await resources.deleteExact(target, step.resource);
    const receipt = { version: "codeops.workspace-cleanup-receipt/v1", receiptId: randomUUID(), decisionId,
      decisionDigest: row.decision_digest, target, step, observedAt: now,
      before: decision.before.capacity, after: inventory.capacity, inventory,
      completed: step.type === "complete" };
    await client.query(`INSERT INTO codeops.workspace_cleanup_receipts
      (receipt_id,decision_id,receipt_json,receipt_digest,completed,observed_at)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6::timestamptz)`, [receipt.receiptId,decisionId,
      canonicalJsonText(receipt),sha256CanonicalJsonDigest(receipt),receipt.completed,now]);
    await client.query("COMMIT");
    return receipt;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function workspaceRetentionMetrics(client: TransactionClient, capacity: Capacity,
  stuckAfterSeconds: number) {
  workspaceCapacitySchema.parse(capacity);
  if (!Number.isSafeInteger(stuckAfterSeconds) || stuckAfterSeconds < 1) throw new Error("invalid stuck interval");
  const rows = await client.query(`SELECT
    count(*) AS eligible_retained,
    count(*) FILTER (WHERE d.decided_at < clock_timestamp() - ($1 * interval '1 second')) AS stuck_deletions
    FROM codeops.workspace_retention_decisions d WHERE NOT EXISTS
      (SELECT 1 FROM codeops.workspace_cleanup_receipts r WHERE r.decision_id=d.decision_id AND r.completed)`,
  [stuckAfterSeconds]);
  return { workspaceVolumeCount: capacity.workspaceVolumes,
    quotaHeadroom: capacity.volumeQuota - capacity.providerVolumes,
    eligibleRetainedCount: Number(rows.rows[0]?.eligible_retained),
    stuckDeletionCount: Number(rows.rows[0]?.stuck_deletions), releasedPvs: capacity.releasedPvs };
}

/** Feed a bounded batch from the existing trusted controller poll. Each candidate
 * gets a fresh transaction; one hold or provider delay cannot starve the rest.
 * The cursor belongs to the caller's ordinary durable poll/checkpoint contract. */
export async function reconcileWorkspaceRetentionBatch(client: TransactionClient,
  resources: WorkspaceRetentionResources, operator: AuthenticatedCheckpointOperator,
  input: { readonly afterDecisionId?: string; readonly limit: number }) {
  requireCheckpointRetentionOperator(operator);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("invalid retention batch limit");
  const rows = await client.query(`SELECT d.decision_id FROM codeops.workspace_retention_decisions d
    WHERE ($1::uuid IS NULL OR d.decision_id > $1::uuid) AND NOT EXISTS
      (SELECT 1 FROM codeops.workspace_cleanup_receipts r WHERE r.decision_id=d.decision_id AND r.completed)
    ORDER BY d.decision_id LIMIT $2`, [input.afterDecisionId ?? null, input.limit]);
  const results: { decisionId: string; status: "observed" | "retained" }[] = [];
  for (const row of rows.rows) {
    const decisionId = String(row.decision_id);
    try {
      await reconcileWorkspaceRetention(client, resources, decisionId, operator);
      results.push({ decisionId, status: "observed" });
    } catch {
      // Deliberately omit raw database/provider errors from public evidence.
      // The caller may retain bounded private diagnostics through its logger.
      results.push({ decisionId, status: "retained" });
    }
  }
  return { results, nextCursor: rows.rows.length === input.limit ? String(rows.rows.at(-1)!.decision_id) : null };
}
