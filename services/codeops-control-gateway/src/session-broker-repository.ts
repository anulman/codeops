import { randomUUID } from "node:crypto";
import {
  canonicalJsonText,
  isWorkspaceSessionIdentity,
  projectSessionBudget,
  projectSessionBudgetV2,
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
const ownerPrincipal = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function requireSessionIdentifier(sessionId: string): void {
  if (!sessionIdentifier.test(sessionId)) {
    throw new Error("session identifier is invalid");
  }
}

function requireOwnerPrincipal(ownerPrincipalId: string): void {
  if (!ownerPrincipal.test(ownerPrincipalId)) {
    throw new Error("session owner principal is invalid");
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
  ownerPrincipalId?: string,
): Promise<SessionSnapshot | null> {
  requireSessionIdentifier(sessionId);
  if (ownerPrincipalId !== undefined) requireOwnerPrincipal(ownerPrincipalId);
  const result = await client.query<StoredSessionRow>(
    `SELECT parent.snapshot_json,
            CURRENT_TIMESTAMP AS observed_at,
            budget.budget_id AS model_budget_id,
            budget.started_at AS model_budget_started_at,
            budget.provider_requests_limit,
            budget.output_tokens_limit,
            budget.committed_provider_requests,
            budget.settled_output_tokens,
            budget.reserved_output_tokens,
            budget.observed_input_tokens,
            budget.observed_total_tokens,
            budget.revision AS model_budget_revision,
            (SELECT count(*)::integer
               FROM codeops.sessions AS child
              WHERE child.snapshot_json->'identity'->>'parentSessionId' = parent.session_id
                AND child.owner_principal_id = parent.owner_principal_id
                AND child.snapshot_json->>'state' IN
                    ('queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated'))
              AS active_children
       FROM codeops.sessions AS parent
       LEFT JOIN codeops.session_model_budgets AS budget
         ON budget.session_id = parent.session_id
      WHERE parent.session_id = $1
        AND ($2::text IS NULL OR parent.owner_principal_id = $2)`,
    [sessionId, ownerPrincipalId ?? null],
  );
  if (!result.rows[0]) return null;
  const snapshot = projectStoredSessionBudget(result.rows[0]);
  if (snapshot.sessionId !== sessionId) {
    throw new Error("stored snapshot does not match the requested session");
  }
  return snapshot;
}

export async function listSessionSnapshots(
  client: TransactionClient,
  limit = 100,
  ownerPrincipalId?: string,
): Promise<readonly SessionSnapshot[]> {
  requireReadLimit(limit, 200);
  if (ownerPrincipalId !== undefined) requireOwnerPrincipal(ownerPrincipalId);
  const result = await client.query<StoredSessionRow>(
    `SELECT parent.snapshot_json,
            CURRENT_TIMESTAMP AS observed_at,
            budget.budget_id AS model_budget_id,
            budget.started_at AS model_budget_started_at,
            budget.provider_requests_limit,
            budget.output_tokens_limit,
            budget.committed_provider_requests,
            budget.settled_output_tokens,
            budget.reserved_output_tokens,
            budget.observed_input_tokens,
            budget.observed_total_tokens,
            budget.revision AS model_budget_revision,
            (SELECT count(*)::integer
               FROM codeops.sessions AS child
              WHERE child.snapshot_json->'identity'->>'parentSessionId' = parent.session_id
                AND child.owner_principal_id = parent.owner_principal_id
                AND child.snapshot_json->>'state' IN
                    ('queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated'))
              AS active_children
       FROM codeops.sessions AS parent
       LEFT JOIN codeops.session_model_budgets AS budget
         ON budget.session_id = parent.session_id
      WHERE ($2::text IS NULL OR parent.owner_principal_id = $2)
      ORDER BY parent.updated_at DESC, parent.session_id ASC
      LIMIT $1`,
    [limit, ownerPrincipalId ?? null],
  );
  return result.rows.map(projectStoredSessionBudget);
}

function projectStoredSessionBudget(row: StoredSessionRow): SessionSnapshot {
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  if (snapshot.budget === undefined || row.observed_at === undefined) {
    return snapshot;
  }
  const observedAt = row.observed_at instanceof Date
    ? row.observed_at.toISOString()
    : String(row.observed_at);
  const activeChildren = Number(row.active_children ?? 0);
  if (!Number.isSafeInteger(activeChildren) || activeChildren < 0) {
    throw new Error("stored active child session count is invalid");
  }
  if (row.model_budget_id !== undefined && row.model_budget_id !== null) {
    const count = (value: unknown, name: string): number => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`stored model budget ${name} is invalid`);
      }
      return parsed;
    };
    const startedAt = row.model_budget_started_at instanceof Date
      ? row.model_budget_started_at.toISOString()
      : String(row.model_budget_started_at);
    const elapsedSeconds = snapshot.budget?.limits.elapsedSeconds;
    const activeChildrenLimit = snapshot.budget?.limits.activeChildren;
    if (elapsedSeconds === undefined || activeChildrenLimit === undefined) {
      throw new Error("stored model budget is missing session limits");
    }
    return sessionSnapshotSchema.parse({
      ...snapshot,
      budget: projectSessionBudgetV2({
        budgetId: String(row.model_budget_id),
        revision: count(row.model_budget_revision, "revision"),
        startedAt,
        observedAt,
        limits: {
          elapsedSeconds,
          providerRequests: count(
            row.provider_requests_limit,
            "provider request limit",
          ),
          outputTokens: count(row.output_tokens_limit, "output token limit"),
          activeChildren: activeChildrenLimit,
        },
        providerRequests: count(
          row.committed_provider_requests,
          "provider requests",
        ),
        outputTokens: count(row.settled_output_tokens, "output tokens"),
        reservedOutputTokens: count(
          row.reserved_output_tokens,
          "reserved output tokens",
        ),
        observedInputTokens: count(
          row.observed_input_tokens,
          "observed input tokens",
        ),
        observedTotalTokens: count(
          row.observed_total_tokens,
          "observed total tokens",
        ),
        activeChildren,
      }),
    });
  }
  if (snapshot.budget.version !== "codeops.session-budget/v1") {
    throw new Error("durable model budget row is missing");
  }
  return sessionSnapshotSchema.parse({
    ...snapshot,
    budget: projectSessionBudget({
      startedAt: snapshot.budget.startedAt,
      observedAt,
      limits: snapshot.budget.limits,
      totalTokens: snapshot.budget.usage.totalTokens,
      modelRequests: snapshot.budget.usage.modelRequests,
      activeChildren,
    }),
  });
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
    readonly ownerPrincipalId?: string;
  },
): Promise<readonly SessionEvent[]> {
  requireSessionIdentifier(input.sessionId);
  const afterCursor = input.afterCursor ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new Error("event cursor must be a non-negative safe integer");
  }
  requireReadLimit(limit, 500);
  if (input.ownerPrincipalId !== undefined) {
    requireOwnerPrincipal(input.ownerPrincipalId);
  }
  const result = await client.query<StoredEventRow>(
    `SELECT event.event_json
       FROM codeops.session_events AS event
       JOIN codeops.sessions AS session
         ON session.session_id = event.session_id
      WHERE event.session_id = $1 AND event.cursor > $2
        AND ($4::text IS NULL OR session.owner_principal_id = $4)
      ORDER BY event.cursor ASC
      LIMIT $3`,
    [input.sessionId, afterCursor, limit, input.ownerPrincipalId ?? null],
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
  readonly ownerPrincipalId?: string;
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
  readonly owner_principal_id?: unknown;
  readonly observed_at?: unknown;
  readonly active_children?: unknown;
  readonly model_budget_id?: unknown;
  readonly model_budget_started_at?: unknown;
  readonly provider_requests_limit?: unknown;
  readonly output_tokens_limit?: unknown;
  readonly committed_provider_requests?: unknown;
  readonly settled_output_tokens?: unknown;
  readonly reserved_output_tokens?: unknown;
  readonly observed_input_tokens?: unknown;
  readonly observed_total_tokens?: unknown;
  readonly model_budget_revision?: unknown;
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
      canonicalJsonText(childIdentity.workspace) === canonicalJsonText(parentIdentity.workspace)
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
  code:
    | "generation_conflict"
    | "lease_conflict"
    | "capability_unavailable"
    | "budget_exhausted",
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

async function commandBudgetRejection(
  client: TransactionClient,
  snapshot: SessionSnapshot,
  command: SessionCommand,
  observedAt: string,
): Promise<{ readonly snapshot: SessionSnapshot; readonly reason: string } | null> {
  if (snapshot.budget === undefined) return null;
  let activeChildren = snapshot.budget.usage.activeChildren;
  if (command.type === "fork") {
    const result = await client.query<{ readonly active_children: unknown }>(
      `SELECT count(*)::integer AS active_children
         FROM codeops.sessions
        WHERE snapshot_json->'identity'->>'parentSessionId' = $1
          AND snapshot_json->>'state' IN
              ('queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated')`,
      [snapshot.sessionId],
    );
    const count = Number(result.rows[0]?.active_children ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("active child session count is invalid");
    }
    activeChildren = count;
  }
  const budget = snapshot.budget.version === "codeops.session-budget/v2"
    ? projectSessionBudgetV2({
        budgetId: snapshot.budget.budgetId,
        revision: snapshot.budget.revision,
        startedAt: snapshot.budget.startedAt,
        observedAt,
        limits: snapshot.budget.limits,
        providerRequests: snapshot.budget.usage.providerRequests,
        outputTokens: snapshot.budget.usage.outputTokens,
        reservedOutputTokens: snapshot.budget.reserved.outputTokens,
        observedInputTokens: snapshot.budget.usage.observedInputTokens,
        observedTotalTokens: snapshot.budget.usage.observedTotalTokens,
        activeChildren,
      })
    : projectSessionBudget({
        startedAt: snapshot.budget.startedAt,
        observedAt,
        limits: snapshot.budget.limits,
        totalTokens: snapshot.budget.usage.totalTokens,
        modelRequests: snapshot.budget.usage.modelRequests,
        activeChildren,
      });
  const hardReason = (() => {
    if (
      ["prompt", "resume", "fork"].includes(command.type) &&
      budget.usage.elapsedSeconds >= budget.limits.elapsedSeconds
    ) {
      return "The elapsed-time budget is exhausted.";
    }
    if (
      command.type === "prompt" &&
      (budget.version === "codeops.session-budget/v2"
        ? budget.usage.outputTokens + budget.reserved.outputTokens >=
          budget.limits.outputTokens
        : budget.usage.totalTokens >= budget.limits.totalTokens)
    ) {
      return budget.version === "codeops.session-budget/v2"
        ? "The output-token budget is exhausted."
        : "The token budget is exhausted.";
    }
    if (
      command.type === "prompt" &&
      (budget.version === "codeops.session-budget/v2"
        ? budget.usage.providerRequests >= budget.limits.providerRequests
        : budget.usage.modelRequests >= budget.limits.modelRequests)
    ) {
      return "The model-request budget is exhausted.";
    }
    if (
      command.type === "fork" &&
      budget.usage.activeChildren >= budget.limits.activeChildren
    ) {
      return "The active-child budget is exhausted.";
    }
    return null;
  })();
  if (hardReason === null) return null;
  return {
    snapshot: sessionSnapshotSchema.parse({ ...snapshot, budget }),
    reason: hardReason,
  };
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
      canonicalJsonText(command),
      canonicalJsonText(result),
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
        canonicalJsonText(event),
        commandId,
        event.occurredAt,
      ],
    );
  }
}

async function persistForkedSession(
  client: TransactionClient,
  snapshot: SessionSnapshot,
  ownerPrincipalId: string,
): Promise<void> {
  requireOwnerPrincipal(ownerPrincipalId);
  const inserted = await client.query(
    `INSERT INTO codeops.sessions
       (session_id, generation, lease_id, snapshot_json, updated_at,
        owner_principal_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      snapshot.sessionId,
      snapshot.generation,
      snapshot.lease?.leaseId ?? null,
      canonicalJsonText(snapshot),
      snapshot.updatedAt,
      ownerPrincipalId,
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new SessionForkConflictError(
      `fork child session ${snapshot.sessionId} already exists`,
    );
  }
  if (snapshot.budget !== undefined) {
    const providerRequestsLimit = snapshot.budget.version === "codeops.session-budget/v2"
      ? snapshot.budget.limits.providerRequests
      : snapshot.budget.limits.modelRequests;
    const outputTokensLimit = snapshot.budget.version === "codeops.session-budget/v2"
      ? snapshot.budget.limits.outputTokens
      : snapshot.budget.limits.totalTokens;
    const budgetId = snapshot.budget.version === "codeops.session-budget/v2"
      ? snapshot.budget.budgetId
      : snapshot.sessionId;
    await client.query(
      `INSERT INTO codeops.session_model_budgets (
         session_id, budget_id, started_at, provider_requests_limit,
         output_tokens_limit, committed_provider_requests,
         settled_output_tokens, reserved_output_tokens,
         observed_input_tokens, observed_total_tokens, revision, updated_at
       ) VALUES (
         $1, $2, $3::timestamptz, $4, $5, 0, 0, 0, 0, 0, 1,
         $3::timestamptz
       )`,
      [
        snapshot.sessionId,
        budgetId,
        snapshot.budget.startedAt,
        providerRequestsLimit,
        outputTokensLimit,
      ],
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
      canonicalJsonText(reservation.completionJson),
      canonicalJsonText(result),
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
  if (input.ownerPrincipalId !== undefined) {
    requireOwnerPrincipal(input.ownerPrincipalId);
  }
  const committedAt = (input.now ?? (() => new Date()))().toISOString();
  const commandId = (input.commandId ?? randomUUID)();

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Lock the session before looking up idempotency. This gives every command
    // for one session a single serialization point, including two first-time
    // requests racing with the same key.
    const locked = await client.query<StoredSessionRow>(
      `SELECT parent.snapshot_json, parent.owner_principal_id,
              CURRENT_TIMESTAMP AS observed_at,
              budget.budget_id AS model_budget_id,
              budget.started_at AS model_budget_started_at,
              budget.provider_requests_limit,
              budget.output_tokens_limit,
              budget.committed_provider_requests,
              budget.settled_output_tokens,
              budget.reserved_output_tokens,
              budget.observed_input_tokens,
              budget.observed_total_tokens,
              budget.revision AS model_budget_revision,
              (SELECT count(*)::integer
                 FROM codeops.sessions AS child
                WHERE child.snapshot_json->'identity'->>'parentSessionId' = parent.session_id
                  AND child.owner_principal_id = parent.owner_principal_id
                  AND child.snapshot_json->>'state' IN
                      ('queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated'))
                AS active_children
         FROM codeops.sessions AS parent
         LEFT JOIN codeops.session_model_budgets AS budget
           ON budget.session_id = parent.session_id
        WHERE parent.session_id = $1
          AND ($2::text IS NULL OR parent.owner_principal_id = $2)
        FOR UPDATE OF parent`,
      [command.sessionId, input.ownerPrincipalId ?? null],
    );
    if (!locked.rows[0]) {
      throw new SessionNotFoundError(`session ${command.sessionId} not found`);
    }
    const snapshot = projectStoredSessionBudget(locked.rows[0]);

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
        canonicalJsonText(runtimeRow.dispatch_json) !==
          canonicalJsonText(reservation.dispatchJson) ||
        canonicalJsonText(snapshot) !== canonicalJsonText(reservation.expectedSnapshot) ||
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
      if (canonicalJsonText(storedCommand) !== canonicalJsonText(command)) {
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
      const budgetRejection = await commandBudgetRejection(
        client,
        snapshot,
        command,
        committedAt,
      );
      const capability = snapshot.capabilities.find(
        ({ action }) => action === command.type,
      );
      if (budgetRejection !== null) {
        result = rejectedResult(
          budgetRejection.snapshot,
          command,
          "budget_exhausted",
          budgetRejection.reason,
          committedAt,
          commandId,
        );
      } else if (!capability || capability.availability !== "enabled") {
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
          await persistForkedSession(
            client,
            result.snapshot,
            String(locked.rows[0].owner_principal_id),
          );
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
              canonicalJsonText(result.snapshot),
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
