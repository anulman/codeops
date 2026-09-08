import { notificationRetryDelayMs } from "./notification-delivery-policy.js";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { agentMessageSchema } from "@codeops/codeops-contracts";
import { assertMessageRecipient, type SupervisorRoute } from "./agent-messages.js";

/** Wire contract for the dedicated OpenClaw messaging extension. HTTP acceptance
 * means durable, idempotent enqueue under messageId, not a model answer. The
 * extension answers through /v1/supervisor/messages with its scoped credential.
 * Native Telegram and heartbeat endpoints are deliberately not this protocol. */
export const openClawMessageReceiptSchema = z.object({
  version: z.literal("codeops.openclaw-message-receipt/v1"),
  messageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  routeId: z.string(), routeVersion: z.string(),
  disposition: z.enum(["persisted", "existing"]),
}).strict();

export async function deliverSupervisorMessage(client: PoolClient, route: SupervisorRoute,
  send: typeof fetch = fetch): Promise<boolean> {
  await client.query("BEGIN");
  try {
    const selected = await client.query(`SELECT * FROM codeops.agent_messages
      WHERE route_id = $1 AND route_version = $2 AND recipient = $3
        AND delivered_at IS NULL AND attempt_count < 8 AND available_at <= now()
      ORDER BY available_at, message_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [route.id, route.version, route.supervisorPrincipalId]);
    const row = selected.rows[0];
    if (!row) { await client.query("COMMIT"); return false; }
    const item = agentMessageSchema.parse(row.message_json);
    try {
      await assertMessageRecipient(client, route, item);
    } catch {
      // Stale recipient/generation: retain the entry, without routing to a replacement.
      await client.query("UPDATE codeops.agent_messages SET attempt_count = 8 WHERE message_id = $1", [item.messageId]);
      await client.query("COMMIT");
      return true;
    }
    const attempt = Number(row.attempt_count) + 1;
    try {
      const response = await send(route.openClawUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${route.token}`, "content-type": "application/json",
          "idempotency-key": item.messageId },
        body: JSON.stringify({ version: "codeops.openclaw-message-event/v1", message: item }),
      });
      if (!response.ok || !response.body) throw new Error("supervisor enqueue failed");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 4096) throw new Error("supervisor receipt exceeds limit");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const receipt = openClawMessageReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (receipt.messageId !== item.messageId || receipt.routeId !== route.id ||
          receipt.routeVersion !== route.version) throw new Error("supervisor receipt identity drifted");
      await client.query(`UPDATE codeops.agent_messages SET delivered_at = now(), attempt_count = $2
        WHERE message_id = $1`, [item.messageId, attempt]);
    } catch {
      // Same bounded delivery policy as Web Push. The receiving extension must
      // deduplicate the immutable message ID before accepting an event.
      await client.query(`UPDATE codeops.agent_messages SET attempt_count = $2,
        available_at = now() + ($3 * interval '1 millisecond') WHERE message_id = $1`,
      [item.messageId, attempt, notificationRetryDelayMs(attempt)]);
    }
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** LISTEN plus startup recovery and due-time retry, never transcript polling.
 * The timer is scheduled from durable outbox deadlines, including across restart. */
export function startSupervisorMessageAdapter(database: Pool, routes: readonly SupervisorRoute[]): () => Promise<void> {
  let stopped = false;
  let connection: PoolClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let nextRoute = 0;
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(wake, Math.max(25, ms));
    timer.unref();
  };
  const drain = async () => {
    try {
      if (!connection) {
        const listener = await database.connect();
        connection = listener;
        listener.on("notification", () => { again = true; wake(); });
        listener.on("error", () => {
          if (connection === listener) {
            connection = undefined; listener.release(true); schedule(5_000);
          }
        });
        try { await listener.query("LISTEN codeops_agent_messages"); }
        catch (error) {
          if (connection === listener) { connection = undefined; listener.release(true); }
          throw error;
        }
      }
      const client = await database.connect();
      try {
        let remaining = 4;
        for (let count = 0; count < 20 && !stopped && remaining > 0; count++) {
          let progressed = false;
          for (let offset = 0; offset < routes.length; offset++) {
            const route = routes[nextRoute++ % routes.length]!;
            if (remaining <= 0 || stopped) break;
            if (await deliverSupervisorMessage(client, route)) { progressed = true; remaining--; }
          }
          if (!progressed) break;
        }
        const due = await client.query(`SELECT MIN(available_at) AS due FROM codeops.agent_messages
          WHERE delivered_at IS NULL AND attempt_count < 8 AND in_reply_to IS NULL
            AND EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb)
              AS r(id text, version text, recipient text)
              WHERE r.id = route_id AND r.version = route_version AND r.recipient = codeops.agent_messages.recipient)`,
          [JSON.stringify(routes.map((r) => ({ id: r.id, version: r.version, recipient: r.supervisorPrincipalId })))]);
        if (due.rows[0]?.due) schedule(Math.max(25, new Date(due.rows[0].due).getTime() - Date.now()));
      } finally { client.release(); }
    } catch { schedule(5_000); }
  };
  function wake() {
    if (stopped) return;
    if (running) { again = true; return; }
    running = drain().finally(() => {
      running = undefined;
      if (again) { again = false; schedule(25); }
    });
  }
  if (routes.length > 0) wake();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
    if (connection) {
      await connection.query("UNLISTEN codeops_agent_messages").catch(() => {});
      connection.release(); connection = undefined;
    }
  };
}
