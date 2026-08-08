import { randomUUID } from "node:crypto";
import {
  sessionCommandResultSchema,
  type SessionCommandResult,
  type SessionSnapshot,
} from "@renoconcierge/codeops-contracts";
import {
  executeSessionCommandTransaction,
  type TransactionClient,
} from "./session-broker-repository.js";
import {
  applySessionRuntimeCompletion,
  buildSessionRuntimeDispatch,
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchSchema,
  type SessionRuntimeDispatch,
} from "./session-broker-runtime.js";
import { resolveSessionRuntimeCompletionSnapshot } from "./session-runtime-permissions.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class ImmutableSessionRuntimeDispatchConflictError extends Error {}
export class SessionRuntimeDispatchNotFoundError extends Error {}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
}

interface StoredDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
}

interface ClaimedDispatchRow extends StoredDispatchRow {
  readonly claim_token: unknown;
  readonly claim_expires_at: unknown;
  readonly claim_count: unknown;
}

interface CompletedDispatchRow extends StoredDispatchRow {
  readonly status: unknown;
  readonly completion_json: unknown;
  readonly result_json: unknown;
  readonly completed_by: unknown;
}

function postgresTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("runtime claim persistence returned an invalid timestamp");
  }
  return parsed.toISOString();
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

export async function enqueueSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly command: unknown;
    readonly principalId: string;
    readonly now?: () => Date;
    readonly dispatchId?: () => string;
  },
): Promise<SessionRuntimeDispatch> {
  const dispatchedAt = (input.now ?? (() => new Date()))().toISOString();
  const dispatchId = (input.dispatchId ?? randomUUID)();

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await client.query<StoredSessionRow>(
      `SELECT snapshot_json
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [
        typeof input.command === "object" && input.command !== null
          ? (input.command as { readonly sessionId?: unknown }).sessionId
          : null,
      ],
    );
    if (!locked.rows[0]) {
      throw new Error("runtime dispatch session was not found");
    }
    const snapshot = locked.rows[0].snapshot_json as SessionSnapshot;
    const dispatch = buildSessionRuntimeDispatch({
      dispatchId,
      principalId: input.principalId,
      command: input.command,
      snapshot,
      dispatchedAt,
    });

    const committedCommand = await client.query(
      `SELECT command_json
         FROM codeops.session_commands
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [dispatch.command.sessionId, dispatch.command.idempotencyKey],
    );
    if (committedCommand.rows[0]) {
      throw new ImmutableSessionRuntimeDispatchConflictError(
        `runtime dispatch ${dispatch.command.idempotencyKey} conflicts with an already committed command for ${dispatch.command.sessionId}`,
      );
    }

    const existing = await client.query<StoredDispatchRow>(
      `SELECT dispatch_json
         FROM codeops.session_runtime_outbox
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [dispatch.command.sessionId, dispatch.command.idempotencyKey],
    );
    if (existing.rows[0]) {
      const stored = sessionRuntimeDispatchSchema.parse(
        existing.rows[0].dispatch_json,
      );
      if (
        stored.principalId !== dispatch.principalId ||
        canonical(stored.command) !== canonical(dispatch.command)
      ) {
        throw new ImmutableSessionRuntimeDispatchConflictError(
          `runtime dispatch ${dispatch.command.idempotencyKey} conflicts with the immutable dispatch for ${dispatch.command.sessionId}`,
        );
      }
      await client.query("COMMIT");
      return stored;
    }

    await client.query(
      `INSERT INTO codeops.session_runtime_outbox
         (dispatch_id, session_id, idempotency_key, principal_id,
          dispatch_json, status, available_at, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6::timestamptz, $6::timestamptz)`,
      [
        dispatch.dispatchId,
        dispatch.command.sessionId,
        dispatch.command.idempotencyKey,
        dispatch.principalId,
        canonical(dispatch),
        dispatch.dispatchedAt,
      ],
    );
    await client.query("COMMIT");
    return dispatch;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export interface SessionRuntimeDispatchClaim {
  readonly dispatch: SessionRuntimeDispatch;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly claimCount: number;
}

export async function claimSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly workerId: string;
    readonly leaseMs: number;
    readonly now?: () => Date;
    readonly claimToken?: () => string;
  },
): Promise<SessionRuntimeDispatchClaim | null> {
  requireWorkerId(input.workerId);
  if (
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 15 * 60_000
  ) {
    throw new Error("runtime claim lease must be between 1 second and 15 minutes");
  }
  const now = (input.now ?? (() => new Date()))();
  const claimedAt = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const claimToken = (input.claimToken ?? randomUUID)();
  const result = await client.query<ClaimedDispatchRow>(
    `WITH candidate AS (
       SELECT dispatch_id
         FROM codeops.session_runtime_outbox
        WHERE available_at <= $1::timestamptz
          AND (
            status = 'pending'
            OR (status = 'claimed' AND claim_expires_at <= $1::timestamptz)
          )
        ORDER BY available_at ASC, created_at ASC, dispatch_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE codeops.session_runtime_outbox AS outbox
        SET status = 'claimed',
            claim_token = $2,
            claimed_by = $3,
            claimed_at = $1::timestamptz,
            claim_expires_at = $4::timestamptz,
            claim_count = outbox.claim_count + 1
       FROM candidate
      WHERE outbox.dispatch_id = candidate.dispatch_id
      RETURNING outbox.dispatch_json, outbox.claim_token,
                outbox.claim_expires_at, outbox.claim_count`,
    [claimedAt, claimToken, input.workerId, claimExpiresAt],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  if (
    row.claim_token !== claimToken ||
    postgresTimestamp(row.claim_expires_at) !== claimExpiresAt ||
    !Number.isSafeInteger(row.claim_count) ||
    Number(row.claim_count) < 1
  ) {
    throw new Error("runtime claim persistence did not match the requested lease");
  }
  return {
    dispatch: sessionRuntimeDispatchSchema.parse(row.dispatch_json),
    claimToken,
    claimExpiresAt,
    claimCount: Number(row.claim_count),
  };
}

function duplicateRuntimeResult(
  result: SessionCommandResult,
): SessionCommandResult {
  if (result.disposition !== "committed") return result;
  return sessionCommandResultSchema.parse({
    ...result,
    disposition: "duplicate",
    originalCommandId: result.commandId,
  });
}

export async function completeSessionRuntimeDispatch(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly completion: unknown;
    readonly now?: () => Date;
    readonly commandId?: () => string;
  },
): Promise<SessionCommandResult> {
  const completion = sessionRuntimeCompletionSchema.parse(input.completion);
  requireWorkerId(input.workerId);
  if (completion.dispatchId !== input.dispatchId) {
    throw new Error("runtime completion does not match the requested dispatch");
  }
  const stored = await client.query<CompletedDispatchRow>(
    `SELECT dispatch_json, status, completion_json, result_json, completed_by
       FROM codeops.session_runtime_outbox
      WHERE dispatch_id = $1`,
    [input.dispatchId],
  );
  if (!stored.rows[0]) {
    throw new SessionRuntimeDispatchNotFoundError(
      `runtime dispatch ${input.dispatchId} was not found`,
    );
  }
  const row = stored.rows[0];
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (row.status === "completed") {
    const persistedCompletion = sessionRuntimeCompletionSchema.parse(
      row.completion_json,
    );
    if (
      row.completed_by !== input.workerId ||
      canonical(persistedCompletion) !== canonical(completion)
    ) {
      throw new ImmutableSessionRuntimeDispatchConflictError(
        `runtime dispatch ${input.dispatchId} already has a different immutable completion`,
      );
    }
    return duplicateRuntimeResult(
      sessionCommandResultSchema.parse(row.result_json),
    );
  }

  const completionSnapshot = await resolveSessionRuntimeCompletionSnapshot(
    client,
    { dispatch, claimToken: input.claimToken },
  );

  return executeSessionCommandTransaction(client, {
    command: dispatch.command,
    principalId: dispatch.principalId,
    now: input.now,
    commandId: input.commandId,
    mutate: (_snapshot, _command, context) =>
      applySessionRuntimeCompletion(
        dispatch,
        completion,
        context,
        completionSnapshot,
      ),
    runtimeReservation: {
      dispatchId: dispatch.dispatchId,
      claimToken: input.claimToken,
      workerId: input.workerId,
      expectedSnapshot: completionSnapshot,
      dispatchJson: dispatch,
      completionJson: completion,
    },
  });
}
