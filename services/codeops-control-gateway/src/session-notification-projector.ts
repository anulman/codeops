import { createHash } from "node:crypto";
import {
  sessionPushNotificationSchema,
  type SessionNotificationKind,
  type SessionPushNotification,
} from "@codeops/codeops-contracts/session-notification";
import {
  sessionSnapshotSchema,
  type SessionSnapshot,
} from "@codeops/codeops-contracts/session-broker";
import { projectSessionBudget } from "@codeops/codeops-contracts/session-budget";
import type { TransactionClient } from "./session-broker-repository.js";

interface Projection {
  readonly generation: number;
  readonly eventCursor: number;
  readonly state: string;
  readonly exhaustedLimit: string | null;
}

interface ProjectionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
  readonly projected_generation: unknown;
  readonly projected_event_cursor: unknown;
  readonly projected_state: unknown;
  readonly exhausted_limit: unknown;
  readonly active_children: unknown;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function currentProjection(snapshot: SessionSnapshot): Projection {
  return {
    generation: snapshot.generation,
    eventCursor: snapshot.eventCursor,
    state: snapshot.state,
    exhaustedLimit: snapshot.budget?.exhaustedLimit ?? null,
  };
}

function notification(
  snapshot: SessionSnapshot,
  kind: SessionNotificationKind,
  title: string,
  body: string,
): SessionPushNotification {
  return sessionPushNotificationSchema.parse({
    version: "codeops.session-push-notification/v1",
    key: digest({
      version: "codeops.session-push-notification-key/v1",
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
      eventCursor: snapshot.eventCursor,
      kind,
    }),
    kind,
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    eventCursor: snapshot.eventCursor,
    title,
    body,
    url: `/sessions/${encodeURIComponent(snapshot.sessionId)}`,
  });
}

export function notificationForProjection(
  previous: Projection | null,
  snapshot: SessionSnapshot,
): SessionPushNotification | null {
  if (previous === null || previous.generation !== snapshot.generation) return null;
  const exhaustedLimit = snapshot.budget?.exhaustedLimit ?? null;
  if (previous.exhaustedLimit !== exhaustedLimit && exhaustedLimit !== null) {
    return notification(
      snapshot,
      "budget-exhausted",
      "Session budget exhausted",
      "Open the session to checkpoint, fork, or review the result.",
    );
  }
  if (previous.state === snapshot.state) return null;
  if (snapshot.state === "waiting_permission") {
    return notification(
      snapshot,
      "permission-needed",
      "Session needs permission",
      "Open the session to approve or deny the requested operation.",
    );
  }
  if (snapshot.state === "failed") {
    return notification(
      snapshot,
      "session-failed",
      "Session needs attention",
      "Open the session to inspect the last durable evidence.",
    );
  }
  if (snapshot.state === "completed") {
    return notification(
      snapshot,
      "session-complete",
      "Session complete",
      "Open the session to review its result and evidence.",
    );
  }
  if (snapshot.state === "hibernated") {
    return notification(
      snapshot,
      "session-idle",
      "Session idle",
      "The session checkpoint is ready to resume or fork.",
    );
  }
  return null;
}

export async function projectNextSessionNotification(input: {
  readonly database: TransactionClient;
  readonly now?: string;
}): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  await input.database.query("BEGIN");
  try {
    const result = await input.database.query<ProjectionRow>(
      `SELECT s.snapshot_json,
              p.generation AS projected_generation,
              p.event_cursor AS projected_event_cursor,
              p.state AS projected_state,
              p.exhausted_limit,
              (SELECT count(*)::integer
                 FROM codeops.sessions child
                WHERE child.snapshot_json->'identity'->>'parentSessionId' = s.session_id
                  AND child.snapshot_json->>'state' IN
                      ('queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated'))
                AS active_children
         FROM codeops.sessions s
         LEFT JOIN codeops.session_notification_projections p
           ON p.session_id = s.session_id
        WHERE p.session_id IS NULL
           OR p.generation <> s.generation
           OR p.event_cursor < (s.snapshot_json->>'eventCursor')::bigint
           OR (p.exhausted_limit IS NULL
             AND s.snapshot_json->'budget' IS NOT NULL
             AND p.projected_at <= $1::timestamptz - interval '30 seconds')
        ORDER BY s.updated_at, s.session_id
        LIMIT 1
        FOR UPDATE OF s SKIP LOCKED`,
      [now],
    );
    const row = result.rows[0];
    if (!row) {
      await input.database.query("COMMIT");
      return false;
    }
    const storedSnapshot = sessionSnapshotSchema.parse(row.snapshot_json);
    const activeChildren = Number(row.active_children ?? 0);
    if (!Number.isSafeInteger(activeChildren) || activeChildren < 0) {
      throw new Error("stored active child session count is invalid");
    }
    const snapshot = storedSnapshot.budget?.version === "codeops.session-budget/v1"
      ? sessionSnapshotSchema.parse({
          ...storedSnapshot,
          budget: projectSessionBudget({
            startedAt: storedSnapshot.budget.startedAt,
            observedAt: now,
            limits: storedSnapshot.budget.limits,
            totalTokens: storedSnapshot.budget.usage.totalTokens,
            modelRequests: storedSnapshot.budget.usage.modelRequests,
            activeChildren,
          }),
        })
      : storedSnapshot;
    const previous = row.projected_generation === null || row.projected_generation === undefined
      ? null
      : {
          generation: Number(row.projected_generation),
          eventCursor: Number(row.projected_event_cursor),
          state: String(row.projected_state),
          exhaustedLimit: row.exhausted_limit === null ? null : String(row.exhausted_limit),
        };
    const next = currentProjection(snapshot);
    const item = notificationForProjection(previous, snapshot);
    await input.database.query(
      `INSERT INTO codeops.session_notification_projections
         (session_id, generation, event_cursor, state, exhausted_limit, projected_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (session_id) DO UPDATE
         SET generation = EXCLUDED.generation,
             event_cursor = EXCLUDED.event_cursor,
             state = EXCLUDED.state,
             exhausted_limit = EXCLUDED.exhausted_limit,
             projected_at = EXCLUDED.projected_at`,
      [
        snapshot.sessionId,
        next.generation,
        next.eventCursor,
        next.state,
        next.exhaustedLimit,
        now,
      ],
    );
    if (item !== null) {
      await input.database.query(
        `INSERT INTO codeops.session_notification_outbox
           (notification_id, session_id, generation, event_cursor,
            notification_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (notification_id) DO NOTHING`,
        [item.key, item.sessionId, item.generation, item.eventCursor, JSON.stringify(item), now],
      );
      await input.database.query(
        `INSERT INTO codeops.session_notification_deliveries
           (notification_id, subscription_id, status, attempt_count, available_at)
         SELECT $1, subscription_id, 'pending', 0, $2::timestamptz
           FROM codeops.web_push_subscriptions
          WHERE status = 'active'
         ON CONFLICT (notification_id, subscription_id) DO NOTHING`,
        [item.key, now],
      );
    }
    await input.database.query("COMMIT");
    return true;
  } catch (error) {
    await input.database.query("ROLLBACK");
    throw error;
  }
}
