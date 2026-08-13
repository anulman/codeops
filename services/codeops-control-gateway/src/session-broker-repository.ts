import { randomUUID } from "node:crypto";
import {
  isWorkspaceSessionIdentity,
  SESSION_BROKER_VERSION,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type SessionCommand,
  type SessionCommandResult,
  type SessionEvent,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";

export interface TransactionClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }>;
}

export class ImmutableSessionCommandConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly idempotencyKey: string,
  ) {
    super(
      `session command ${idempotencyKey} conflicts with the immutable command already persisted for ${sessionId}`,
    );
  }
}

export class SessionNotFoundError extends Error {}
export class SessionCompareAndSwapError extends Error {}
export class SessionForkConflictError extends Error {}
export class SessionRuntimeClaimConflictError extends Error {}

const sessionIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireSessionIdentifier(sessionId: string): void {
  if (!sessionIdentifier.test(sessionId)) {
    throw new Error("session identifier is invalid");
  }
}

function requireReadLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`read limit must be between 1 and ${maximum}`);
  }
}

export async function loadSessionSnapshot(
  client: TransactionClient,
  sessionId: string,
): Promise<SessionSnapshot | null> {
  requireSessionIdentifier(sessionId);
  const result = await client.query<StoredSessionRow>(
    `SELECT snapshot_json
       FROM codeops.sessions
      WHERE session_id = $1`,
    [sessionId],
  );
  if (!result.rows[0]) return null;
  const snapshot = sessionSnapshotSchema.parse(result.rows[0].snapshot_json);
  if (snapshot.sessionId !== sessionId) {
    throw new Error("stored snapshot does not match the requested session");
  }
  return snapshot;
}

export async function listSessionSnapshots(
  client: TransactionClient,
  limit = 100,
): Promise<readonly SessionSnapshot[]> {
  requireReadLimit(limit, 200);
  const result = await client.query<StoredSessionRow>(
    `SELECT snapshot_json
       FROM codeops.sessions
      ORDER BY updated_at DESC, session_id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(({ snapshot_json }) =>
    sessionSnapshotSchema.parse(snapshot_json),
  );
}

interface StoredEventRow extends Record<string, unknown> {
  readonly event_json: unknown;
}

export async function loadSessionEvents(
  client: TransactionClient,
  input: {
    readonly sessionId: string;
    readonly afterCursor?: number;
    readonly limit?: number;
  },
): Promise<readonly SessionEvent[]> {
  requireSessionIdentifier(input.sessionId);
  const afterCursor = input.afterCursor ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new Error("event cursor must be a non-negative safe integer");
  }
  requireReadLimit(limit, 500);
  const result = await client.query<StoredEventRow>(
    `SELECT event_json
       FROM codeops.session_events
      WHERE session_id = $1 AND cursor > $2
      ORDER BY cursor ASC
      LIMIT $3`,
    [input.sessionId, afterCursor, limit],
  );
  const events = result.rows.map(({ event_json }) =>
    sessionEventSchema.parse(event_json),
  );
  for (const [index, event] of events.entries()) {
    if (
      event.sessionId !== input.sessionId ||
      event.cursor !== afterCursor + index + 1
    ) {
      throw new Error(
        "stored events must match the requested session and contiguous cursor",
      );
    }
  }
  return events;
}

interface ExecuteSessionCommandInput {
  readonly command: unknown;
  readonly principalId: string;
  readonly now?: () => Date;
  readonly commandId?: () => string;
  readonly mutate: (
    snapshot: SessionSnapshot,
    command: SessionCommand,
    context: SessionMutationContext,
  ) => Promise<SessionMutation> | SessionMutation;
  readonly runtimeReservation?: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly expectedSnapshot: SessionSnapshot;
    readonly dispatchJson: unknown;
    readonly completionJson: unknown;
  };
}

export interface SessionMutationContext {
  readonly commandId: string;
  readonly committedAt: string;
}

export interface SessionMutation {
  readonly result: SessionCommandResult;
  readonly events: readonly SessionEvent[];
}

interface StoredCommandRow extends Record<string, unknown> {
  readonly command_json: unknown;
  readonly result_json: unknown;
}

interface StoredRuntimeDispatchRow extends Record<string, unknown> {
  readonly dispatch_id: unknown;
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
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

function requireResultIdentity(
  result: SessionCommandResult,
  command: SessionCommand,
): void {
  if (
    result.sessionId !== command.sessionId ||
    result.generation !== command.generation ||
    result.leaseId !== command.leaseId ||
    result.idempotencyKey !== command.idempotencyKey ||
    result.type !== command.type
  ) {
    throw new Error("session mutator result does not match the command identity");
  }
}

function requireForkIdentity(
  snapshot: SessionSnapshot,
  command: Extract<SessionCommand, { readonly type: "fork" }>,
  result: SessionCommandResult,
): void {
  const parentIdentity = snapshot.identity;
  const childIdentity = result.snapshot.identity;
  const sourceIdentityMatches = isWorkspaceSessionIdentity(parentIdentity)
    ? isWorkspaceSessionIdentity(childIdentity) &&
      canonical(childIdentity.workspace) === canonical(parentIdentity.workspace)
    : !isWorkspaceSessionIdentity(childIdentity) &&
      childIdentity.repository === parentIdentity.repository &&
      childIdentity.baseSha === parentIdentity.baseSha;
  if (
    snapshot.checkpoint?.checkpointId !== command.checkpointId ||
    snapshot.eventCursor !== command.parentEventCursor ||
    result.snapshot.identity.parentSessionId !== snapshot.sessionId ||
    result.snapshot.identity.forkedAtCursor !== snapshot.eventCursor ||
    !sourceIdentityMatches ||
    result.snapshot.generation !== 1
  ) {
    throw new Error(
      "fork must bind the exact parent checkpoint, cursor, repository, and base SHA",
    );
  }
}

function duplicateResult(result: SessionCommandResult): SessionCommandResult {
  if (result.disposition !== "committed") return result;
  return sessionCommandResultSchema.parse({
    ...result,
    disposition: "duplicate",
    originalCommandId: result.commandId,
  });
}

function rejectedResult(
  snapshot: SessionSnapshot,
  command: SessionCommand,
  code: "generation_conflict" | "lease_conflict" | "capability_unavailable",
  reason: string,
  committedAt: string,
  commandId: string,
): SessionCommandResult {
  return sessionCommandResultSchema.parse({
    version: SESSION_BROKER_VERSION.commandResult,
    commandId,
    sessionId: command.sessionId,
    generation: command.generation,
    leaseId: command.leaseId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    eventCursor: snapshot.eventCursor,
    snapshot,
    committedAt,
    disposition: "rejected",
    rejectionCode: code,
    reason,
  });
}

async function persistCommand(
  client: TransactionClient,
  command: SessionCommand,
  result: SessionCommandResult,
  principalId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO codeops.session_commands
       (command_id, session_id, idempotency_key, command_json, result_json,
        principal_id, committed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::timestamptz)`,
    [
      result.commandId,
      command.sessionId,
      command.idempotencyKey,
      canonical(command),
      canonical(result),
      principalId,
      result.committedAt,
    ],
  );
}

async function persistEvents(
  client: TransactionClient,
  commandId: string,
  events: readonly SessionEvent[],
): Promise<void> {
  for (const event of events) {
    await client.query(
      `INSERT INTO codeops.session_events
         (event_id, session_id, generation, cursor, event_type, event_json,
          command_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)`,
      [
        event.eventId,
        event.sessionId,
        event.generation,
        event.cursor,
        event.type,
        canonical(event),
        commandId,
        event.occurredAt,
      ],
    );
  }
}

async function persistForkedSession(
  client: TransactionClient,
  snapshot: SessionSnapshot,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO codeops.sessions
       (session_id, generation, lease_id, snapshot_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      snapshot.sessionId,
      snapshot.generation,
      snapshot.lease?.leaseId ?? null,
      canonical(snapshot),
      snapshot.updatedAt,
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new SessionForkConflictError(
      `fork child session ${snapshot.sessionId} already exists`,
    );
  }
}

function requireOrderedEvents(
  snapshot: SessionSnapshot,
  command: SessionCommand,
  result: SessionCommandResult,
  rawEvents: readonly SessionEvent[],
): readonly SessionEvent[] {
  if (rawEvents.length === 0) {
    throw new Error("a committed session mutation must persist at least one event");
  }
  const events = rawEvents.map((event) => sessionEventSchema.parse(event));
  // A fork begins a new independently pageable event stream. Parent lineage
  // lives in identity.forkedAtCursor; copying the parent's cursor into the
  // child stream would make loadSessionEvents(child, afterCursor=0) fail.
  const previousCursor = command.type === "fork" ? 0 : snapshot.eventCursor;
  for (const [index, event] of events.entries()) {
    if (
      event.sessionId !== result.snapshot.sessionId ||
      event.generation !== result.snapshot.generation ||
      event.cursor !== previousCursor + index + 1
    ) {
      throw new Error("session mutation events must form one ordered snapshot history");
    }
  }
  if (
    result.eventCursor !== result.snapshot.eventCursor ||
    result.eventCursor !== events.at(-1)?.cursor
  ) {
    throw new Error("session mutation cursor must end at its final persisted event");
  }
  return events;
}

async function completeRuntimeReservation(
  client: TransactionClient,
  reservation: NonNullable<ExecuteSessionCommandInput["runtimeReservation"]>,
  result: SessionCommandResult,
  completedAt: string,
): Promise<void> {
  const completed = await client.query(
    `UPDATE codeops.session_runtime_outbox
        SET status = 'completed',
            claim_token = NULL,
            claimed_by = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            completion_json = $1::jsonb,
            result_json = $2::jsonb,
            completed_by = $3,
            completed_at = $4::timestamptz
      WHERE dispatch_id = $5
        AND status = 'claimed'
        AND claim_token = $6
        AND claimed_by = $3
        AND claim_expires_at > $4::timestamptz`,
    [
      canonical(reservation.completionJson),
      canonical(result),
      reservation.workerId,
      completedAt,
      reservation.dispatchId,
      reservation.claimToken,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SessionRuntimeClaimConflictError(
      `runtime claim ${reservation.claimToken} expired before completion committed`,
    );
  }
}

export async function executeSessionCommandTransaction(
  client: TransactionClient,
  input: ExecuteSessionCommandInput,
): Promise<SessionCommandResult> {
  const command = sessionCommandSchema.parse(input.command);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.principalId)) {
    throw new Error("session command principal must be a bounded audit identity");
  }
  const committedAt = (input.now ?? (() => new Date()))().toISOString();
  const commandId = (input.commandId ?? randomUUID)();

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Lock the session before looking up idempotency. This gives every command
    // for one session a single serialization point, including two first-time
    // requests racing with the same key.
    const locked = await client.query<StoredSessionRow>(
      `SELECT snapshot_json
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [command.sessionId],
    );
    if (!locked.rows[0]) {
      throw new SessionNotFoundError(`session ${command.sessionId} not found`);
    }
    const snapshot = sessionSnapshotSchema.parse(locked.rows[0].snapshot_json);

    const reservedRuntimeDispatch = await client.query<StoredRuntimeDispatchRow>(
      `SELECT dispatch_id, dispatch_json, status, claim_token, claimed_by,
              claim_expires_at
         FROM codeops.session_runtime_outbox
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [command.sessionId, command.idempotencyKey],
    );
    const runtimeRow = reservedRuntimeDispatch.rows[0];
    if (runtimeRow || input.runtimeReservation) {
      const reservation = input.runtimeReservation;
      if (
        !runtimeRow ||
        !reservation ||
        runtimeRow.dispatch_id !== reservation.dispatchId ||
        runtimeRow.status !== "claimed" ||
        runtimeRow.claim_token !== reservation.claimToken ||
        runtimeRow.claimed_by !== reservation.workerId ||
        canonical(runtimeRow.dispatch_json) !==
          canonical(reservation.dispatchJson) ||
        canonical(snapshot) !== canonical(reservation.expectedSnapshot) ||
        new Date(String(runtimeRow.claim_expires_at)).getTime() <=
          Date.parse(committedAt)
      ) {
        if (!reservation) {
          throw new ImmutableSessionCommandConflictError(
            command.sessionId,
            command.idempotencyKey,
          );
        }
        throw new SessionRuntimeClaimConflictError(
          `runtime claim ${reservation.claimToken} is stale or does not bind the exact dispatch snapshot`,
        );
      }
    }

    const existing = await client.query<StoredCommandRow>(
      `SELECT command_json, result_json
         FROM codeops.session_commands
        WHERE session_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [command.sessionId, command.idempotencyKey],
    );
    if (existing.rows[0]) {
      const storedCommand = sessionCommandSchema.parse(
        existing.rows[0].command_json,
      );
      if (canonical(storedCommand) !== canonical(command)) {
        throw new ImmutableSessionCommandConflictError(
          command.sessionId,
          command.idempotencyKey,
        );
      }
      const result = duplicateResult(
        sessionCommandResultSchema.parse(existing.rows[0].result_json),
      );
      if (input.runtimeReservation) {
        await completeRuntimeReservation(
          client,
          input.runtimeReservation,
          result,
          committedAt,
        );
      }
      await client.query("COMMIT");
      return result;
    }

    let result: SessionCommandResult;
    if (snapshot.generation !== command.generation) {
      result = rejectedResult(
        snapshot,
        command,
        "generation_conflict",
        "The session generation changed before this command committed.",
        committedAt,
        commandId,
      );
    } else if (snapshot.lease?.leaseId !== command.leaseId) {
      result = rejectedResult(
        snapshot,
        command,
        "lease_conflict",
        "The command does not hold the current session lease.",
        committedAt,
        commandId,
      );
    } else {
      const capability = snapshot.capabilities.find(
        ({ action }) => action === command.type,
      );
      if (!capability || capability.availability !== "enabled") {
        result = rejectedResult(
          snapshot,
          command,
          "capability_unavailable",
          capability?.availability === "disabled"
            ? capability.reason
            : "The action is unavailable in this session state.",
          committedAt,
          commandId,
        );
      } else {
        const mutation = await input.mutate(snapshot, command, {
          commandId,
          committedAt,
        });
        result = sessionCommandResultSchema.parse(mutation.result);
        requireResultIdentity(result, command);
        if (result.disposition !== "committed") {
          throw new Error("session mutator must return a committed result");
        }
        if (command.type === "fork") {
          requireForkIdentity(snapshot, command, result);
        }
        const events = requireOrderedEvents(
          snapshot,
          command,
          result,
          mutation.events,
        );
        if (command.type === "fork") {
          await persistForkedSession(client, result.snapshot);
        }
        await persistEvents(client, result.commandId, events);
        if (command.type !== "fork") {
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
              canonical(result.snapshot),
              result.snapshot.generation,
              result.snapshot.lease?.leaseId ?? null,
              result.snapshot.updatedAt,
              command.sessionId,
              command.generation,
              command.leaseId,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new SessionCompareAndSwapError(
              `session ${command.sessionId} changed during command commit`,
            );
          }
        }
      }
    }

    await persistCommand(client, command, result, input.principalId);
    if (input.runtimeReservation) {
      await completeRuntimeReservation(
        client,
        input.runtimeReservation,
        result,
        committedAt,
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
