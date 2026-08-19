import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  SESSION_BROKER_VERSION,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  temporalCodeOpsSessionIdentitySchema,
  type AgentJobDispatchRequest,
} from "@codeops/codeops-contracts";
import { buildAgentPrompt } from "./core.js";
import { agentJobSessionId } from "./agent-job-identity.js";
import { initializeSessionFromJob } from "./session-job-initialization.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";
import { reconcileSessionSupervision } from "./session-supervision.js";

export { agentJobSessionId } from "./agent-job-identity.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function projectSupervisorState(input: {
  client: TransactionClient;
  request: AgentJobDispatchRequest;
  runId: string;
  phase: "started" | "failed" | "completed" | "reconciled";
  now?: () => Date;
}): Promise<void> {
  if (input.request.role !== "coding-agent" && input.request.role !== "critic-agent") return;
  const adopted = input.request.codingRequest.adoptedPullRequest;
  const supervisorSessionId = adopted?.supervisorSessionId;
  if (adopted === undefined || supervisorSessionId === undefined) return;
  const childSessionId = agentJobSessionId(input.runId);
  await reconcileSessionSupervision(
    input.client,
    {
      version: "codeops.session-supervision-reconciliation/v1",
      idempotencyKey: deterministicUuid(
        `supervision:${supervisorSessionId}:${childSessionId}:${input.phase}`,
      ),
      supervisorSessionId,
      childSessionIds: [childSessionId],
      repository: adopted.repository,
      workItemId: input.request.workItemId,
      workflowId: input.request.workflowId,
      pullRequestNumber: adopted.pullRequestNumber,
      pullRequestHeadSha: adopted.headSha,
    },
    { now: input.now },
  );
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
  const prompt = buildAgentPrompt(input.request);
  const commandId = deterministicUuid(`command:${input.runId}`);
  const idempotencyKey = deterministicUuid(`idempotency:${input.runId}`);
  const command = sessionCommandSchema.parse({
    version: SESSION_BROKER_VERSION.command,
    sessionId: projected.sessionId,
    generation: 1,
    leaseId: initialized.snapshot.lease!.leaseId,
    idempotencyKey,
    type: "prompt",
    prompt,
  });
  const body = {
    sessionId: projected.sessionId,
    generation: 1,
    cursor: 2,
    type: "command_committed",
    message: {
      role: "user",
      text: prompt,
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
      const result = sessionCommandResultSchema.parse({
        version: SESSION_BROKER_VERSION.commandResult,
        commandId,
        sessionId: projected.sessionId,
        generation: 1,
        leaseId: snapshot.lease!.leaseId,
        idempotencyKey,
        type: "prompt",
        disposition: "committed",
        eventCursor: 2,
        snapshot: updated,
        committedAt: occurredAt,
      });
      await input.client.query(
        `INSERT INTO codeops.session_commands
           (command_id, session_id, idempotency_key, command_json, result_json,
            principal_id, committed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::timestamptz)`,
        [
          commandId,
          projected.sessionId,
          idempotencyKey,
          canonicalJsonText(command),
          canonicalJsonText(result),
          projected.ownerPrincipalId,
          occurredAt,
        ],
      );
      await input.client.query(
        `INSERT INTO codeops.session_events
           (event_id, session_id, generation, cursor, event_type, event_json,
            command_id, occurred_at)
         VALUES ($1, $2, 1, 2, $3, $4::jsonb, $5, $6::timestamptz)`,
        [
          event.eventId,
          event.sessionId,
          event.type,
          canonicalJsonText(event),
          commandId,
          occurredAt,
        ],
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
  await projectSupervisorState({
    client: input.client,
    request: input.request,
    runId: input.runId,
    phase: "started",
    now: input.now,
  });
  return projected.sessionId;
}

export async function projectAgentJobSessionTerminal(input: {
  client: TransactionClient;
  request: AgentJobDispatchRequest;
  runId: string;
  response: string;
  state: "completed" | "failed";
  source?: "live" | "retained-reconciliation";
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
    if (snapshot.state === input.state) {
      // The exact terminal projection is already durable. The separate
      // supervision projection below remains independently idempotent.
    } else if (
      !(
        snapshot.state === "failed" &&
        input.state === "completed" &&
        input.source === "retained-reconciliation"
      ) &&
      (snapshot.state === "completed" || snapshot.state === "failed")
    ) {
      throw new Error("Agent Job terminal reconciliation conflicts with stored state");
    } else {
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
          messageId:
            input.source === "retained-reconciliation"
              ? `agent-job-response:${input.runId}:reconciled`
              : `agent-job-response:${input.runId}`,
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
        [
          projected.sessionId,
          canonicalJsonText(updated),
          updated.lease!.leaseId,
          occurredAt,
        ],
      );
    }
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
  await projectSupervisorState({
    client: input.client,
    request: input.request,
    runId: input.runId,
    phase:
      input.source === "retained-reconciliation"
        ? "reconciled"
        : input.state,
    now: input.now,
  });
}
