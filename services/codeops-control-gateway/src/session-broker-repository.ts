import { randomUUID } from "node:crypto";
import {
  SESSION_BROKER_VERSION,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionSnapshotSchema,
  type SessionCommand,
  type SessionCommandResult,
  type SessionSnapshot,
} from "@renoconcierge/codeops-contracts";

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

interface ExecuteSessionCommandInput {
  readonly command: unknown;
  readonly principalId: string;
  readonly now?: () => Date;
  readonly commandId?: () => string;
  readonly mutate: (
    snapshot: SessionSnapshot,
    command: SessionCommand,
  ) => Promise<SessionCommandResult> | SessionCommandResult;
}

interface StoredCommandRow extends Record<string, unknown> {
  readonly command_json: unknown;
  readonly result_json: unknown;
}

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
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
  now: () => Date,
  commandId: () => string,
): SessionCommandResult {
  return sessionCommandResultSchema.parse({
    version: SESSION_BROKER_VERSION.commandResult,
    commandId: commandId(),
    sessionId: command.sessionId,
    generation: command.generation,
    leaseId: command.leaseId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    eventCursor: snapshot.eventCursor,
    snapshot,
    committedAt: now().toISOString(),
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

export async function executeSessionCommandTransaction(
  client: TransactionClient,
  input: ExecuteSessionCommandInput,
): Promise<SessionCommandResult> {
  const command = sessionCommandSchema.parse(input.command);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(input.principalId)) {
    throw new Error("session command principal must be a bounded audit identity");
  }
  const now = input.now ?? (() => new Date());
  const commandId = input.commandId ?? randomUUID;

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
        now,
        commandId,
      );
    } else if (snapshot.lease?.leaseId !== command.leaseId) {
      result = rejectedResult(
        snapshot,
        command,
        "lease_conflict",
        "The command does not hold the current session lease.",
        now,
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
          now,
          commandId,
        );
      } else {
        result = sessionCommandResultSchema.parse(
          await input.mutate(snapshot, command),
        );
        requireResultIdentity(result, command);
        if (result.disposition !== "committed") {
          throw new Error("session mutator must return a committed result");
        }
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

    await persistCommand(client, command, result, input.principalId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
