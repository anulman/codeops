import { isRetainedIncidentIdentity, retainedLaunchIds, retainedSessionIds } from "./retained-incident-identities.js";
import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  isWorkspaceSessionIdentity,
  SESSION_BROKER_VERSION,
  sessionEventSchema,
  sessionRuntimeTerminalObservationSchema,
  sessionSnapshotSchema,
  type SessionRuntimeTerminalObservation,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";
import { kubernetesIdentityLabel } from "./kubernetes.js";
import { reconcileFailedWorkItemAttempt } from "./work-item-retry.js";

export interface InteractiveRuntimeCandidate {
  readonly sessionId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly runId: string;
  readonly jobName: string;
  readonly requestDigest: string;
  readonly runtimeUid?: string;
  readonly runtimeConfigDigest?: string;
}

interface CandidateRow extends Record<string, unknown> {
  readonly launch_id: unknown;
  readonly request_digest: unknown;
  readonly snapshot_json: unknown;
  readonly runtime_uid?: unknown;
  readonly runtime_config_digest?: unknown;
}

function isEligibleSnapshot(snapshot: SessionSnapshot): boolean {
  if (
    snapshot.state === "hibernated" &&
    snapshot.lease?.status === "released"
  ) {
    return snapshot.lease.generation === snapshot.generation;
  }
  return ["running", "waiting_permission", "checkpointing"].includes(
    snapshot.state,
  ) && snapshot.lease?.status === "active" &&
    snapshot.lease.generation === snapshot.generation;
}

function interactiveRuntimeCandidate(row: CandidateRow): InteractiveRuntimeCandidate {
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  if (
    !isWorkspaceSessionIdentity(snapshot.identity) ||
    !isEligibleSnapshot(snapshot) ||
    typeof row.launch_id !== "string" ||
    !/^launch-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(row.launch_id) ||
    typeof row.request_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(row.request_digest)
  ) {
    throw new Error("interactive runtime candidate identity is invalid");
  }
  const admitted = row.launch_id.length === "launch-".length + 32;
  const runtimeUid = string(row.runtime_uid);
  const runtimeConfigDigest = string(row.runtime_config_digest);
  if (admitted && (!runtimeUid || !runtimeConfigDigest ||
      !/^sha256:[0-9a-f]{64}$/.test(runtimeConfigDigest)) ||
      !admitted && (runtimeUid !== null || runtimeConfigDigest !== null)) {
    throw new Error("interactive runtime candidate binding is invalid");
  }
  return {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    leaseId: snapshot.lease!.leaseId,
    runId: snapshot.identity.runId,
    jobName: `workspace-${row.launch_id.slice("launch-".length)}`,
    requestDigest: row.request_digest,
    ...(runtimeUid === null ? {} : { runtimeUid }),
    ...(runtimeConfigDigest === null ? {} : { runtimeConfigDigest }),
  };
}

export async function listInteractiveRuntimeCandidates(
  client: TransactionClient,
  limit = 100,
): Promise<readonly InteractiveRuntimeCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("runtime terminal reconciliation limit is invalid");
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const cursorResult = await client.query<{ readonly last_session_id: unknown }>(
      `SELECT last_session_id
         FROM codeops.session_runtime_reconciliation_scan
        WHERE singleton = true
        FOR UPDATE`,
    );
    const lastSessionId = cursorResult.rows[0]?.last_session_id;
    if (typeof lastSessionId !== "string") {
      throw new Error("runtime terminal reconciliation cursor is missing");
    }
    const result = await client.query<CandidateRow>(
      `SELECT session.launch_id,session.request_digest,session.snapshot_json,
              session.runtime_uid,session.runtime_config_digest
       FROM (
         SELECT launch.launch_id,launch.request_digest,session.snapshot_json,
                session.session_id,NULL::text AS runtime_uid,
                NULL::text AS runtime_config_digest
         FROM codeops.workspace_launches launch
         JOIN codeops.sessions session ON session.session_id=launch.launch_json->>'sessionId'
         WHERE launch.launch_id=session.snapshot_json->'identity'->>'runId'
         UNION ALL
         SELECT 'launch-' || replace(materialization.admission_id::text,'-',''),
                materialization.input_digest,session.snapshot_json,session.session_id,
                materialization.state_json#>>'{resources,workspaceRuntime,uid}',
                materialization.state_json#>>'{resources,workspaceRuntime,configDigest}'
         FROM codeops.admitted_child_materializations materialization
         JOIN codeops.sessions session ON session.session_id=materialization.child_session_id
         JOIN codeops.work_item_admissions admission
           ON admission.admission_id=materialization.admission_id
          AND admission.authority_digest=materialization.admission_digest
         JOIN codeops.project_plan_approvals approval
           ON approval.approval_id=materialization.approval_id
          AND approval.authority_digest=materialization.approval_digest
         JOIN codeops.session_runtime_outbox dispatch
           ON dispatch.dispatch_id=materialization.child_dispatch_id
          AND dispatch.session_id=materialization.child_session_id
          AND dispatch.principal_id=materialization.principal_id
          AND dispatch.admission_id=materialization.admission_id
         WHERE materialization.state IN ('success-finalizing','ready')
       ) session
       WHERE NOT (session.launch_id = ANY($3::text[]))
         AND NOT (session.session_id = ANY($4::text[]))
         AND session.snapshot_json->>'state' IN
             ('running','waiting_permission','checkpointing','hibernated')
         AND session.snapshot_json->'identity'->>'version'=
             'codeops.session-workspace-identity/v1'
       ORDER BY (session.session_id > $1) DESC,session.session_id ASC
       LIMIT $2`,
      [lastSessionId, limit, retainedLaunchIds, retainedSessionIds],
    );
    const candidates = result.rows.map(interactiveRuntimeCandidate);
    if (candidates.length > 0) {
      await client.query(
        `UPDATE codeops.session_runtime_reconciliation_scan
            SET last_session_id = $1
          WHERE singleton = true`,
        [candidates[candidates.length - 1]!.sessionId],
      );
    }
    await client.query("COMMIT");
    return candidates;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function retainedLaunchLeaseId(runId: string): string {
  const hex = createHash("sha256").update(`${runId}:lease`).digest("hex")
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20),
  ].join("-");
}

function resourceIdentity(value: Record<string, unknown>): {
  readonly name: string;
  readonly uid: string;
  readonly resourceVersion: string;
} {
  const metadata = record(value.metadata);
  const name = string(metadata?.name);
  const uid = string(metadata?.uid);
  const resourceVersion = string(metadata?.resourceVersion);
  if (
    !name ||
    !uid ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uid) ||
    !resourceVersion ||
    !/^[1-9][0-9]{0,39}$/.test(resourceVersion)
  ) {
    throw new Error("Kubernetes terminal resource identity is incomplete");
  }
  return { name, uid, resourceVersion };
}

function requireJobIdentity(
  candidate: InteractiveRuntimeCandidate,
  job: Record<string, unknown>,
): ReturnType<typeof resourceIdentity> & { readonly legacy: boolean } {
  const jobIdentity = resourceIdentity(job);
  const metadata = record(job.metadata);
  const labels = record(metadata?.labels);
  const annotations = record(metadata?.annotations);
  const identityAnnotationKeys = [
    "codeops.example/session-generation",
    "codeops.example/session-lease-id",
    "codeops.example/session-run-id",
  ] as const;
  const identityAnnotationCount = identityAnnotationKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(annotations ?? {}, key)
  ).length;
  const completePreferredIdentity =
    identityAnnotationCount === identityAnnotationKeys.length &&
    annotations?.["codeops.example/session-generation"] ===
      String(candidate.generation) &&
    annotations?.["codeops.example/session-lease-id"] === candidate.leaseId &&
    annotations?.["codeops.example/session-run-id"] === candidate.runId;
  // Jobs retained from before the identity annotations were introduced are
  // accepted only through the immutable launch request digest already checked
  // by the Kubernetes create-409 path. A partial identity set is never legacy.
  const completeLegacyIdentity =
    identityAnnotationCount === 0 &&
    candidate.generation === 1 &&
    candidate.leaseId === retainedLaunchLeaseId(candidate.runId) &&
    annotations?.["codeops.example/request-digest"] === candidate.requestDigest;
  if (
    jobIdentity.name !== candidate.jobName ||
    labels?.["codeops.example/resource-role"] !== "workspace-runtime" ||
    labels?.["codeops.example/session-id"] !== (candidate.runtimeUid === undefined
      ? candidate.sessionId : kubernetesIdentityLabel(candidate.sessionId)) ||
    labels?.["codeops.example/run-id"] !== (candidate.runtimeUid === undefined
      ? candidate.runId : kubernetesIdentityLabel(candidate.runId)) ||
    (candidate.runtimeUid !== undefined && jobIdentity.uid !== candidate.runtimeUid) ||
    (candidate.runtimeConfigDigest !== undefined && annotations?.[
      "codeops.example/resource-configuration-digest"
    ] !== candidate.runtimeConfigDigest) ||
    (!completePreferredIdentity && !completeLegacyIdentity)
  ) {
    throw new Error("Kubernetes runtime Job identity drifted from the Session");
  }
  return { ...jobIdentity, legacy: completeLegacyIdentity };
}

export async function listRetainedInteractiveRuntimeJobUids(
  client: TransactionClient,
  getJob: (name: string) => Promise<Record<string, unknown>>,
): Promise<readonly string[] | undefined> {
  const migrationTable = await client.query<{ readonly table_name: unknown }>(
    "SELECT to_regclass('codeops.schema_migrations') AS table_name",
  );
  if (migrationTable.rows[0]?.table_name === null) return [];
  const migration = await client.query(
    `SELECT 1 FROM codeops.schema_migrations
      WHERE migration_name = 'session-runtime-terminal-reconciliation-v1'`,
  );
  if (migration.rows[0]) return undefined;
  const result = await client.query<CandidateRow>(
    `SELECT launch.launch_id, launch.request_digest, session.snapshot_json
       FROM codeops.workspace_launches AS launch
       JOIN codeops.sessions AS session
         ON session.session_id = launch.launch_json->>'sessionId'
      WHERE session.snapshot_json->>'state' IN
            ('running', 'waiting_permission', 'checkpointing', 'hibernated')
        AND session.snapshot_json->'identity'->>'version' =
            'codeops.session-workspace-identity/v1'
        AND launch.launch_id = session.snapshot_json->'identity'->>'runId'
      ORDER BY session.session_id ASC`,
  );
  const uids: string[] = [];
  for (const row of result.rows) {
    const candidate = interactiveRuntimeCandidate(row);
    const job = requireJobIdentity(candidate, await getJob(candidate.jobName));
    if (job.legacy) uids.push(job.uid);
  }
  uids.sort();
  if (new Set(uids).size !== uids.length) {
    throw new Error("retained runtime Job UID allowlist contains a duplicate");
  }
  return uids;
}

const rfc3339TimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function requireRfc3339Timestamp(value: string): void {
  if (
    !rfc3339TimestampPattern.test(value) ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error("runtime reconciliation timestamp is not RFC3339");
  }
}

interface StoredJobProgressRow extends Record<string, unknown> {
  readonly lease_id: unknown;
  readonly run_id: unknown;
  readonly job_name: unknown;
  readonly job_uid: unknown;
  readonly job_resource_version: unknown;
}

export async function recordInteractiveRuntimeJobProgress(
  client: TransactionClient,
  input: {
    readonly candidate: InteractiveRuntimeCandidate;
    readonly job: Record<string, unknown>;
    readonly observedAt: string;
  },
): Promise<"registered" | "advanced" | "duplicate" | "stale"> {
  if (isRetainedIncidentIdentity(input.candidate.runId, input.candidate.sessionId)) return "stale";
  const job = requireJobIdentity(input.candidate, input.job);
  requireRfc3339Timestamp(input.observedAt);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await client.query<{ readonly snapshot_json: unknown }>(
      `SELECT snapshot_json FROM codeops.sessions
        WHERE session_id = $1 FOR UPDATE`,
      [input.candidate.sessionId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return "stale";
    }
    const snapshot = sessionSnapshotSchema.parse(locked.rows[0].snapshot_json);
    if (
      snapshot.generation !== input.candidate.generation ||
      !isEligibleSnapshot(snapshot) ||
      snapshot.lease!.leaseId !== input.candidate.leaseId ||
      !isWorkspaceSessionIdentity(snapshot.identity) ||
      snapshot.identity.runId !== input.candidate.runId
    ) {
      await client.query("ROLLBACK");
      return "stale";
    }
    const existing = await client.query<StoredJobProgressRow>(
      `SELECT lease_id, run_id, job_name, job_uid, job_resource_version
         FROM codeops.session_runtime_job_progress
        WHERE session_id = $1 AND generation = $2
        FOR UPDATE`,
      [input.candidate.sessionId, input.candidate.generation],
    );
    const row = existing.rows[0];
    if (row) {
      if (
        row.lease_id !== input.candidate.leaseId ||
        row.run_id !== input.candidate.runId ||
        row.job_name !== input.candidate.jobName ||
        row.job_uid !== job.uid
      ) {
        throw new Error("durable runtime Job identity drifted from Kubernetes");
      }
      const storedVersion = BigInt(String(row.job_resource_version));
      const observedVersion = BigInt(job.resourceVersion);
      if (observedVersion <= storedVersion) {
        await client.query("COMMIT");
        return observedVersion === storedVersion ? "duplicate" : "stale";
      }
      const updated = await client.query(
        `UPDATE codeops.session_runtime_job_progress
            SET job_resource_version = $3::numeric,
                observed_at = $4::timestamptz
          WHERE session_id = $1 AND generation = $2
            AND job_uid = $5 AND job_resource_version < $3::numeric`,
        [input.candidate.sessionId, input.candidate.generation,
          job.resourceVersion, input.observedAt, job.uid],
      );
      if (updated.rowCount !== 1) {
        throw new Error("runtime Job progress compare-and-swap failed");
      }
      await client.query("COMMIT");
      return "advanced";
    }
    if (job.legacy) {
      const retained = await client.query<{ readonly job_uid: unknown }>(
        `SELECT job_uid
           FROM codeops.session_runtime_legacy_job_allowlist
          WHERE job_uid = $1
          FOR UPDATE`,
        [job.uid],
      );
      if (retained.rows[0]?.job_uid !== job.uid) {
        throw new Error(
          "legacy runtime Job UID was not retained at the upgrade",
        );
      }
    }
    await client.query(
      `INSERT INTO codeops.session_runtime_job_progress
         (session_id, generation, lease_id, run_id, job_name, job_uid,
          job_resource_version, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::timestamptz)`,
      [input.candidate.sessionId, input.candidate.generation,
        input.candidate.leaseId, input.candidate.runId, input.candidate.jobName,
        job.uid, job.resourceVersion, input.observedAt],
    );
    await client.query("COMMIT");
    return "registered";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function terminalContainer(pod: Record<string, unknown>): {
  readonly reason: string | null;
  readonly message: string | null;
  readonly exitCode: number | null;
} {
  const statuses = Array.isArray(record(pod.status)?.containerStatuses)
    ? record(pod.status)!.containerStatuses as unknown[]
    : [];
  const worker = statuses.map(record).find((entry) =>
    entry?.name === "runtime-worker"
  );
  const terminated = record(record(worker?.state)?.terminated);
  const exitCode = terminated?.exitCode;
  return {
    reason: string(terminated?.reason),
    message: string(terminated?.message),
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode)
      ? exitCode
      : null,
  };
}

export function attestInteractiveRuntimeRelease(input: {
  readonly pods: readonly Record<string, unknown>[];
  readonly jobUid: string;
  readonly configuredRuntimeRelease: string;
}): string | null {
  if (!/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(input.configuredRuntimeRelease)) {
    throw new Error("configured workspace runtime release is not immutable");
  }
  const owned = input.pods.filter((pod) => {
    const owners = record(pod.metadata)?.ownerReferences;
    return Array.isArray(owners) && owners.some((raw) => {
      const owner = record(raw);
      return owner?.kind === "Job" && owner.uid === input.jobUid && owner.controller === true;
    });
  });
  if (owned.length !== 1) return null;
  const pod = owned[0]!;
  const containers = Array.isArray(record(pod.spec)?.containers)
    ? record(pod.spec)!.containers as unknown[] : [];
  const runtime = containers.map(record).find((container) => container?.name === "runtime-worker");
  const statuses = Array.isArray(record(pod.status)?.containerStatuses)
    ? record(pod.status)!.containerStatuses as unknown[] : [];
  const status = statuses.map(record).find((container) => container?.name === "runtime-worker");
  const digest = input.configuredRuntimeRelease.slice(input.configuredRuntimeRelease.indexOf("@") + 1);
  const imageId = string(status?.imageID);
  return runtime?.image === input.configuredRuntimeRelease && imageId?.endsWith(`@${digest}`)
    ? input.configuredRuntimeRelease : null;
}

export function observeInteractiveRuntimeTerminal(input: {
  readonly candidate: InteractiveRuntimeCandidate;
  readonly job: Record<string, unknown>;
  readonly pods: readonly Record<string, unknown>[];
  readonly observedAt: string;
}): SessionRuntimeTerminalObservation | null {
  const validatedJobIdentity = requireJobIdentity(input.candidate, input.job);
  const jobIdentity = {
    name: validatedJobIdentity.name,
    uid: validatedJobIdentity.uid,
    resourceVersion: validatedJobIdentity.resourceVersion,
  };
  const ownedPods = input.pods.filter((pod) => {
    const owners = record(pod.metadata)?.ownerReferences;
    return Array.isArray(owners) && owners.some((raw) => {
      const owner = record(raw);
      return owner?.kind === "Job" && owner.uid === jobIdentity.uid &&
        owner.controller === true;
    });
  });
  const terminalPods = ownedPods.filter((pod) => {
    const status = record(pod.status);
    return status?.reason === "Evicted" || status?.phase === "Failed" ||
      status?.phase === "Succeeded";
  });
  if (terminalPods.length > 1) {
    throw new Error("multiple owned terminal Pods are ambiguous");
  }
  const evidencePod = terminalPods[0] ?? null;
  const podStatus = evidencePod === null ? null : record(evidencePod.status);
  const status = record(input.job.status);
  const conditions = Array.isArray(status?.conditions)
    ? status.conditions.map(record).filter((value) => value !== null)
    : [];
  const terminalConditions = conditions.filter((condition) =>
    condition.status === "True" &&
    (condition.type === "Failed" || condition.type === "Complete")
  );
  if (terminalConditions.length > 1) {
    throw new Error("runtime Job terminal conditions are ambiguous");
  }
  const condition = terminalConditions[0] ?? null;
  const evicted = podStatus?.reason === "Evicted";
  if (condition !== null && evicted) {
    throw new Error("runtime Job and evicted Pod terminal evidence conflict");
  }
  if (condition === null && !evicted) {
    return null;
  }
  if (
    (typeof status?.active === "number" && status.active !== 0) ||
    ownedPods.some((pod) => pod !== evidencePod)
  ) {
    throw new Error(
      "runtime terminal evidence conflicts with active or additional owned Pods",
    );
  }
  if (
    condition?.type === "Complete" && podStatus?.phase === "Failed" ||
    condition?.type === "Failed" && podStatus?.phase === "Succeeded"
  ) {
    throw new Error("runtime Job and Pod terminal evidence conflict");
  }
  const container = evidencePod === null
    ? { reason: null, message: null, exitCode: null }
    : terminalContainer(evidencePod);
  const conditionReason = string(condition?.reason);
  const conditionMessage = string(condition?.message);
  if (conditionReason === "Cancelled") {
    throw new Error("Kubernetes Job evidence cannot authorize Session cancellation");
  }
  const terminalAt = string(condition?.lastTransitionTime) ??
    string(status?.completionTime) ?? string(podStatus?.completionTime) ??
    input.observedAt;
  const cause = evicted
    ? {
        type: "evicted" as const,
        reason: "Evicted",
        message: string(podStatus?.message),
        exitCode: container.exitCode,
      }
    : condition?.type === "Failed"
      ? {
          type: conditionReason === "DeadlineExceeded"
            ? "deadline_exceeded" as const
            : "failed" as const,
          reason: conditionReason ?? container.reason ?? "JobFailed",
          message: conditionMessage ?? container.message,
          exitCode: container.exitCode,
        }
      : {
          type: "completed" as const,
          reason: conditionReason ?? "Complete",
          message: conditionMessage ?? container.message,
          exitCode: container.exitCode,
        };
  return sessionRuntimeTerminalObservationSchema.parse({
    version: "codeops.session-runtime-terminal-observation/v1",
    sessionId: input.candidate.sessionId,
    generation: input.candidate.generation,
    leaseId: input.candidate.leaseId,
    runId: input.candidate.runId,
    job: jobIdentity,
    pod: evidencePod === null ? null : resourceIdentity(evidencePod),
    cause,
    terminalAt,
    observedAt: input.observedAt,
  });
}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

interface StoredObservationRow extends Record<string, unknown> {
  readonly observation_json: unknown;
}

export async function reconcileInteractiveRuntimeTerminal(
  client: TransactionClient,
  rawObservation: unknown,
  runtimeAttestation?: { readonly configured: string; readonly observed: string | null },
): Promise<"committed" | "duplicate" | "stale" | "already_terminal"> {
  const observation = sessionRuntimeTerminalObservationSchema.parse(rawObservation);
  if (isRetainedIncidentIdentity(observation.runId, observation.sessionId)) return "stale";
  if (observation.cause.type === "failed" && runtimeAttestation !== undefined) {
    const retry = await reconcileFailedWorkItemAttempt(client, observation, runtimeAttestation);
    if (retry !== null) return retry.disposition === "created" ? "committed" : "duplicate";
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await client.query<{ readonly snapshot_json: unknown }>(
      `SELECT snapshot_json FROM codeops.sessions
        WHERE session_id = $1 FOR UPDATE`,
      [observation.sessionId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return "stale";
    }
    const snapshot = sessionSnapshotSchema.parse(locked.rows[0].snapshot_json);
    const progress = await client.query<StoredJobProgressRow>(
      `SELECT lease_id, run_id, job_name, job_uid, job_resource_version
         FROM codeops.session_runtime_job_progress
        WHERE session_id = $1 AND generation = $2
        FOR UPDATE`,
      [observation.sessionId, observation.generation],
    );
    const jobProgress = progress.rows[0];
    const existing = await client.query<StoredObservationRow>(
      `SELECT observation_json
         FROM codeops.session_runtime_terminal_observations
        WHERE job_uid = $1 OR (session_id = $2 AND generation = $3)
        FOR UPDATE`,
      [observation.job.uid, observation.sessionId, observation.generation],
    );
    if (existing.rows[0]) {
      const stored = sessionRuntimeTerminalObservationSchema.parse(
        existing.rows[0].observation_json,
      );
      await client.query("COMMIT");
      return canonicalJsonText(stored) === canonicalJsonText(observation)
        ? "duplicate"
        : "stale";
    }
    if (["completed", "failed", "cancelled", "archived"].includes(snapshot.state)) {
      await client.query("ROLLBACK");
      return "already_terminal";
    }
    const hibernated = snapshot.state === "hibernated";
    const eligibleLease = hibernated
      ? snapshot.lease?.status === "released"
      : ["running", "waiting_permission", "checkpointing"].includes(snapshot.state) &&
        snapshot.lease?.status === "active";
    if (
      snapshot.generation !== observation.generation ||
      !eligibleLease ||
      snapshot.lease!.generation !== observation.generation ||
      snapshot.lease!.leaseId !== observation.leaseId ||
      !isWorkspaceSessionIdentity(snapshot.identity) ||
      snapshot.identity.runId !== observation.runId ||
      !jobProgress ||
      jobProgress.lease_id !== observation.leaseId ||
      jobProgress.run_id !== observation.runId ||
      jobProgress.job_name !== observation.job.name ||
      jobProgress.job_uid !== observation.job.uid ||
      BigInt(observation.job.resourceVersion) !==
        BigInt(String(jobProgress.job_resource_version)) ||
      observation.cause.type === "cancelled"
    ) {
      await client.query("ROLLBACK");
      return "stale";
    }
    const state = observation.cause.type === "completed"
      ? "completed" as const
      : "failed" as const;
    const cursor = snapshot.eventCursor + 1;
    const updatedAt = observation.observedAt;
    const nextLease = snapshot.lease!.status === "active"
      ? { leaseId: observation.leaseId, generation: observation.generation,
          status: "released" as const, releasedAt: updatedAt }
      : snapshot.lease;
    const nextSnapshot: SessionSnapshot = sessionSnapshotSchema.parse({
      ...snapshot,
      state,
      lease: nextLease,
      pendingPermission: null,
      eventCursor: cursor,
      capabilities: sessionCapabilitiesFor(state, snapshot.checkpoint !== null),
      updatedAt,
    });
    const eventBody = { sessionId: observation.sessionId,
      generation: observation.generation, cursor, type: "runtime_terminal",
      runtimeTerminal: observation, occurredAt: updatedAt } as const;
    const event = sessionEventSchema.parse({
      version: SESSION_BROKER_VERSION.event,
      eventId: eventId(eventBody),
      ...eventBody,
    });
    await client.query(
      `INSERT INTO codeops.session_events
         (event_id, session_id, generation, cursor, event_type, event_json,
          command_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7::timestamptz)`,
      [event.eventId, event.sessionId, event.generation, event.cursor,
        event.type, canonicalJsonText(event), event.occurredAt],
    );
    const updated = await client.query(
      `UPDATE codeops.sessions
          SET snapshot_json = $1::jsonb, updated_at = $2::timestamptz
        WHERE session_id = $3 AND generation = $4 AND lease_id = $5
          AND ((snapshot_json->>'state' IN
                ('running', 'waiting_permission', 'checkpointing')
                AND snapshot_json#>>'{lease,status}' = 'active')
            OR (snapshot_json->>'state' = 'hibernated'
                AND snapshot_json#>>'{lease,status}' = 'released'))`,
      [canonicalJsonText(nextSnapshot), updatedAt, observation.sessionId,
        observation.generation, observation.leaseId],
    );
    if (updated.rowCount !== 1) {
      throw new Error("runtime terminal Session compare-and-swap failed");
    }
    await client.query(
      `UPDATE codeops.provider_effect_receipts
          SET state = 'not_attempted',
              resolution_summary =
                'Runtime became terminal before any provider attempt.',
              reconciliation_action = 'none', resolved_at = $1::timestamptz,
              updated_at = $1::timestamptz
        WHERE session_id = $2 AND session_generation = $3
          AND session_lease_id = $4 AND state = 'authorized'
          AND attempted_at IS NULL`,
      [updatedAt, observation.sessionId, observation.generation,
        observation.leaseId],
    );
    await client.query(
      `DELETE FROM codeops.session_runtime_permission_requests AS permission
        USING codeops.session_runtime_outbox AS outbox
        WHERE permission.dispatch_id = outbox.dispatch_id
          AND outbox.session_id = $1
          AND (outbox.dispatch_json#>>'{command,generation}')::bigint = $2
          AND outbox.dispatch_json#>>'{command,leaseId}' = $3
          AND outbox.status IN ('pending', 'claimed')
          AND NOT EXISTS (
            SELECT 1
              FROM codeops.provider_effect_receipts AS effect
             WHERE effect.dispatch_id = permission.dispatch_id
               AND effect.permission_request_id = permission.request_id
          )`,
      [observation.sessionId, observation.generation, observation.leaseId],
    );
    await client.query(
      `UPDATE codeops.session_runtime_outbox
          SET status = 'pending', claim_token = NULL, claimed_by = NULL,
              claimed_at = NULL, claim_expires_at = NULL
        WHERE session_id = $1
          AND (dispatch_json#>>'{command,generation}')::bigint = $2
          AND dispatch_json#>>'{command,leaseId}' = $3
          AND status = 'claimed'`,
      [observation.sessionId, observation.generation, observation.leaseId],
    );
    await client.query(
      `INSERT INTO codeops.session_runtime_terminal_observations
         (job_uid, session_id, generation, lease_id, run_id,
          job_resource_version, observation_json, event_id, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::jsonb, $8,
               $9::timestamptz)`,
      [observation.job.uid, observation.sessionId, observation.generation,
        observation.leaseId, observation.runId, observation.job.resourceVersion,
        canonicalJsonText(observation), event.eventId, observation.observedAt],
    );
    await client.query("COMMIT");
    return "committed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
