import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  SESSION_BROKER_VERSION,
  sessionEventSchema,
  sessionSnapshotSchema,
  temporalCodeOpsSessionIdentitySchema,
  type AgentJobDispatchRequest,
} from "@codeops/codeops-contracts";
import { buildAgentPrompt } from "./core.js";
import { initializeSessionFromJob } from "./session-job-initialization.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function agentJobSessionId(runId: string): string {
  return `ses_${hash(`agent-job:${runId}`).slice(0, 24)}`;
}

export function describeAgentJobSession(request: AgentJobDispatchRequest, runId: string) {
  if (
    (request.role !== "coding-agent" && request.role !== "critic-agent") ||
    request.codingRequest.adoptedPullRequest === undefined
  ) {
    return null;
  }
  const adopted = request.codingRequest.adoptedPullRequest;
  const round = request.codingRound ?? 1;
  const agentRole =
    request.role === "critic-agent"
      ? "critic"
      : round === 1
        ? "coding"
        : "revision";
  const displayRole =
    agentRole === "critic"
      ? "Reviewer Session"
      : agentRole === "revision"
        ? "Work Item Revision Session"
        : "Work Item Session";
  return {
    sessionId: agentJobSessionId(runId),
    ownerPrincipalId: adopted.sessionOwnerPrincipalId,
    identity: temporalCodeOpsSessionIdentitySchema.parse({
      repository: adopted.repository,
      branch: adopted.headRef,
      baseSha: request.baseSha,
      workflowId: request.workflowId,
      runId,
      displayName: `PR #${adopted.pullRequestNumber} · ${displayRole} · round ${round}`,
      workItemId: request.workItemId,
      pullRequestNumber: adopted.pullRequestNumber,
      pullRequestHeadSha: adopted.headSha,
      agentRole,
      round,
      parentSessionId: null,
      forkedAtCursor: null,
    }),
  };
}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${hash(JSON.stringify(body))}`;
}

export async function projectAgentJobSessionStarted(input: {
  client: TransactionClient;
  request: AgentJobDispatchRequest;
  runId: string;
  now?: () => Date;
}): Promise<string | null> {
  const projected = describeAgentJobSession(input.request, input.runId);
  if (projected === null) return null;
  const now = (input.now ?? (() => new Date()))();
  const initialized = await initializeSessionFromJob(input.client, {
    request: {
      version: "codeops.session-job-initialization/v1",
      sessionId: projected.sessionId,
      identity: projected.identity,
      leaseId: deterministicUuid(`lease:${input.runId}`),
      holderId: `agent-job:${input.runId}`,
      ownerPrincipalId: projected.ownerPrincipalId,
    },
    now: () => now,
  });
  if (initialized.snapshot.eventCursor >= 2) return projected.sessionId;
  const occurredAt = now.toISOString();
  const body = {
    sessionId: projected.sessionId,
    generation: 1,
    cursor: 2,
    type: "acp_update",
    message: {
      role: "user",
      text: buildAgentPrompt(input.request),
      messageId: `agent-job-prompt:${input.runId}`,
    },
    occurredAt,
  } as const;
  const event = sessionEventSchema.parse({
    version: SESSION_BROKER_VERSION.event,
    eventId: eventId(body),
    ...body,
  });
  await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await input.client.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json FROM codeops.sessions WHERE session_id = $1 FOR UPDATE`,
      [projected.sessionId],
    );
    const snapshot = sessionSnapshotSchema.parse(locked.rows[0]?.snapshot_json);
    if (snapshot.eventCursor === 1) {
      const updated = sessionSnapshotSchema.parse({
        ...snapshot,
        eventCursor: 2,
        updatedAt: occurredAt,
      });
      await input.client.query(
        `INSERT INTO codeops.session_events
           (event_id, session_id, generation, cursor, event_type, event_json,
            command_id, occurred_at)
         VALUES ($1, $2, 1, 2, $3, $4::jsonb, NULL, $5::timestamptz)`,
        [event.eventId, event.sessionId, event.type, canonicalJsonText(event), occurredAt],
      );
      await input.client.query(
        `UPDATE codeops.sessions
            SET snapshot_json = $2::jsonb, updated_at = $3::timestamptz
          WHERE session_id = $1`,
        [projected.sessionId, canonicalJsonText(updated), occurredAt],
      );
    }
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
  return projected.sessionId;
}

export async function projectAgentJobSessionTerminal(input: {
  client: TransactionClient;
  request: AgentJobDispatchRequest;
  runId: string;
  response: string;
  state: "completed" | "failed";
  now?: () => Date;
}): Promise<void> {
  const projected = describeAgentJobSession(input.request, input.runId);
  if (projected === null) return;
  const occurredAt = (input.now ?? (() => new Date()))().toISOString();
  await input.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const locked = await input.client.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json FROM codeops.sessions WHERE session_id = $1 FOR UPDATE`,
      [projected.sessionId],
    );
    const snapshot = sessionSnapshotSchema.parse(locked.rows[0]?.snapshot_json);
    if (snapshot.state === "completed" || snapshot.state === "failed") {
      await input.client.query("COMMIT");
      return;
    }
    const responseCursor = snapshot.eventCursor + 1;
    const stateCursor = responseCursor + 1;
    const responseBody = {
      sessionId: projected.sessionId,
      generation: snapshot.generation,
      cursor: responseCursor,
      type: "acp_update",
      message: {
        role: "assistant",
        text: input.response.slice(0, 200_000),
        messageId: `agent-job-response:${input.runId}`,
        stopReason: input.state === "completed" ? "end_turn" : "cancelled",
      },
      occurredAt,
    } as const;
    const stateBody = {
      sessionId: projected.sessionId,
      generation: snapshot.generation,
      cursor: stateCursor,
      type: "state_changed",
      occurredAt,
    } as const;
    const events = [responseBody, stateBody].map((body) =>
      sessionEventSchema.parse({
        version: SESSION_BROKER_VERSION.event,
        eventId: eventId(body),
        ...body,
      }),
    );
    const updated = sessionSnapshotSchema.parse({
      ...snapshot,
      state: input.state,
      lease: {
        leaseId: snapshot.lease!.leaseId,
        generation: snapshot.generation,
        status: "released",
        releasedAt: occurredAt,
      },
      eventCursor: stateCursor,
      capabilities: sessionCapabilitiesFor(input.state, false),
      updatedAt: occurredAt,
    });
    for (const event of events) {
      await input.client.query(
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
          canonicalJsonText(event),
          occurredAt,
        ],
      );
    }
    await input.client.query(
      `UPDATE codeops.sessions
          SET snapshot_json = $2::jsonb, lease_id = $3, updated_at = $4::timestamptz
        WHERE session_id = $1`,
      [projected.sessionId, canonicalJsonText(updated), updated.lease!.leaseId, occurredAt],
    );
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
}
