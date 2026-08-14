import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../sql/session-broker.sql", import.meta.url);
const revertUrl = new URL("../sql/session-broker-revert.sql", import.meta.url);
const outboxUrl = new URL("../sql/session-broker-runtime-outbox.sql", import.meta.url);
const outboxRevertUrl = new URL("../sql/session-broker-runtime-outbox-revert.sql", import.meta.url);
const receiptsUrl = new URL("../sql/session-runtime-execution-receipts.sql", import.meta.url);
const receiptsRevertUrl = new URL("../sql/session-runtime-execution-receipts-revert.sql", import.meta.url);
const jobInitializationUrl = new URL("../sql/session-job-initialization.sql", import.meta.url);
const jobInitializationRevertUrl = new URL("../sql/session-job-initialization-revert.sql", import.meta.url);
const permissionRelayUrl = new URL("../sql/session-runtime-permission-relay.sql", import.meta.url);
const permissionRelayRevertUrl = new URL("../sql/session-runtime-permission-relay-revert.sql", import.meta.url);
const githubMutationsUrl = new URL("../sql/session-runtime-github-mutations.sql", import.meta.url);
const githubMutationsRevertUrl = new URL("../sql/session-runtime-github-mutations-revert.sql", import.meta.url);
const lifecycleJournalUrl = new URL("../sql/work-item-lifecycle-journal.sql", import.meta.url);
const lifecycleJournalRevertUrl = new URL("../sql/work-item-lifecycle-journal-revert.sql", import.meta.url);
const workspaceLaunchUrl = new URL("../sql/workspace-launch.sql", import.meta.url);
const workspaceLaunchRevertUrl = new URL("../sql/workspace-launch-revert.sql", import.meta.url);
const workspaceArtifactsUrl = new URL("../sql/workspace-checkpoint-artifacts.sql", import.meta.url);
const workspaceArtifactsRevertUrl = new URL("../sql/workspace-checkpoint-artifacts-revert.sql", import.meta.url);

test("defines the durable session, command, and ordered event identities", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.sessions/);
  assert.match(sql, /session_id text PRIMARY KEY/);
  assert.match(sql, /CHECK \(\(snapshot_json->>'generation'\)::bigint = generation\)/);
  assert.match(sql, /lease_id uuid NOT NULL/);
  assert.doesNotMatch(sql, /snapshot_json->>'state' = 'deleted'/);
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
  assert.match(sql, /completion_json jsonb/);
  assert.match(sql, /result_json jsonb/);
  assert.match(sql, /completed_by text/);
  assert.match(sql, /completion_json->>'dispatchId'/);
  assert.match(sql, /result_json->>'idempotencyKey'/);
  assert.match(sql, /dispatch_json#>>'\{command,sessionId\}' = session_id/);
  assert.match(sql, /CREATE INDEX session_runtime_outbox_claim_idx/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*DROP TABLE codeops\.session_runtime_outbox;[\s\S]*COMMIT;\n$/);
});

test("defines an immutable lifecycle journal and one JetStream relay lease", async () => {
  const sql = await readFile(lifecycleJournalUrl, "utf8");
  const revert = await readFile(lifecycleJournalRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.work_item_lifecycle \(/);
  assert.match(sql, /UNIQUE \(workflow_id, run_id\)/);
  assert.match(sql, /CREATE TABLE codeops\.work_item_lifecycle_events/);
  assert.match(sql, /UNIQUE \(repository, provider, workspace_id, project_id, work_item_id, sequence\)/);
  assert.match(sql, /work item lifecycle events are immutable/);
  assert.match(sql, /CREATE TABLE codeops\.work_item_lifecycle_publications/);
  assert.match(sql, /status IN \('pending', 'claimed', 'published'\)/);
  assert.match(sql, /delivery_driver text/);
  assert.match(sql, /delivery_destination text/);
  assert.match(sql, /delivery_position text/);
  assert.match(sql, /delivery_receipt_digest text/);
  assert.match(sql, /delivery_receipt_json jsonb/);
  assert.match(sql, /CREATE INDEX work_item_lifecycle_publication_claim_idx/);
  assert.doesNotMatch(sql, /consumer_id|projector_id|plane_delivery/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*DROP TABLE codeops\.work_item_lifecycle;[\s\S]*COMMIT;\n$/);
});

test("defines immutable digest-bound runtime execution receipts", async () => {
  const sql = await readFile(receiptsUrl, "utf8");
  const revert = await readFile(receiptsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_execution_receipts/);
  assert.match(sql, /dispatch_id uuid PRIMARY KEY/);
  assert.match(sql, /REFERENCES codeops\.session_runtime_outbox\(dispatch_id\)/);
  assert.match(sql, /dispatch_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /status IN \('started', 'completed'\)/);
  assert.match(sql, /status = 'started' AND result_json IS NULL/);
  assert.match(sql, /status = 'completed' AND result_json IS NOT NULL/);
  assert.match(sql, /completed_at >= created_at/);
  assert.match(sql, /result_json jsonb/);
  assert.match(sql, /result_json->>'type' IN/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*DROP TABLE codeops\.session_runtime_execution_receipts;[\s\S]*COMMIT;\n$/);
});

test("admits commandless events only for Job-created session roots", async () => {
  const sql = await readFile(jobInitializationUrl, "utf8");
  const revert = await readFile(jobInitializationRevertUrl, "utf8");
  assert.match(sql, /ALTER COLUMN command_id DROP NOT NULL/);
  assert.match(
    sql,
    /CHECK \(command_id IS NOT NULL OR event_type = 'session_created'\)/,
  );
  assert.match(revert, /ALTER COLUMN command_id SET NOT NULL/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("persists claim-bound runtime permission requests and their option map", async () => {
  const sql = await readFile(permissionRelayUrl, "utf8");
  const revert = await readFile(permissionRelayRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_permission_requests/);
  assert.match(sql, /PRIMARY KEY \(dispatch_id, request_id\)/);
  assert.match(sql, /UNIQUE \(session_id, request_id\)/);
  assert.match(sql, /REFERENCES codeops\.session_runtime_outbox\(dispatch_id\)/);
  assert.match(
    sql,
    /event_type IN \('session_created', 'permission_requested'\)/,
  );
  assert.match(sql, /codeops\.session-runtime-permission-submission\/v1/);
  assert.match(revert, /DROP TABLE IF EXISTS codeops\.session_runtime_permission_requests/);
  assert.match(revert, /event_type = 'session_created'/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("consumes one GitHub mutation permission before provider effects", async () => {
  const sql = await readFile(githubMutationsUrl, "utf8");
  const revert = await readFile(githubMutationsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_github_mutations/);
  assert.match(sql, /operation_id text PRIMARY KEY/);
  assert.match(sql, /dispatch_id uuid NOT NULL UNIQUE/);
  assert.match(sql, /payload_digest text NOT NULL/);
  assert.match(sql, /permission_digest text NOT NULL/);
  assert.match(sql, /status IN \('started', 'completed'\)/);
  assert.match(sql, /status = 'started' AND result_json IS NULL/);
  assert.match(sql, /status = 'completed' AND result_json IS NOT NULL/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(
    revert,
    /^BEGIN;[\s\S]*DROP TABLE codeops\.session_runtime_github_mutations;[\s\S]*COMMIT;\n$/,
  );
});

test("persists idempotent principal-bound workspace launches", async () => {
  const sql = await readFile(workspaceLaunchUrl, "utf8");
  const revert = await readFile(workspaceLaunchRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.workspace_launches/);
  assert.match(sql, /UNIQUE \(principal_id, idempotency_key\)/);
  assert.match(sql, /state IN \('queued', 'provisioning', 'ready', 'failed'\)/);
  assert.match(sql, /request_json jsonb NOT NULL/);
  assert.match(sql, /launch_json jsonb NOT NULL/);
  assert.match(sql, /terminal workspace launch is immutable/);
  assert.match(sql, /workspace_launch_active_principal_idx/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*DROP TABLE IF EXISTS codeops\.workspace_launches;[\s\S]*COMMIT;\n$/);
});

test("retains bounded checkpoint payloads instead of digest-only evidence", async () => {
  const sql = await readFile(workspaceArtifactsUrl, "utf8");
  const revert = await readFile(workspaceArtifactsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.workspace_checkpoint_artifacts/);
  assert.match(sql, /artifact_content bytea NOT NULL/);
  assert.match(sql, /octet_length\(artifact_content\) = artifact_bytes/);
  assert.match(sql, /artifact_bytes <= 16000000/);
  assert.match(sql, /REFERENCES codeops\.sessions\(session_id\)/);
  assert.match(revert, /DROP TABLE codeops\.workspace_checkpoint_artifacts/);
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
