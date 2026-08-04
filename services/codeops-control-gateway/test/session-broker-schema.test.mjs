import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../sql/session-broker.sql", import.meta.url);
const revertUrl = new URL("../sql/session-broker-revert.sql", import.meta.url);
const outboxUrl = new URL("../sql/session-broker-runtime-outbox.sql", import.meta.url);
const outboxRevertUrl = new URL("../sql/session-broker-runtime-outbox-revert.sql", import.meta.url);

test("defines the durable session, command, and ordered event identities", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.sessions/);
  assert.match(sql, /session_id text PRIMARY KEY/);
  assert.match(sql, /CHECK \(\(snapshot_json->>'generation'\)::bigint = generation\)/);
  assert.match(sql, /CHECK \(\(snapshot_json->>'state' = 'deleted'\) = \(lease_id IS NULL\)\)/);
  assert.match(sql, /'waiting_permission', 'checkpointing'\)\) =\s*\(snapshot_json#>>'\{lease,status\}' = 'active'\)/);
  assert.match(sql, /\(snapshot_json->>'state' = 'waiting_permission'\) =\s*\(snapshot_json->'pendingPermission' <> 'null'::jsonb\)/);
  assert.match(sql, /CREATE TABLE codeops\.session_commands/);
  assert.match(sql, /UNIQUE \(session_id, idempotency_key\)/);
  assert.match(sql, /principal_id text NOT NULL/);
  assert.match(sql, /CREATE TABLE codeops\.session_events/);
  assert.match(sql, /UNIQUE \(session_id, cursor\)/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CHECK \(event_json->>'eventId' = event_id\)/);
});

test("defines an immutable lease-claimed runtime outbox", async () => {
  const sql = await readFile(outboxUrl, "utf8");
  const revert = await readFile(outboxRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_outbox/);
  assert.match(sql, /UNIQUE \(session_id, idempotency_key\)/);
  assert.match(sql, /status IN \('pending', 'claimed', 'completed'\)/);
  assert.match(sql, /claim_expires_at > claimed_at/);
  assert.match(sql, /dispatch_json#>>'\{command,sessionId\}' = session_id/);
  assert.match(sql, /CREATE INDEX session_runtime_outbox_claim_idx/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*DROP TABLE codeops\.session_runtime_outbox;[\s\S]*COMMIT;\n$/);
});

test("orders migration and reversion around foreign-key dependencies", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  const revert = await readFile(revertUrl, "utf8");
  assert.ok(sql.indexOf("codeops.sessions") < sql.indexOf("codeops.session_commands"));
  assert.ok(sql.indexOf("codeops.session_commands") < sql.indexOf("codeops.session_events"));
  assert.ok(revert.indexOf("codeops.session_events") < revert.indexOf("codeops.session_commands"));
  assert.ok(revert.indexOf("codeops.session_commands") < revert.indexOf("codeops.sessions"));
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});
