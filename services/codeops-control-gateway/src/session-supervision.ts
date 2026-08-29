import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  canonicalJsonText,
  isWorkspaceSessionIdentity,
  SESSION_BROKER_VERSION,
  sessionEventSchema,
  sessionSnapshotSchema,
  sessionSupervisionReconciliationRequestSchema,
  sessionSupervisionReconciliationResultSchema,
  temporalCodeOpsSessionIdentitySchema,
  trustedTemporalCodeOpsSessionIdentitySchema,
  type SessionSnapshot,
  type SessionSupervisionReconciliationRequest,
  type SessionSupervisionReconciliationResult,
} from "@codeops/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import type { TransactionClient } from "./session-broker-repository.js";

interface StoredSessionRow extends Record<string, unknown> {
  readonly session_id: unknown;
  readonly snapshot_json: unknown;
  readonly owner_principal_id: unknown;
}

interface StoredProjectionRow extends Record<string, unknown> {
  readonly event_json: unknown;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const valueDigest = digest(value);
  return `${valueDigest.slice(0, 8)}-${valueDigest.slice(8, 12)}-4${valueDigest.slice(13, 16)}-a${valueDigest.slice(17, 20)}-${valueDigest.slice(20, 32)}`;
}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${digest(JSON.stringify(body))}`;
}

function parseTemporalChildIdentity(snapshot: SessionSnapshot) {
  const identity = snapshot.identity;
  return "version" in identity &&
      identity.version === "codeops.temporal-session-identity/v2"
    ? trustedTemporalCodeOpsSessionIdentitySchema.parse(identity)
    : temporalCodeOpsSessionIdentitySchema.parse(identity);
}

function childResultUri(snapshot: SessionSnapshot): string | undefined {
  const identity = parseTemporalChildIdentity(snapshot);
  return snapshot.state === "completed"
    ? `artifact:///agent-runs/${identity.runId}/result.json`
    : undefined;
}

function assertChildIdentity(
  request: SessionSupervisionReconciliationRequest,
  snapshot: SessionSnapshot,
): ReturnType<typeof parseTemporalChildIdentity> {
  const identity = parseTemporalChildIdentity(snapshot);
  if (
    identity.repository !== request.repository ||
    identity.workItemId !== request.workItemId ||
    identity.workflowId !== request.workflowId ||
    identity.pullRequestNumber !== request.pullRequestNumber ||
    identity.pullRequestHeadSha !== request.pullRequestHeadSha ||
    identity.agentRole === undefined ||
    !["coding", "critic", "revision"].includes(identity.agentRole)
  ) {
    throw new Error("supervision child session identity drifted");
  }
  return identity;
}

export async function reconcileSessionSupervision(
  client: TransactionClient,
  rawRequest: unknown,
  input: { readonly now?: () => Date } = {},
): Promise<SessionSupervisionReconciliationResult> {
  const request = sessionSupervisionReconciliationRequestSchema.parse(rawRequest);
  const sessionIds = [
    request.supervisorSessionId,
    ...request.childSessionIds,
  ].sort();
  const occurredAt = (input.now ?? (() => new Date()))().toISOString();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const stored = await client.query<StoredSessionRow>(
      `SELECT session_id, snapshot_json, owner_principal_id
         FROM codeops.sessions
        WHERE session_id = ANY($1::text[])
        ORDER BY session_id ASC
        FOR UPDATE`,
      [sessionIds],
    );
    if (stored.rows.length !== sessionIds.length) {
      throw new Error("supervision reconciliation requires every exact session");
    }
    const rows = new Map(
      stored.rows.map((row) => [String(row.session_id), row] as const),
    );
    const supervisorRow = rows.get(request.supervisorSessionId);
    const supervisor = sessionSnapshotSchema.parse(supervisorRow?.snapshot_json);
    if (
      supervisor.sessionId !== request.supervisorSessionId ||
      !isWorkspaceSessionIdentity(supervisor.identity)
    ) {
      throw new Error("supervision reconciliation requires one workspace session");
    }
    const owner = String(supervisorRow?.owner_principal_id ?? "");
    if (owner.length === 0) {
      throw new Error("supervision reconciliation supervisor owner is invalid");
    }

    let currentSupervisor = supervisor;
    const projected: {
      childSessionId: string;
      disposition: "created" | "existing";
      eventCursor: number;
    }[] = [];
    for (const childSessionId of request.childSessionIds) {
      const childRow = rows.get(childSessionId);
      const child = sessionSnapshotSchema.parse(childRow?.snapshot_json);
      if (
        child.sessionId !== childSessionId ||
        String(childRow?.owner_principal_id ?? "") !== owner
      ) {
        throw new Error("supervision reconciliation session owner drifted");
      }
      const childIdentity = assertChildIdentity(request, child);
      const projectionId = deterministicUuid(
        `${request.idempotencyKey}\0${childSessionId}`,
      );
      const existing = await client.query<StoredProjectionRow>(
        `SELECT event_json
           FROM codeops.session_events
          WHERE session_id = $1
            AND event_json#>>'{update,kind}' = 'supervision'
            AND event_json#>>'{update,projectionId}' = $2
          ORDER BY cursor ASC`,
        [request.supervisorSessionId, projectionId],
      );
      if (existing.rows.length > 1) {
        throw new Error("supervision projection identity is duplicated");
      }
      const resultUri = childResultUri(child);
      const update = {
        kind: "supervision" as const,
        projectionId,
        childSessionId,
        childState: child.state,
        childEventCursor: child.eventCursor,
        repository: childIdentity.repository,
        workItemId: childIdentity.workItemId!,
        workflowId: childIdentity.workflowId,
        pullRequestNumber: childIdentity.pullRequestNumber!,
        pullRequestHeadSha: childIdentity.pullRequestHeadSha!,
        agentRole: childIdentity.agentRole as "coding" | "critic" | "revision",
        round: childIdentity.round!,
        ...(resultUri === undefined ? {} : { resultUri }),
      };
      if (existing.rows.length === 1) {
        const event = sessionEventSchema.parse(existing.rows[0]!.event_json);
        if (canonicalJsonText(event.update) !== canonicalJsonText(update)) {
          throw new Error("supervision projection identity conflicts with stored state");
        }
        projected.push({
          childSessionId,
          disposition: "existing",
          eventCursor: event.cursor,
        });
        continue;
      }
      const cursor = currentSupervisor.eventCursor + 1;
      const body = {
        sessionId: currentSupervisor.sessionId,
        generation: currentSupervisor.generation,
        cursor,
        type: "acp_update" as const,
        update,
        occurredAt,
      };
      const event = sessionEventSchema.parse({
        version: SESSION_BROKER_VERSION.event,
        eventId: eventId(body),
        ...body,
      });
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
          canonicalJsonText(event),
          event.occurredAt,
        ],
      );
      currentSupervisor = sessionSnapshotSchema.parse({
        ...currentSupervisor,
        eventCursor: cursor,
        updatedAt: occurredAt,
      });
      projected.push({ childSessionId, disposition: "created", eventCursor: cursor });
    }
    if (currentSupervisor.eventCursor !== supervisor.eventCursor) {
      await client.query(
        `UPDATE codeops.sessions
            SET snapshot_json = $2::jsonb, updated_at = $3::timestamptz
          WHERE session_id = $1`,
        [
          currentSupervisor.sessionId,
          canonicalJsonText(currentSupervisor),
          currentSupervisor.updatedAt,
        ],
      );
    }
    await client.query("COMMIT");
    return sessionSupervisionReconciliationResultSchema.parse({
      version: "codeops.session-supervision-reconciliation-result/v1",
      idempotencyKey: request.idempotencyKey,
      supervisorSessionId: request.supervisorSessionId,
      projected,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export class InvalidSessionSupervisionReconciliationRequestError extends Error {}

export async function serveSessionSupervisionReconciliation(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly reconcile: (request: unknown) => Promise<SessionSupervisionReconciliationResult>;
}): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null> {
  if (
    input.method !== "POST" ||
    input.url !== "/v1/session-supervision/reconciliations"
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
    throw new InvalidSessionSupervisionReconciliationRequestError(
      "session supervision reconciliation content type must be application/json",
    );
  }
  let request: unknown;
  try {
    request = sessionSupervisionReconciliationRequestSchema.parse(
      await input.readBody(),
    );
  } catch {
    throw new InvalidSessionSupervisionReconciliationRequestError(
      "session supervision reconciliation body is invalid",
    );
  }
  return { status: 200, body: await input.reconcile(request) };
}
