import {
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionResultSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionSnapshotSchema,
  type SessionRuntimePermissionResult,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import { applyRuntimePermissionRequestTransition } from "./session-broker-transitions.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class SessionRuntimePermissionNotFoundError extends Error {}
export class SessionRuntimePermissionConflictError extends Error {}

interface StoredDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
}

interface StoredPermissionRow extends Record<string, unknown> {
  readonly request_id: unknown;
  readonly request_json: unknown;
}

interface PolledPermissionRow extends StoredDispatchRow, StoredSessionRow {
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
}

interface CompletionSnapshotRow extends StoredSessionRow {
  readonly request_id: unknown;
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function requireWorkerId(workerId: string): void {
  if (!workerPattern.test(workerId)) {
    throw new Error("runtime worker must be a bounded audit identity");
  }
}

function requireLiveClaim(
  row: StoredDispatchRow,
  input: { readonly claimToken: string; readonly workerId: string },
  now: string,
): void {
  const claimExpiresAt = Date.parse(String(row.claim_expires_at));
  if (
    row.status !== "claimed" ||
    row.claim_token !== input.claimToken ||
    row.claimed_by !== input.workerId ||
    !Number.isFinite(claimExpiresAt) ||
    claimExpiresAt <= Date.parse(now)
  ) {
    throw new SessionRuntimePermissionConflictError(
      "runtime permission request does not hold the exact live dispatch claim",
    );
  }
}

function pendingResult(
  dispatchId: string,
  requestId: string,
): SessionRuntimePermissionResult {
  return sessionRuntimePermissionResultSchema.parse({
    version: "codeops.session-runtime-permission-result/v1",
    dispatchId,
    requestId,
    disposition: "pending",
    decision: null,
  });
}

export async function submitSessionRuntimePermission(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly submission: unknown;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimePermissionResult> {
  const submission = sessionRuntimePermissionSubmissionSchema.parse(
    input.submission,
  );
  requireWorkerId(input.workerId);
  const now = (input.now ?? (() => new Date()))().toISOString();

  // Read the immutable dispatch identity before entering the transaction so
  // the lock order matches completion ingestion: session first, outbox second.
  // The locked row is revalidated byte-for-byte below.
  const discovered = await client.query<StoredDispatchRow>(
    `SELECT dispatch_json, status, claim_token, claimed_by, claim_expires_at
       FROM codeops.session_runtime_outbox
      WHERE dispatch_id = $1`,
    [input.dispatchId],
  );
  if (!discovered.rows[0]) {
    throw new SessionRuntimePermissionNotFoundError(
      `runtime dispatch ${input.dispatchId} was not found`,
    );
  }
  const discoveredDispatch = sessionRuntimeDispatchSchema.parse(
    discovered.rows[0].dispatch_json,
  );

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const sessionRows = await client.query<StoredSessionRow>(
      `SELECT snapshot_json
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [discoveredDispatch.command.sessionId],
    );
    if (!sessionRows.rows[0]) {
      throw new SessionRuntimePermissionNotFoundError(
        `session ${discoveredDispatch.command.sessionId} was not found`,
      );
    }
    const dispatchRows = await client.query<StoredDispatchRow>(
      `SELECT dispatch_json, status, claim_token, claimed_by, claim_expires_at
         FROM codeops.session_runtime_outbox
        WHERE dispatch_id = $1
        FOR UPDATE`,
      [input.dispatchId],
    );
    if (!dispatchRows.rows[0]) {
      throw new SessionRuntimePermissionNotFoundError(
        `runtime dispatch ${input.dispatchId} was not found`,
      );
    }
    const dispatchRow = dispatchRows.rows[0];
    requireLiveClaim(
      dispatchRow,
      { claimToken: submission.claimToken, workerId: input.workerId },
      now,
    );
    const dispatch = sessionRuntimeDispatchSchema.parse(
      dispatchRow.dispatch_json,
    );
    if (
      canonical(dispatch) !== canonical(discoveredDispatch) ||
      dispatch.dispatchId !== input.dispatchId ||
      dispatch.command.type !== "prompt"
    ) {
      throw new SessionRuntimePermissionConflictError(
        "runtime permissions belong only to the exact claimed prompt dispatch",
      );
    }
    if (
      Date.parse(submission.request.requestedAt) <
        Date.parse(dispatch.dispatchedAt) ||
      Date.parse(submission.request.requestedAt) > Date.parse(now)
    ) {
      throw new SessionRuntimePermissionConflictError(
        "runtime permission request time is outside the live dispatch window",
      );
    }

    const existing = await client.query<StoredPermissionRow>(
      `SELECT request_id, request_json
         FROM codeops.session_runtime_permission_requests
        WHERE dispatch_id = $1
        FOR UPDATE`,
      [input.dispatchId],
    );
    if (existing.rows[0]) {
      const stored = sessionRuntimePermissionSubmissionSchema.parse(
        existing.rows[0].request_json,
      );
      if (
        existing.rows[0].request_id !== submission.request.requestId ||
        canonical(stored) !== canonical(submission)
      ) {
        throw new SessionRuntimePermissionConflictError(
          "runtime permission request conflicts with its immutable stored identity",
        );
      }
      await client.query("COMMIT");
      return pendingResult(input.dispatchId, submission.request.requestId);
    }

    const snapshot = sessionSnapshotSchema.parse(
      sessionRows.rows[0].snapshot_json,
    );
    if (canonical(snapshot) !== canonical(dispatch.snapshot)) {
      throw new SessionRuntimePermissionConflictError(
        "runtime permission request no longer binds the dispatched snapshot",
      );
    }
    const transition = applyRuntimePermissionRequestTransition(
      snapshot,
      submission.request,
      now,
    );

    await client.query(
      `INSERT INTO codeops.session_runtime_permission_requests
         (dispatch_id, request_id, session_id, request_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [
        input.dispatchId,
        submission.request.requestId,
        dispatch.command.sessionId,
        canonical(submission),
        submission.request.requestedAt,
      ],
    );
    await client.query(
      `INSERT INTO codeops.session_events
         (event_id, session_id, generation, cursor, event_type, event_json,
          command_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7::timestamptz)`,
      [
        transition.event.eventId,
        transition.event.sessionId,
        transition.event.generation,
        transition.event.cursor,
        transition.event.type,
        canonical(transition.event),
        transition.event.occurredAt,
      ],
    );
    const updated = await client.query(
      `UPDATE codeops.sessions
          SET snapshot_json = $1::jsonb,
              generation = $2,
              lease_id = $3,
              updated_at = $4::timestamptz
        WHERE session_id = $5
          AND generation = $6
          AND lease_id = $7`,
      [
        canonical(transition.snapshot),
        transition.snapshot.generation,
        transition.snapshot.lease?.leaseId ?? null,
        transition.snapshot.updatedAt,
        snapshot.sessionId,
        snapshot.generation,
        snapshot.lease?.leaseId ?? null,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new SessionRuntimePermissionConflictError(
        "session changed before the permission request committed",
      );
    }
    await client.query("COMMIT");
    return pendingResult(input.dispatchId, submission.request.requestId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function resolveSessionRuntimeCompletionSnapshot(
  client: TransactionClient,
  input: {
    readonly dispatch: SessionRuntimeDispatch;
    readonly claimToken: string;
  },
): Promise<SessionSnapshot> {
  const result = await client.query<CompletionSnapshotRow>(
    `SELECT session.snapshot_json,
            request.request_id, request.request_json,
            decision.command_json, decision.result_json
       FROM codeops.sessions AS session
       LEFT JOIN codeops.session_runtime_permission_requests AS request
         ON request.dispatch_id = $1
       LEFT JOIN LATERAL (
         SELECT command_json, result_json
           FROM codeops.session_commands
          WHERE session_id = request.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = request.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE session.session_id = $2`,
    [input.dispatch.dispatchId, input.dispatch.command.sessionId],
  );
  if (!result.rows[0]) {
    throw new SessionRuntimePermissionNotFoundError(
      `session ${input.dispatch.command.sessionId} was not found`,
    );
  }
  if (result.rows.length !== 1) {
    throw new SessionRuntimePermissionConflictError(
      "runtime dispatch has more than one permission request",
    );
  }
  const row = result.rows[0];
  const current = sessionSnapshotSchema.parse(row.snapshot_json);
  if (row.request_id === null) {
    if (canonical(current) !== canonical(input.dispatch.snapshot)) {
      throw new SessionRuntimePermissionConflictError(
        "runtime completion snapshot drifted without a permission transition",
      );
    }
    return current;
  }
  if (
    input.dispatch.command.type !== "prompt" ||
    row.request_json === null ||
    row.command_json === null ||
    row.result_json === null
  ) {
    throw new SessionRuntimePermissionConflictError(
      "runtime completion requires one decided prompt permission",
    );
  }
  const submission = sessionRuntimePermissionSubmissionSchema.parse(
    row.request_json,
  );
  const command = sessionCommandSchema.parse(row.command_json);
  const commandResult = sessionCommandResultSchema.parse(row.result_json);
  if (
    row.request_id !== submission.request.requestId ||
    submission.claimToken !== input.claimToken ||
    command.type !== "respond_permission" ||
    command.sessionId !== input.dispatch.command.sessionId ||
    command.generation !== input.dispatch.command.generation ||
    command.leaseId !== input.dispatch.command.leaseId ||
    command.permissionRequestId !== submission.request.requestId ||
    commandResult.sessionId !== command.sessionId ||
    commandResult.generation !== command.generation ||
    commandResult.leaseId !== command.leaseId ||
    commandResult.idempotencyKey !== command.idempotencyKey ||
    commandResult.type !== command.type ||
    commandResult.disposition !== "committed" ||
    commandResult.eventCursor !== input.dispatch.snapshot.eventCursor + 2 ||
    commandResult.snapshot.state !== "running" ||
    commandResult.snapshot.pendingPermission !== null ||
    canonical(commandResult.snapshot) !== canonical(current)
  ) {
    throw new SessionRuntimePermissionConflictError(
      "runtime completion does not follow the exact permission decision lineage",
    );
  }
  return current;
}

export async function pollSessionRuntimePermission(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly poll: unknown;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimePermissionResult> {
  const poll = sessionRuntimePermissionPollSchema.parse(input.poll);
  requireWorkerId(input.workerId);
  const now = (input.now ?? (() => new Date()))().toISOString();
  const result = await client.query<PolledPermissionRow>(
    `SELECT request.request_json,
            outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            session.snapshot_json,
            decision.command_json, decision.result_json
       FROM codeops.session_runtime_permission_requests AS request
       JOIN codeops.session_runtime_outbox AS outbox
         ON outbox.dispatch_id = request.dispatch_id
       JOIN codeops.sessions AS session
         ON session.session_id = request.session_id
       LEFT JOIN LATERAL (
         SELECT command_json, result_json
           FROM codeops.session_commands
          WHERE session_id = request.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = request.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE request.dispatch_id = $1 AND request.request_id = $2`,
    [input.dispatchId, poll.requestId],
  );
  if (!result.rows[0]) {
    throw new SessionRuntimePermissionNotFoundError(
      `runtime permission request ${poll.requestId} was not found`,
    );
  }
  const row = result.rows[0];
  requireLiveClaim(
    row,
    { claimToken: poll.claimToken, workerId: input.workerId },
    now,
  );
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  const submission = sessionRuntimePermissionSubmissionSchema.parse(
    row.request_json,
  );
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  if (
    dispatch.dispatchId !== input.dispatchId ||
    submission.request.requestId !== poll.requestId
  ) {
    throw new SessionRuntimePermissionConflictError(
      "stored runtime permission identity drifted",
    );
  }
  if (
    snapshot.state === "waiting_permission" &&
    snapshot.pendingPermission?.requestId === poll.requestId
  ) {
    if (row.command_json !== null || row.result_json !== null) {
      throw new SessionRuntimePermissionConflictError(
        "pending runtime permission already has a stored decision",
      );
    }
    return pendingResult(input.dispatchId, poll.requestId);
  }
  if (row.command_json === null || row.result_json === null) {
    throw new SessionRuntimePermissionConflictError(
      "runtime permission left its pending state without a stored decision",
    );
  }
  const command = sessionCommandSchema.parse(row.command_json);
  const commandResult = sessionCommandResultSchema.parse(row.result_json);
  if (
    command.type !== "respond_permission" ||
    command.sessionId !== dispatch.command.sessionId ||
    command.permissionRequestId !== poll.requestId ||
    commandResult.sessionId !== command.sessionId ||
    commandResult.generation !== command.generation ||
    commandResult.leaseId !== command.leaseId ||
    commandResult.idempotencyKey !== command.idempotencyKey ||
    commandResult.type !== command.type ||
    commandResult.disposition !== "committed"
  ) {
    throw new SessionRuntimePermissionConflictError(
      "runtime permission decision does not bind the immutable request",
    );
  }
  const brokerDecision = command.decision;
  const decision =
    brokerDecision.outcome === "denied"
      ? { outcome: "denied" as const }
      : (() => {
          const mapped = submission.options.find(
            ({ optionId }) => optionId === brokerDecision.optionId,
          );
          if (!mapped) {
            throw new SessionRuntimePermissionConflictError(
              "runtime permission decision selected an unmapped option",
            );
          }
          return {
            outcome: "selected" as const,
            acpOptionId: mapped.acpOptionId,
          };
        })();
  return sessionRuntimePermissionResultSchema.parse({
    version: "codeops.session-runtime-permission-result/v1",
    dispatchId: input.dispatchId,
    requestId: poll.requestId,
    disposition: "decided",
    decision,
  });
}
