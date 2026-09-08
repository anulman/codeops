import { z } from "zod";
import {
  agentMessageInputSchema, agentMessageRequestSchema, agentMessageSchema,
  canonicalJsonText, sha256CanonicalJsonDigest, sessionSnapshotSchema,
  messageTextSchema, checkpointDescriptorSchema,
  type AgentMessage, type AgentMessageInput, type AgentMessageResult,
} from "@codeops/codeops-contracts";
import { decodeWorkspaceContextAttachment, verifyWorkspaceContextAttachments } from
  "@codeops/codeops-contracts/workspace-context-node";
import { loadClaimedDispatchAuthority, selectClaimedWorkspaceSource,
  type ClaimedDispatchAuthority } from "./claimed-dispatch-authority.js";
import type { TransactionClient } from "./session-broker-repository.js";

export const supervisorRouteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  projectId: z.string().uuid(), ownerPrincipalId: z.string().min(1).max(256),
  supervisorPrincipalId: z.string().min(1).max(256),
  // Dedicated messaging credential; never a worker, Plane, Telegram or heartbeat token.
  token: z.string().min(32).max(4096),
  sessions: z.array(z.object({ sessionId: z.string().min(1).max(128), workItemId: z.string().uuid() }).strict()).max(100).default([]),
  openClawUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
}).strict();
export type SupervisorRoute = z.infer<typeof supervisorRouteSchema>;
export class AgentMessageConflictError extends Error {}
function fail(): never { throw new AgentMessageConflictError("message identity or scope is unavailable"); }
const exact = (a: unknown, b: unknown) => canonicalJsonText(a) === canonicalJsonText(b);

export function parseSupervisorRoutes(value: unknown, reservedTokens: readonly string[] = []): SupervisorRoute[] {
  const routes = z.array(supervisorRouteSchema).max(100).parse(value);
  if (new Set(routes.map((r) => r.id)).size !== routes.length ||
      new Set(routes.map((r) => `${r.repository}\0${r.projectId}\0${r.ownerPrincipalId}`)).size !== routes.length ||
      new Set(routes.map((r) => r.token)).size !== routes.length ||
      routes.some((r) => reservedTokens.includes(r.token))) fail();
  return routes;
}

function message(row: Record<string, unknown>): AgentMessage {
  return agentMessageSchema.parse({ ...(row.message_json as object), state:
    row.answered_at ? "answered" : row.acknowledged_at ? "acknowledged" :
      row.delivered_at ? "delivered" : "persisted" });
}

async function currentSession(client: TransactionClient, sessionId: string, generation: number) {
  const selected = await client.query(
    "SELECT snapshot_json, owner_principal_id FROM codeops.sessions WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const row = selected.rows[0];
  if (!row) fail();
  const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
  if (snapshot.sessionId !== sessionId || snapshot.generation !== generation ||
      ["completed", "failed", "cancelled", "archived"].includes(snapshot.state)) fail();
  return { snapshot, owner: String(row.owner_principal_id) };
}

function routeForMessage(routes: readonly SupervisorRoute[], item: AgentMessage): SupervisorRoute {
  const route = routes.find((r) => r.id === item.routeId && r.version === item.routeVersion &&
    r.repository === item.scope.repository && r.projectId === item.scope.projectId);
  if (!route) fail();
  return route;
}

async function assertProjectScope(client: TransactionClient, route: SupervisorRoute,
  sessionId: string, workItemId: string): Promise<void> {
  const admitted = await client.query(
    "SELECT repository, project_id, work_item_id FROM codeops.work_item_admissions WHERE child_session_id = $1",
    [sessionId],
  );
  const row = admitted.rows[0];
  if (row) {
    if (row.repository !== route.repository || row.project_id !== route.projectId || row.work_item_id !== workItemId) fail();
  } else if (!route.sessions.some((binding) => binding.sessionId === sessionId && binding.workItemId === workItemId)) {
    fail();
  }
}

export async function assertMessageRecipient(client: TransactionClient,
  route: SupervisorRoute, item: AgentMessage): Promise<void> {
  await assertProjectScope(client, route, item.sessionId, item.scope.workItemId);
  const current = await currentSession(client, item.sessionId, item.generation);
  if (current.owner !== route.ownerPrincipalId || current.snapshot.lease?.leaseId !== item.leaseId ||
      (current.snapshot.identity.workItemId !== undefined && current.snapshot.identity.workItemId !== item.scope.workItemId) || route.id !== item.routeId ||
      route.version !== item.routeVersion || route.repository !== item.scope.repository ||
      route.projectId !== item.scope.projectId ||
      (item.inReplyTo === null ? item.recipient : item.sender) !== route.supervisorPrincipalId) fail();
}

async function verifyFriction(client: TransactionClient, authority: ClaimedDispatchAuthority,
  input: Extract<AgentMessageInput, { operation: "send" }>, sourceSha: string): Promise<void> {
  const report = input.friction;
  if (!report) return;
  // A candidate is an exact admitted base, or a finalized checkpoint descriptor.
  const baseCandidate = sha256CanonicalJsonDigest({ repository: input.scope.repository, sourceSha });
  if (report.candidate !== baseCandidate) {
    const found = await client.query(
      `SELECT descriptor_json FROM codeops.workspace_checkpoint_descriptors
        WHERE session_id = $1 AND generation = $2 AND descriptor_digest = $3`,
      [authority.snapshot.sessionId, authority.snapshot.generation, report.candidate],
    );
    if (!found.rows[0]) fail();
    const descriptor = checkpointDescriptorSchema.parse(found.rows[0].descriptor_json);
    if (!descriptor.manifest.sourcePatches.some((s) =>
      s.repository === input.scope.repository && s.baseSha === sourceSha)) fail();
  }
  // Only byte-verified admitted context is accepted as linked evidence. No URL fetch,
  // mutable external document, worker filesystem path or worker-attested sanitization.
  const command = authority.dispatch.command;
  const attachments = verifyWorkspaceContextAttachments(
    command.type === "prompt" ? command.contextAttachments ?? [] : [],
  );
  for (const uri of report.evidence) {
    const attachment = attachments.find((a) =>
      uri === `codeops-context://sha256/${a.digest.slice(7)}/${a.name}`);
    if (!attachment) fail();
    const evidence = decodeWorkspaceContextAttachment(attachment).toString("utf8");
    messageTextSchema.parse(evidence);
    const binding = JSON.parse(evidence) as Record<string, unknown>;
    if (binding.version !== "codeops.friction-evidence/v1" ||
        !exact(binding.scope, input.scope) || binding.sessionId !== authority.snapshot.sessionId ||
        binding.generation !== authority.snapshot.generation || binding.candidate !== report.candidate ||
        binding.sanitized !== true ||
        (report.cause.certainty === "verified" && binding.verifiedCause !== report.cause.description)) fail();
  }
}

async function persist(client: TransactionClient, input: {
  item: AgentMessage; key: string; request: unknown;
}): Promise<AgentMessage> {
  const item = input.item;
  const requestDigest = sha256CanonicalJsonDigest(input.request);
  const prior = await client.query(
    `SELECT * FROM codeops.agent_messages WHERE session_id = $1 AND generation = $2
      AND sender = $3 AND idempotency_key = $4 FOR UPDATE`,
    [item.sessionId, item.generation, item.sender, input.key],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].request_digest !== requestDigest) fail();
    return message(prior.rows[0]);
  }
  await client.query(
    `INSERT INTO codeops.agent_messages (message_id, thread_id, in_reply_to, session_id,
       generation, dispatch_id, sender, recipient, route_id, route_version,
       idempotency_key, request_digest, message_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [item.messageId, item.threadId, item.inReplyTo, item.sessionId, item.generation,
      item.dispatchId, item.sender, item.recipient, item.routeId, item.routeVersion,
      input.key, requestDigest, canonicalJsonText(item)],
  );
  // Notifications are hints. The durable outbox is drained on listener startup too.
  await client.query("SELECT pg_notify('codeops_agent_messages', $1)", [item.routeId]);
  return item;
}

async function acknowledge(client: TransactionClient, item: AgentMessage): Promise<void> {
  await client.query(`UPDATE codeops.agent_messages SET
    delivered_at = COALESCE(delivered_at, now()),
    acknowledged_at = COALESCE(acknowledged_at, now()) WHERE message_id = $1`, [item.messageId]);
}

export async function operateWorkerMessage(client: TransactionClient, input: {
  dispatchId: string; workerId: string; request: unknown;
  routes: readonly SupervisorRoute[];
}): Promise<AgentMessageResult> {
  const request = agentMessageRequestSchema.parse(input.request);
  if (input.routes.length === 0 && request.input.operation === "inbox") return { messages: [] };
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Serialize with completion/renewal and validate the deployed claim/profile fences.
    await client.query("SELECT dispatch_id FROM codeops.session_runtime_outbox WHERE dispatch_id = $1 FOR UPDATE", [input.dispatchId]);
    const authority = await loadClaimedDispatchAuthority(client, { ...input,
      claimToken: request.claimToken, requireClaimCount: true, allowedCommandTypes: ["prompt"] });
    const { snapshot } = await currentSession(client, authority.snapshot.sessionId, authority.snapshot.generation);
    if (snapshot.lease?.leaseId !== authority.dispatch.command.leaseId ||
        snapshot.lease?.status !== "active" || !authority.runtimeBinding) fail();
    const operation = request.input;
    let result: AgentMessage[];
    if (operation.operation === "send") {
      const source = selectClaimedWorkspaceSource(authority, operation.scope);
      const route = input.routes.find((r) => r.repository === source.repository &&
        r.projectId === operation.scope.projectId && r.ownerPrincipalId === authority.dispatch.principalId);
      if (!route || (authority.snapshot.identity.workItemId !== undefined &&
          authority.snapshot.identity.workItemId !== operation.scope.workItemId)) fail();
      await assertProjectScope(client, route, snapshot.sessionId, operation.scope.workItemId);
      // Project comes from durable admission or an exact configured Session binding.
      await verifyFriction(client, authority, operation, source.resolvedSha);
      const id = sha256CanonicalJsonDigest({ sessionId: snapshot.sessionId,
        generation: snapshot.generation, sender: snapshot.sessionId, key: operation.idempotencyKey });
      const item = agentMessageSchema.parse({
        version: "codeops.agent-message/v1", messageId: id, threadId: id, inReplyTo: null,
        scope: operation.scope, sessionId: snapshot.sessionId, generation: snapshot.generation,
        leaseId: authority.dispatch.command.leaseId, dispatchId: input.dispatchId,
        claimCount: authority.claimCount,
        authorityDigest: sha256CanonicalJsonDigest({ dispatch: authority.dispatch,
          runtimeBinding: authority.runtimeBinding, claimCount: authority.claimCount,
          claimToken: authority.claimToken }),
        sourceSha: source.resolvedSha, sender: snapshot.sessionId,
        recipient: route.supervisorPrincipalId, routeId: route.id, routeVersion: route.version,
        type: operation.type, body: operation.body,
        ...(operation.friction ? { friction: operation.friction } : {}),
        createdAt: new Date().toISOString(), state: "persisted", executionAuthority: false,
      });
      result = [await persist(client, { item, key: operation.idempotencyKey, request: { operation, leaseId: item.leaseId, sourceSha: item.sourceSha,
        identity: authority.snapshot.identity, runtimeBinding: authority.runtimeBinding,
        routeId: route.id, routeVersion: route.version, recipient: route.supervisorPrincipalId } })];
    } else if (operation.operation === "reply") {
      // Worker replies are not a supervisor impersonation or a new conversation route.
      fail();
    } else {
      // Select only current routing authority before LIMIT. Retained replies
      // from old routes/leases must not hide current replies or be adopted.
      const admission = await client.query(
        "SELECT repository, project_id, work_item_id FROM codeops.work_item_admissions WHERE child_session_id = $1",
        [snapshot.sessionId],
      );
      const admitted = admission.rows[0];
      const scopes = input.routes.filter(r => r.ownerPrincipalId === authority.dispatch.principalId)
        .flatMap(r => {
          const bindings = admitted
            ? (admitted.repository === r.repository && admitted.project_id === r.projectId
              ? [{ sessionId: snapshot.sessionId, workItemId: String(admitted.work_item_id) }] : [])
            : r.sessions;
          return bindings.filter(b => b.sessionId === snapshot.sessionId &&
            (snapshot.identity.workItemId === undefined || b.workItemId === snapshot.identity.workItemId))
            .map(b => ({ id: r.id, version: r.version, supervisor: r.supervisorPrincipalId,
              repository: r.repository, project: r.projectId, workItem: b.workItemId }));
        });
      const rows = await client.query(`SELECT * FROM codeops.agent_messages
        WHERE session_id = $1 AND generation = $2 AND recipient = $1
          AND message_json->>'leaseId' = $5
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset($6::jsonb) AS current_route(
            id text, version text, supervisor text, repository text, project text, "workItem" text)
            WHERE route_id = current_route.id AND route_version = current_route.version
              AND message_json->>'routeId' = current_route.id
              AND message_json->>'routeVersion' = current_route.version
              AND message_json->>'sender' = current_route.supervisor
              AND message_json#>>'{scope,repository}' = current_route.repository
              AND message_json#>>'{scope,projectId}' = current_route.project
              AND message_json#>>'{scope,workItemId}' = current_route."workItem")
          AND ($3::text IS NULL OR message_id = $3)
          AND ($3::text IS NOT NULL OR acknowledged_at IS NULL)
        ORDER BY created_at, message_id LIMIT $4 FOR UPDATE`,
      [snapshot.sessionId, snapshot.generation,
        operation.operation === "acknowledge" ? operation.messageId : null,
        operation.operation === "inbox" ? operation.limit : 1,
        authority.dispatch.command.leaseId, JSON.stringify(scopes)]);
      result = [];
      for (const row of rows.rows) {
        const item = message(row);
        try { await assertMessageRecipient(client, routeForMessage(input.routes, item), item); }
        catch (error) {
          if (operation.operation === "inbox" && error instanceof AgentMessageConflictError) continue;
          throw error;
        }
        if (operation.operation === "acknowledge") await acknowledge(client, item);
        else await client.query("UPDATE codeops.agent_messages SET delivered_at = COALESCE(delivered_at, now()) WHERE message_id = $1", [item.messageId]);
        result.push({ ...item, state: operation.operation === "acknowledge" ? "acknowledged" : "delivered" });
      }
      if (operation.operation === "acknowledge" && result.length !== 1) fail();
    }
    await client.query("COMMIT");
    return { messages: result };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function operateSupervisorMessage(client: TransactionClient, input: {
  route: SupervisorRoute; request: unknown;
}): Promise<AgentMessageResult> {
  const operation = agentMessageInputSchema.parse(input.request);
  if (operation.operation === "send") fail();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const rows = await client.query(`SELECT * FROM codeops.agent_messages
      WHERE route_id = $1 AND route_version = $2 AND recipient = $3
        AND ($4::text IS NULL OR message_id = $4)
        AND ($4::text IS NOT NULL OR acknowledged_at IS NULL OR
          (message_json->>'type' IN ('question', 'decision') AND answered_at IS NULL))
        AND EXISTS (SELECT 1 FROM codeops.sessions s
          WHERE s.session_id = codeops.agent_messages.session_id
            AND (s.snapshot_json->>'generation')::bigint = codeops.agent_messages.generation
            AND s.snapshot_json->>'state' NOT IN ('completed','failed','cancelled','archived')
            AND s.snapshot_json#>>'{lease,leaseId}' = message_json->>'leaseId')
      ORDER BY created_at, message_id LIMIT $5 FOR UPDATE`,
    [input.route.id, input.route.version, input.route.supervisorPrincipalId,
      operation.operation === "inbox" ? null : operation.messageId,
      operation.operation === "inbox" ? operation.limit : 1]);
    const result: AgentMessage[] = [];
    for (const row of rows.rows) {
      const item = message(row);
      await assertMessageRecipient(client, input.route, item);
      if (operation.operation === "reply") {
        if (item.type === "fyi" || (item.friction && !row.acknowledged_at)) fail();
        const id = sha256CanonicalJsonDigest({ sessionId: item.sessionId, generation: item.generation,
          sender: input.route.supervisorPrincipalId, key: operation.idempotencyKey });
        const { friction: _friction, ...original } = item;
        const reply = agentMessageSchema.parse({ ...original, messageId: id,
          inReplyTo: item.messageId, sender: input.route.supervisorPrincipalId, recipient: item.sessionId,
          type: "fyi", body: operation.body, createdAt: new Date().toISOString(), state: "persisted" });
        result.push(await persist(client, { item: reply, key: operation.idempotencyKey, request: operation }));
        await acknowledge(client, item);
        await client.query("UPDATE codeops.agent_messages SET answered_at = COALESCE(answered_at, now()) WHERE message_id = $1", [item.messageId]);
      } else if (operation.operation === "acknowledge") {
        // Accept each report once, then project the shared register by failure class.
        if (!row.acknowledged_at && item.friction) {
          await client.query(`INSERT INTO codeops.agent_friction_register
            (repository, project_id, failure_class, first_message_id, last_message_id, report_count)
            VALUES ($1,$2,$3,$4,$4,1)
            ON CONFLICT (repository, project_id, failure_class) DO UPDATE SET
              last_message_id = EXCLUDED.last_message_id,
              report_count = codeops.agent_friction_register.report_count + 1`,
          [item.scope.repository, item.scope.projectId, item.friction.failureClass, item.messageId]);
        }
        await acknowledge(client, item);
        result.push({ ...item, state: item.state === "answered" ? "answered" : "acknowledged" });
      } else {
        await client.query("UPDATE codeops.agent_messages SET delivered_at = COALESCE(delivered_at, now()) WHERE message_id = $1", [item.messageId]);
        result.push({ ...item, state: item.state === "persisted" ? "delivered" : item.state });
      }
    }
    if (operation.operation !== "inbox" && result.length !== 1) fail();
    await client.query("COMMIT");
    return { messages: result };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
