import { createHash, randomUUID } from "node:crypto";

import {
  canonicalSerialize,
  workItemLifecycleEventSchema,
  type WorkItemLifecycleEvent,
} from "@renoconcierge/codeops-contracts";

import type { TransactionClient } from "./session-broker-repository.js";

interface StoredEventRow extends Record<string, unknown> {
  readonly event_digest: unknown;
  readonly event_json: unknown;
}

interface StoredLifecycleRow extends Record<string, unknown> {
  readonly workflow_id: unknown;
  readonly run_id: unknown;
  readonly phase: unknown;
  readonly attention: unknown;
  readonly sequence: unknown;
}

interface ClaimedPublicationRow extends Record<string, unknown> {
  readonly event_json: unknown;
  readonly claim_token: unknown;
  readonly claim_expires_at: unknown;
  readonly claim_count: unknown;
}

interface PublishedRow extends Record<string, unknown> {
  readonly status: unknown;
  readonly jetstream_stream: unknown;
  readonly jetstream_sequence: unknown;
}

export class ImmutableLifecycleEventConflictError extends Error {}
export class LifecycleCompareAndSwapError extends Error {}
export class LifecyclePublicationClaimConflictError extends Error {}

export interface LifecyclePublicationClaim {
  readonly event: WorkItemLifecycleEvent;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly claimCount: number;
}

const relayIdentity = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const jetStreamName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function eventDigest(event: WorkItemLifecycleEvent): string {
  return createHash("sha256").update(canonicalSerialize(event)).digest("hex");
}

function repositoryIdentity(event: WorkItemLifecycleEvent): string {
  return `${event.repository.owner}/${event.repository.name}`;
}

function aggregateValues(event: WorkItemLifecycleEvent): readonly unknown[] {
  return [
    repositoryIdentity(event),
    event.provider.kind,
    event.provider.workspaceId,
    event.provider.projectId,
    event.workItemId,
  ];
}

function storedSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("stored lifecycle sequence is invalid");
  }
  return sequence;
}

export async function appendWorkItemLifecycleEvent(
  client: TransactionClient,
  input: WorkItemLifecycleEvent,
): Promise<"appended" | "replayed"> {
  const event = workItemLifecycleEventSchema.parse(input);
  const digest = eventDigest(event);
  const aggregate = aggregateValues(event);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const existing = await client.query<StoredEventRow>(
      `SELECT event_digest, event_json
         FROM codeops.work_item_lifecycle_events
        WHERE event_id = $1
        FOR UPDATE`,
      [event.eventId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].event_digest !== digest ||
        canonicalSerialize(existing.rows[0].event_json) !==
          canonicalSerialize(event)
      ) {
        throw new ImmutableLifecycleEventConflictError(
          "lifecycle event ID conflicts with different immutable bytes",
        );
      }
      await client.query("COMMIT");
      return "replayed";
    }

    const current = await client.query<StoredLifecycleRow>(
      `SELECT workflow_id, run_id, phase, attention, sequence
         FROM codeops.work_item_lifecycle
        WHERE repository = $1 AND provider = $2 AND workspace_id = $3
          AND project_id = $4 AND work_item_id = $5
        FOR UPDATE`,
      aggregate,
    );
    const row = current.rows[0];
    if (event.previousState === null) {
      if (row !== undefined || event.sequence !== 1) {
        throw new LifecycleCompareAndSwapError(
          "first lifecycle event conflicts with the current aggregate",
        );
      }
      await client.query(
        `INSERT INTO codeops.work_item_lifecycle
          (repository, provider, workspace_id, project_id, work_item_id,
           workflow_id, run_id, phase, attention, sequence, source_sha, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
        [
          ...aggregate,
          event.workflowId,
          event.runId,
          event.state.phase,
          event.state.attention,
          event.sequence,
          event.sourceSha,
          event.occurredAt,
        ],
      );
    } else {
      if (
        row === undefined ||
        row.workflow_id !== event.workflowId ||
        row.run_id !== event.runId ||
        row.phase !== event.previousState.phase ||
        row.attention !== event.previousState.attention ||
        storedSequence(row.sequence) !== event.sequence - 1
      ) {
        throw new LifecycleCompareAndSwapError(
          "lifecycle event does not match the current aggregate revision",
        );
      }
      const updated = await client.query(
        `UPDATE codeops.work_item_lifecycle
            SET phase = $6, attention = $7, sequence = $8,
                source_sha = $9, updated_at = $10::timestamptz
          WHERE repository = $1 AND provider = $2 AND workspace_id = $3
            AND project_id = $4 AND work_item_id = $5 AND sequence = $11`,
        [
          ...aggregate,
          event.state.phase,
          event.state.attention,
          event.sequence,
          event.sourceSha,
          event.occurredAt,
          event.sequence - 1,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new LifecycleCompareAndSwapError(
          "lifecycle aggregate changed before the event commit",
        );
      }
    }

    await client.query(
      `INSERT INTO codeops.work_item_lifecycle_events
        (event_id, transition_id, transition_key, repository, provider,
         workspace_id, project_id, work_item_id, workflow_id, run_id,
         source_sha, sequence, event_digest, event_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14::jsonb, $15::timestamptz)`,
      [
        event.eventId,
        event.transitionId,
        event.transitionKey,
        ...aggregate,
        event.workflowId,
        event.runId,
        event.sourceSha,
        event.sequence,
        digest,
        JSON.stringify(event),
        event.occurredAt,
      ],
    );
    await client.query(
      `INSERT INTO codeops.work_item_lifecycle_publications
        (event_id, status, available_at)
       VALUES ($1, 'pending', $2::timestamptz)`,
      [event.eventId, event.occurredAt],
    );
    await client.query("COMMIT");
    return "appended";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function claimWorkItemLifecyclePublication(
  client: TransactionClient,
  input: {
    readonly claimedBy: string;
    readonly now: string;
    readonly leaseMs: number;
  },
): Promise<LifecyclePublicationClaim | null> {
  if (!relayIdentity.test(input.claimedBy)) {
    throw new Error("lifecycle relay identity is invalid");
  }
  const now = new Date(input.now);
  if (
    Number.isNaN(now.valueOf()) ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 15 * 60 * 1_000
  ) {
    throw new Error("lifecycle relay lease is invalid");
  }
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(now.valueOf() + input.leaseMs).toISOString();
  const result = await client.query<ClaimedPublicationRow>(
    `WITH candidate AS (
       SELECT publication.event_id
         FROM codeops.work_item_lifecycle_publications AS publication
        WHERE publication.available_at <= $1::timestamptz
          AND (
            publication.status = 'pending'
            OR (publication.status = 'claimed'
                AND publication.claim_expires_at <= $1::timestamptz)
          )
        ORDER BY publication.available_at ASC, publication.event_id ASC
        FOR UPDATE OF publication SKIP LOCKED
        LIMIT 1
     ), claimed AS (
       UPDATE codeops.work_item_lifecycle_publications AS publication
          SET status = 'claimed', claim_token = $2::uuid, claimed_by = $3,
              claimed_at = $1::timestamptz,
              claim_expires_at = $4::timestamptz,
              claim_count = publication.claim_count + 1
         FROM candidate
        WHERE publication.event_id = candidate.event_id
       RETURNING publication.event_id, publication.claim_token,
                 publication.claim_expires_at, publication.claim_count
     )
     SELECT event.event_json, claimed.claim_token,
            claimed.claim_expires_at, claimed.claim_count
       FROM claimed
       JOIN codeops.work_item_lifecycle_events AS event
         ON event.event_id = claimed.event_id`,
    [input.now, claimToken, input.claimedBy, claimExpiresAt],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    event: workItemLifecycleEventSchema.parse(row.event_json),
    claimToken: String(row.claim_token),
    claimExpiresAt: new Date(String(row.claim_expires_at)).toISOString(),
    claimCount: storedSequence(row.claim_count),
  };
}

export async function acknowledgeWorkItemLifecyclePublication(
  client: TransactionClient,
  input: {
    readonly eventId: string;
    readonly claimToken: string;
    readonly stream: string;
    readonly streamSequence: number;
    readonly publishedAt: string;
  },
): Promise<"published" | "duplicate"> {
  if (!uuid.test(input.claimToken)) {
    throw new Error("lifecycle publication claim token is invalid");
  }
  if (
    !jetStreamName.test(input.stream) ||
    !Number.isSafeInteger(input.streamSequence) ||
    input.streamSequence < 1 ||
    Number.isNaN(new Date(input.publishedAt).valueOf())
  ) {
    throw new Error("JetStream publication acknowledgment is invalid");
  }
  const updated = await client.query(
    `UPDATE codeops.work_item_lifecycle_publications
        SET status = 'published', claim_token = NULL, claimed_by = NULL,
            claimed_at = NULL, claim_expires_at = NULL,
            jetstream_stream = $3, jetstream_sequence = $4,
            published_at = $5::timestamptz
      WHERE event_id = $1 AND status = 'claimed' AND claim_token = $2::uuid`,
    [
      input.eventId,
      input.claimToken,
      input.stream,
      input.streamSequence,
      input.publishedAt,
    ],
  );
  if (updated.rowCount === 1) return "published";
  const existing = await client.query<PublishedRow>(
    `SELECT status, jetstream_stream, jetstream_sequence
       FROM codeops.work_item_lifecycle_publications
      WHERE event_id = $1`,
    [input.eventId],
  );
  const row = existing.rows[0];
  if (
    row?.status === "published" &&
    row.jetstream_stream === input.stream &&
    Number(row.jetstream_sequence) === input.streamSequence
  ) {
    return "duplicate";
  }
  throw new LifecyclePublicationClaimConflictError(
    "lifecycle publication acknowledgment lost its claim",
  );
}
