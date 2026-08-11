import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  SESSION_BROKER_VERSION,
  sessionEventSchema,
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  sessionSnapshotSchema,
  type SessionJobInitializationResponse,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";

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

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function sameRootIdentity(
  existing: SessionSnapshot,
  proposed: SessionSnapshot,
): boolean {
  return (
    existing.sessionId === proposed.sessionId &&
    canonical(existing.identity) === canonical(proposed.identity)
  );
}

export async function initializeSessionFromJob(
  client: TransactionClient,
  input: {
    readonly request: unknown;
    readonly now?: () => Date;
    readonly leaseMs?: number;
  },
): Promise<SessionJobInitializationResponse> {
  const request = sessionJobInitializationRequestSchema.parse(input.request);
  const now = (input.now ?? (() => new Date()))();
  const leaseMs = input.leaseMs ?? 60 * 60_000;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 60_000 ||
    leaseMs > 24 * 60 * 60_000
  ) {
    throw new Error("session Job lease must be between one minute and 24 hours");
  }
  const initializedAt = now.toISOString();
  const proposed = sessionSnapshotSchema.parse({
    version: SESSION_BROKER_VERSION.snapshot,
    sessionId: request.sessionId,
    generation: 1,
    state: "running",
    identity: request.identity,
    lease: {
      leaseId: request.leaseId,
      generation: 1,
      status: "active",
      holderId: request.holderId,
      acquiredAt: initializedAt,
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 1,
    capabilities: sessionCapabilitiesFor("running", false),
    updatedAt: initializedAt,
  });
  const eventBody = {
    sessionId: proposed.sessionId,
    generation: 1,
    cursor: 1,
    type: "session_created",
    occurredAt: initializedAt,
  } as const;
  const event = sessionEventSchema.parse({
    version: SESSION_BROKER_VERSION.event,
    eventId: eventId(eventBody),
    ...eventBody,
  });

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const inserted = await client.query(
      `INSERT INTO codeops.sessions
         (session_id, generation, lease_id, snapshot_json, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        proposed.sessionId,
        proposed.generation,
        proposed.lease!.leaseId,
        canonical(proposed),
        proposed.updatedAt,
      ],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        `INSERT INTO codeops.session_events
           (event_id, session_id, generation, cursor, event_type, event_json,
            command_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7::timestamptz)`,
        [
          event.eventId,
          event.sessionId,
          event.generation,
          event.cursor,
          event.type,
          canonical(event),
          event.occurredAt,
        ],
      );
      await client.query("COMMIT");
      return sessionJobInitializationResponseSchema.parse({
        version: "codeops.session-job-initialization-result/v1",
        disposition: "created",
        snapshot: proposed,
      });
    }

    const stored = await client.query<StoredSessionRow>(
      `SELECT snapshot_json
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [request.sessionId],
    );
    const existing = sessionSnapshotSchema.parse(stored.rows[0]?.snapshot_json);
    if (!sameRootIdentity(existing, proposed)) {
      throw new Error(
        `session ${request.sessionId} already belongs to a different Job identity`,
      );
    }
    await client.query("COMMIT");
    return sessionJobInitializationResponseSchema.parse({
      version: "codeops.session-job-initialization-result/v1",
      disposition: "duplicate",
      snapshot: existing,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export class InvalidSessionJobInitializationRequestError extends Error {}

export async function serveSessionJobInitialization(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly initialize: (request: unknown) => Promise<SessionJobInitializationResponse>;
}): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null> {
  if (
    input.method !== "POST" ||
    input.url !== "/v1/session-jobs/initializations"
  ) {
    return null;
  }
  const authorization =
    typeof input.headers.authorization === "string"
      ? input.headers.authorization
      : undefined;
  if (!authenticateBearer(authorization, input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      typeof input.headers["content-type"] === "string"
        ? input.headers["content-type"]
        : "",
    )
  ) {
    throw new InvalidSessionJobInitializationRequestError(
      "session Job initialization content type must be application/json",
    );
  }
  let request: unknown;
  try {
    request = sessionJobInitializationRequestSchema.parse(await input.readBody());
  } catch {
    throw new InvalidSessionJobInitializationRequestError(
      "session Job initialization body is invalid",
    );
  }
  return { status: 200, body: await input.initialize(request) };
}
