import {
  canonicalJsonText,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionResultSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionSnapshotSchema,
  type SessionRuntimePermissionResult,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import { createHash } from "node:crypto";
import {
  loadSessionSnapshot,
  type TransactionClient,
} from "./session-broker-repository.js";
import { applyRuntimePermissionRequestTransition } from "./session-broker-transitions.js";
import {
  ClaimedDispatchAuthorityConflictError,
  validateClaimedDispatchAuthority,
  type ClaimedDispatchAuthority,
} from "./claimed-dispatch-authority.js";

export class SessionRuntimePermissionNotFoundError extends Error {}
export class SessionRuntimePermissionConflictError extends Error {}

interface StoredDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly owner_principal_id: unknown;
}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
  readonly owner_principal_id: unknown;
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

interface PermissionDecisionRow extends Record<string, unknown> {
  readonly request_id: unknown;
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
}

function assertPermissionOperationIdentity(
  submission: ReturnType<typeof sessionRuntimePermissionSubmissionSchema.parse>,
  dispatchId: string,
): void {
  const operationBytes = canonicalJsonText(submission.request.operation);
  const operationDigest = `sha256:${createHash("sha256")
    .update(operationBytes)
    .digest("hex")}`;
  if (submission.request.operationDigest !== operationDigest) {
    throw new SessionRuntimePermissionConflictError(
      "runtime permission operation digest is invalid",
    );
  }
  if (submission.acpSessionId !== "codeops-work-items") {
    const requestId = `permission-${createHash("sha256")
      .update(operationBytes)
      .update("\0")
      .update(dispatchId)
      .update("\0")
      .update(submission.toolCallId)
      .digest("hex")}`;
    if (submission.request.requestId !== requestId) {
      throw new SessionRuntimePermissionConflictError(
        "runtime permission request does not bind its rendered operation",
      );
    }
  }
}

function validatePermissionAuthority(
  row: StoredDispatchRow,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly now: Date;
    readonly sessionSnapshot?: unknown;
  },
): ClaimedDispatchAuthority {
  try {
    return validateClaimedDispatchAuthority(row, input);
  } catch (error) {
    if (error instanceof ClaimedDispatchAuthorityConflictError) {
      throw new SessionRuntimePermissionConflictError(error.message);
    }
    throw error;
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

async function loadPermissionDecisionRows(
  client: TransactionClient,
  dispatchId: string,
): Promise<readonly PermissionDecisionRow[]> {
  const result = await client.query<PermissionDecisionRow>(
    `SELECT request.request_id, request.request_json,
            decision.command_json, decision.result_json
       FROM codeops.session_runtime_permission_requests AS request
       LEFT JOIN codeops.session_commands AS decision
         ON decision.session_id = request.session_id
        AND decision.command_json->>'type' = 'respond_permission'
        AND decision.command_json->>'permissionRequestId' = request.request_id
      WHERE request.dispatch_id = $1
      ORDER BY request.created_at ASC,
               request.request_id ASC,
               decision.committed_at ASC NULLS LAST,
               decision.command_id ASC NULLS LAST`,
    [dispatchId],
  );
  return result.rows;
}

function sessionRuntimeLineageSnapshot(snapshot: SessionSnapshot): unknown {
  if (snapshot.budget === undefined) return snapshot;
  // Model settlement and elapsed-time projection advance outside session
  // command lineage. Keep the budget identity and limits in that lineage.
  const budgetAuthority = snapshot.budget.version === "codeops.session-budget/v2"
    ? {
        version: snapshot.budget.version,
        budgetId: snapshot.budget.budgetId,
        startedAt: snapshot.budget.startedAt,
        limits: snapshot.budget.limits,
      }
    : {
        version: snapshot.budget.version,
        startedAt: snapshot.budget.startedAt,
        limits: snapshot.budget.limits,
      };
  return { ...snapshot, budget: budgetAuthority };
}

function followsRuntimeLineage(
  expected: SessionSnapshot,
  actual: SessionSnapshot,
): boolean {
  return (
    canonicalJsonText(sessionRuntimeLineageSnapshot(expected)) ===
    canonicalJsonText(sessionRuntimeLineageSnapshot(actual))
  );
}

function validatePermissionDecisionLineage(
  rows: readonly PermissionDecisionRow[],
  input: {
    readonly dispatch: SessionRuntimeDispatch;
    readonly claimToken: string;
    readonly current: SessionSnapshot;
  },
): SessionSnapshot {
  if (rows.length === 0) {
    if (!followsRuntimeLineage(input.dispatch.snapshot, input.current)) {
      throw new SessionRuntimePermissionConflictError(
        "runtime completion snapshot drifted without a permission transition",
      );
    }
    return input.current;
  }
  if (input.dispatch.command.type !== "prompt") {
    throw new SessionRuntimePermissionConflictError(
      "runtime permissions require one claimed prompt dispatch",
    );
  }
  const seen = new Set<string>();
  let previousCursor = input.dispatch.snapshot.eventCursor;
  let finalSnapshot: SessionSnapshot | null = null;
  for (const row of rows) {
    if (
      row.request_id === null ||
      row.request_json === null ||
      row.command_json === null ||
      row.result_json === null
    ) {
      throw new SessionRuntimePermissionConflictError(
        "runtime completion requires every prompt permission to be decided",
      );
    }
    const requestId = String(row.request_id);
    if (seen.has(requestId)) {
      throw new SessionRuntimePermissionConflictError(
        "runtime permission has more than one durable decision",
      );
    }
    seen.add(requestId);
    const submission = sessionRuntimePermissionSubmissionSchema.parse(
      row.request_json,
    );
    const command = sessionCommandSchema.parse(row.command_json);
    const commandResult = sessionCommandResultSchema.parse(row.result_json);
    if (
      requestId !== submission.request.requestId ||
      submission.claimToken !== input.claimToken ||
      command.type !== "respond_permission" ||
      command.sessionId !== input.dispatch.command.sessionId ||
      command.generation !== input.dispatch.command.generation ||
      command.leaseId !== input.dispatch.command.leaseId ||
      command.permissionRequestId !== requestId ||
      commandResult.sessionId !== command.sessionId ||
      commandResult.generation !== command.generation ||
      commandResult.leaseId !== command.leaseId ||
      commandResult.idempotencyKey !== command.idempotencyKey ||
      commandResult.type !== command.type ||
      commandResult.disposition !== "committed" ||
      commandResult.eventCursor <= previousCursor ||
      commandResult.snapshot.state !== "running" ||
      commandResult.snapshot.pendingPermission !== null ||
      commandResult.snapshot.generation !== input.dispatch.snapshot.generation ||
      commandResult.snapshot.lease?.leaseId !== input.dispatch.command.leaseId ||
      canonicalJsonText(commandResult.snapshot.identity) !==
        canonicalJsonText(input.dispatch.snapshot.identity)
    ) {
      throw new SessionRuntimePermissionConflictError(
        "runtime completion does not follow the exact permission decision lineage",
      );
    }
    previousCursor = commandResult.eventCursor;
    finalSnapshot = commandResult.snapshot;
  }
  if (
    finalSnapshot === null ||
    !followsRuntimeLineage(finalSnapshot, input.current)
  ) {
    throw new SessionRuntimePermissionConflictError(
      "runtime completion does not end at the current session snapshot",
    );
  }
  return input.current;
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
  assertPermissionOperationIdentity(submission, input.dispatchId);
  const nowDate = (input.now ?? (() => new Date()))();
  const now = nowDate.toISOString();

  // Read the immutable dispatch identity before entering the transaction so
  // the lock order matches completion ingestion: session first, outbox second.
  // The locked row is revalidated byte-for-byte below.
  const discovered = await client.query<StoredDispatchRow>(
    `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            session.owner_principal_id
       FROM codeops.session_runtime_outbox AS outbox
       JOIN codeops.sessions AS session
         ON session.session_id = outbox.session_id
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId],
  );
  if (!discovered.rows[0]) {
    throw new SessionRuntimePermissionNotFoundError(
      `runtime dispatch ${input.dispatchId} was not found`,
    );
  }
  const discoveredAuthority = validatePermissionAuthority(discovered.rows[0], {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: submission.claimToken,
    now: nowDate,
  });
  const discoveredDispatch = discoveredAuthority.dispatch;

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const sessionRows = await client.query<StoredSessionRow>(
      `SELECT snapshot_json, owner_principal_id
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
      `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
              outbox.claimed_by, outbox.claim_expires_at,
              session.owner_principal_id
         FROM codeops.session_runtime_outbox AS outbox
         JOIN codeops.sessions AS session
           ON session.session_id = outbox.session_id
        WHERE outbox.dispatch_id = $1
        FOR UPDATE OF outbox`,
      [input.dispatchId],
    );
    if (!dispatchRows.rows[0]) {
      throw new SessionRuntimePermissionNotFoundError(
        `runtime dispatch ${input.dispatchId} was not found`,
      );
    }
    const lockedAuthority = validatePermissionAuthority(dispatchRows.rows[0], {
      dispatchId: input.dispatchId,
      workerId: input.workerId,
      claimToken: submission.claimToken,
      now: nowDate,
    });
    const dispatch = lockedAuthority.dispatch;
    if (
      canonicalJsonText(dispatch) !== canonicalJsonText(discoveredDispatch) ||
      canonicalJsonText(lockedAuthority.snapshot) !==
        canonicalJsonText(discoveredAuthority.snapshot)
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
        WHERE dispatch_id = $1 AND request_id = $2
        FOR UPDATE`,
      [input.dispatchId, submission.request.requestId],
    );
    if (existing.rows[0]) {
      const stored = sessionRuntimePermissionSubmissionSchema.parse(
        existing.rows[0].request_json,
      );
      if (
        existing.rows[0].request_id !== submission.request.requestId ||
        canonicalJsonText(stored) !== canonicalJsonText(submission)
      ) {
        throw new SessionRuntimePermissionConflictError(
          "runtime permission request conflicts with its immutable stored identity",
        );
      }
      await client.query("COMMIT");
      return pollSessionRuntimePermission(client, {
        dispatchId: input.dispatchId,
        workerId: input.workerId,
        poll: {
          version: "codeops.session-runtime-permission-poll/v1",
          claimToken: submission.claimToken,
          requestId: submission.request.requestId,
        },
        now: () => nowDate,
      });
    }

    const snapshot = sessionSnapshotSchema.parse(
      sessionRows.rows[0].snapshot_json,
    );
    validatePermissionDecisionLineage(
      await loadPermissionDecisionRows(client, input.dispatchId),
      { dispatch, claimToken: submission.claimToken, current: snapshot },
    );
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
        canonicalJsonText(submission),
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
        canonicalJsonText(transition.event),
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
        canonicalJsonText(transition.snapshot),
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
  const current = await loadSessionSnapshot(
    client,
    input.dispatch.command.sessionId,
  );
  if (current === null) {
    throw new SessionRuntimePermissionNotFoundError(
      `session ${input.dispatch.command.sessionId} was not found`,
    );
  }
  return validatePermissionDecisionLineage(
    await loadPermissionDecisionRows(client, input.dispatch.dispatchId),
    { dispatch: input.dispatch, claimToken: input.claimToken, current },
  );
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
  const now = (input.now ?? (() => new Date()))();
  const result = await client.query<PolledPermissionRow>(
    `SELECT request.request_json,
            outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            session.snapshot_json,
            session.owner_principal_id,
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
  const dispatch = validatePermissionAuthority(row, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: poll.claimToken,
    now,
  }).dispatch;
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
