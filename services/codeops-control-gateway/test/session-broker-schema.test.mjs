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
const requestScopedGithubMutationsUrl = new URL("../sql/session-runtime-github-mutations-request-scoped-v2.sql", import.meta.url);
const requestScopedGithubMutationsRevertUrl = new URL("../sql/session-runtime-github-mutations-request-scoped-v2-revert.sql", import.meta.url);
const providerEffectReceiptsUrl = new URL("../sql/provider-effect-receipts-v1.sql", import.meta.url);
const providerEffectReceiptsRevertUrl = new URL("../sql/provider-effect-receipts-v1-revert.sql", import.meta.url);
const providerEffectPublicationUrl = new URL("../sql/provider-effect-publication-operations-v2.sql", import.meta.url);
const providerEffectPublicationRevertUrl = new URL("../sql/provider-effect-publication-operations-v2-revert.sql", import.meta.url);
const githubBranchCandidatesUrl = new URL("../sql/github-branch-publish-candidates-v1.sql", import.meta.url);
const githubBranchCandidatesRevertUrl = new URL("../sql/github-branch-publish-candidates-v1-revert.sql", import.meta.url);
const lifecycleJournalUrl = new URL("../sql/work-item-lifecycle-journal.sql", import.meta.url);
const lifecycleJournalRevertUrl = new URL("../sql/work-item-lifecycle-journal-revert.sql", import.meta.url);
const workspaceLaunchUrl = new URL("../sql/workspace-launch.sql", import.meta.url);
const workspaceLaunchRevertUrl = new URL("../sql/workspace-launch-revert.sql", import.meta.url);
const workspaceArtifactsUrl = new URL("../sql/workspace-checkpoint-artifacts.sql", import.meta.url);
const workspaceArtifactsRevertUrl = new URL("../sql/workspace-checkpoint-artifacts-revert.sql", import.meta.url);
const sessionNotificationsUrl = new URL("../sql/session-notifications.sql", import.meta.url);
const sessionNotificationsRevertUrl = new URL("../sql/session-notifications-revert.sql", import.meta.url);
const sessionNotificationKeyConstraintUrl = new URL(
  "../sql/session-notification-key-constraint-v2.sql",
  import.meta.url,
);
const sessionNotificationKeyConstraintRevertUrl = new URL(
  "../sql/session-notification-key-constraint-v2-revert.sql",
  import.meta.url,
);
const modelBudgetLedgerUrl = new URL("../sql/session-model-budget-ledger-v2.sql", import.meta.url);
const modelBudgetLedgerRevertUrl = new URL("../sql/session-model-budget-ledger-v2-revert.sql", import.meta.url);
const modelBudgetFunctionsUrl = new URL("../sql/session-model-budget-ledger-functions-v1.sql", import.meta.url);
const modelBudgetFunctionsRevertUrl = new URL("../sql/session-model-budget-ledger-functions-v1-revert.sql", import.meta.url);
const dispatchModelAuthorityUrl = new URL("../sql/session-dispatch-model-authority-v1.sql", import.meta.url);
const dispatchModelAuthorityRevertUrl = new URL("../sql/session-dispatch-model-authority-v1-revert.sql", import.meta.url);
const modelBudgetRecoveryUrl = new URL("../sql/session-model-budget-recovery-v1.sql", import.meta.url);
const modelBudgetRecoveryRevertUrl = new URL("../sql/session-model-budget-recovery-v1-revert.sql", import.meta.url);
const sessionOwnerUrl = new URL("../sql/session-owner-v1.sql", import.meta.url);
const sessionOwnerRevertUrl = new URL("../sql/session-owner-v1-revert.sql", import.meta.url);
const agentTerminalProgressUrl = new URL(
  "../sql/session-agent-terminal-progress-v1.sql",
  import.meta.url,
);
const agentTerminalProgressRevertUrl = new URL(
  "../sql/session-agent-terminal-progress-v1-revert.sql",
  import.meta.url,
);
const runtimeTerminalReconciliationUrl = new URL(
  "../sql/session-runtime-terminal-reconciliation-v1.sql",
  import.meta.url,
);
const runtimeTerminalReconciliationRevertUrl = new URL(
  "../sql/session-runtime-terminal-reconciliation-v1-revert.sql",
  import.meta.url,
);
const workItemAdmissionUrl = new URL("../sql/work-item-admission-v1.sql", import.meta.url);
const workItemAdmissionRevertUrl = new URL("../sql/work-item-admission-v1-revert.sql", import.meta.url);
const runtimePermissionConsumptionUrl = new URL(
  "../sql/runtime-permission-consumption-v1.sql",
  import.meta.url,
);
const runtimePermissionConsumptionRevertUrl = new URL(
  "../sql/runtime-permission-consumption-v1-revert.sql",
  import.meta.url,
);
const admittedChildMaterializationsUrl = new URL(
  "../sql/admitted-child-materializations-v1.sql", import.meta.url,
);
const admittedChildMaterializationsRevertUrl = new URL(
  "../sql/admitted-child-materializations-v1-revert.sql", import.meta.url,
);
const workItemAdmissionSourceUrl = new URL("../src/work-item-admission.ts", import.meta.url);
const workItemRetryUrl = new URL("../sql/work-item-retry-v1.sql", import.meta.url);
const workItemRetryRevertUrl = new URL("../sql/work-item-retry-v1-revert.sql", import.meta.url);
const workItemRetrySourceUrl = new URL("../src/work-item-retry.ts", import.meta.url);

test("defines bounded immutable retry lineage with a fail-closed revert", async () => {
  const sql = await readFile(workItemRetryUrl, "utf8");
  const revert = await readFile(workItemRetryRevertUrl, "utf8");
  const source = await readFile(workItemRetrySourceUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.work_item_retry_dispositions/);
  assert.match(sql, /attempt BETWEEN 1 AND 4/);
  assert.match(sql, /work_item_retry_successor_per_predecessor_idx/);
  assert.match(sql, /work_item_retry_dispositions_immutable/);
  assert.match(sql, /DISABLE TRIGGER work_item_admissions_immutable[\s\S]*ENABLE TRIGGER work_item_admissions_immutable/);
  assert.match(sql, /work_item_admissions_initial_work_item_idx[\s\S]*WHERE attempt = 1/);
  assert.match(sql, /session_runtime_outbox_retry_completion_fence/);
  assert.match(sql, /OLD\.claimed_at >= \([\s\S]*authority_expires_at/);
  assert.match(sql, /OLD\.claim_expires_at <= NEW\.completed_at/);
  assert.match(sql, /a\.attempt < retry\.attempt/);
  assert.match(sql, /provider_effect_receipts_failure_shape_check/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /retry_runtime_release/);
  assert.match(sql, /retryRuntime,runtimeWorkerImage/);
  assert.match(sql, /disposition_id, successor_launch_id, runtime_release/);
  assert.match(revert, /cannot revert work-item retry while retry authority exists/);
  assert.match(revert, /DROP TRIGGER session_runtime_outbox_retry_completion_fence/);
  assert.match(revert, /ADD UNIQUE \(repository, provider, workspace_id, project_id, work_item_id\)/);
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /clock_timestamp\(\) AS now/);
  assert.match(source, /terminal fact exists without its atomic retry disposition/);
  assert.match(source, /retry aggregate model budget is exhausted/);
  assert.ok(source.lastIndexOf("session_runtime_terminal_observations") >
    source.lastIndexOf("work_item_retry_dispositions"));
});

test("defines exact immutable admission authority and a fail-closed revert", async () => {
  const sql = await readFile(workItemAdmissionUrl, "utf8");
  const revert = await readFile(workItemAdmissionRevertUrl, "utf8");
  const source = await readFile(workItemAdmissionSourceUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.project_plan_approvals/);
  assert.match(sql, /jsonb_typeof\(authority_json->'workItems'\) = 'array'/);
  assert.match(sql, /CREATE TABLE codeops\.work_item_admissions/);
  assert.match(sql, /FOREIGN KEY \(admission_id, dispatch_id, session_id\)/);
  assert.doesNotMatch(sql, /reviewer_requirement|parent_projection|workflow_engine/);
  assert.match(revert, /cannot revert work-item admission while admitted work exists/);
  assert.match(revert, /cannot revert work-item admission while project-plan approval authority exists/);
  assert.match(revert, /DELETE FROM codeops\.schema_migrations WHERE migration_name = 'work-item-admission-v1'/);
  for (const key of ["session_runtime_outbox_admission_authority_key",
    "session_runtime_permission_requests_admission_authority_key", "session_events_admission_authority_key",
    "session_commands_admission_authority_key", "project_plan_approvals_admission_owner_key",
    "work_item_lifecycle_events_admission_owner_key", "work_item_admissions_child_outbox_key",
    "work_item_admissions_approval_parent_fk", "work_item_admissions_child_event_fk",
    "work_item_admissions_supervision_event_fk", "work_item_admissions_lifecycle_event_fk",
    "session_runtime_outbox_admission_child_fk"]) assert.match(sql, new RegExp(key));
  assert.match(sql, /decisionResult,eventCursor.*decisionResult,snapshot,eventCursor/);
  assert.match(sql, /request,workItem,provider,projectId/);
  for (const owner of ["session_runtime_outbox parent_dispatch", "session_runtime_permission_requests permission",
    "session_events plan_event", "session_commands decision", "sessions child", "session_events child_event",
    "session_model_budgets budget", "work_item_lifecycle_events lifecycle",
    "work_item_lifecycle_publications publication", "session_events supervision"]) {
    assert.match(source, new RegExp(owner.replaceAll(" ", "\\s+")));
  }
  assert.ok(source.indexOf("const replayed = await replayResult") < source.indexOf("SELECT session_id FROM codeops.session_runtime_outbox"));
  assert.doesNotMatch(source, /code === "23505"|code === "40001"|code === "40P01"/);
});

test("defines immutable admitted-child input and fails closed across old/new gateway ordering", async () => {
  const sql = await readFile(admittedChildMaterializationsUrl, "utf8");
  const revert = await readFile(admittedChildMaterializationsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.admitted_child_materializations/);
  assert.match(sql, /admitted_child_materializations_admission_fk/);
  assert.match(sql, /admitted_child_materializations_dispatch_fk/);
  assert.match(sql, /initial_dispatch_json jsonb GENERATED ALWAYS AS/);
  assert.match(sql, /initial_dispatch_digest text NOT NULL/);
  assert.match(sql, /dispatch_id, session_id, principal_id, dispatch_digest/);
  assert.doesNotMatch(sql, /UNIQUE\s*\([^)]*dispatch_json/s);
  assert.match(sql, /contextAttachments/);
  assert.match(sql, /reconciliation_owner text/);
  assert.match(sql, /reconciliation_token uuid/);
  assert.match(sql, /input is immutable/);
  assert.match(sql, /state cannot move backward/);
  assert.match(sql, /'runtime-authorized','success-finalizing','cleanup-pending'/);
  assert.match(sql, /OLD\.state = 'success-finalizing'.*'success-finalizing','cleanup-pending','ready'/s);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER work_item_admissions_require_materialization_owner/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /work-item admission requires a materialization owner/);
  assert.doesNotMatch(sql, /INSERT INTO codeops\.admitted_child_materializations\s+SELECT/i);
  assert.match(revert, /cannot revert admitted child materializations with durable rows/);
  assert.match(revert, /DROP TRIGGER work_item_admissions_require_materialization_owner/);
  assert.match(revert, /admitted-child-materializations-v1/);
});

test("consumes one admitted GitHub permission and retains its exact receipt", async () => {
  const sql = await readFile(runtimePermissionConsumptionUrl, "utf8");
  const revert = await readFile(runtimePermissionConsumptionRevertUrl, "utf8");
  assert.match(sql, /legacy_non_replayable = true/);
  assert.match(sql, /Legacy authorization lacks durable admission evidence/);
  assert.match(sql, /state = 'not_attempted'/);
  assert.match(sql, /provider_effect_marker text GENERATED ALWAYS/);
  assert.match(sql, /session_runtime_permission_requests_consumption_key/);
  assert.match(sql, /provider_effect_receipts_exact_permission_fk/);
  assert.match(sql, /authorization_expires_at/);
  assert.match(sql, /dispatch_claim_token/);
  assert.match(revert, /cannot revert runtime permission consumption after authority activation/);
  assert.match(revert, /runtime-permission-consumption-v1/);
});

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

test("adds one normalized non-null immutable session owner with an explicit legacy backfill", async () => {
  const sql = await readFile(sessionOwnerUrl, "utf8");
  const revert = await readFile(sessionOwnerRevertUrl, "utf8");
  assert.match(sql, /ADD COLUMN owner_principal_id text/);
  assert.match(sql, /current_setting\('codeops\.legacy_session_owner_principal_id', true\)/);
  assert.match(sql, /existing sessions require an explicit legacy owner principal/);
  assert.match(sql, /ALTER COLUMN owner_principal_id SET NOT NULL/);
  assert.match(sql, /owner_principal_id = btrim\(owner_principal_id\)/);
  assert.match(sql, /sessions_owner_updated_idx/);
  assert.match(sql, /CREATE TRIGGER sessions_owner_immutable/);
  assert.match(sql, /session owner principal is immutable/);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP TABLE/);
  assert.match(revert, /DROP TRIGGER sessions_owner_immutable/);
  assert.match(revert, /DROP FUNCTION codeops\.reject_session_owner_update/);
  assert.match(revert, /DROP COLUMN owner_principal_id/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
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

test("fences provider reservations to one live claimed dispatch authority", async () => {
  const sql = await readFile(dispatchModelAuthorityUrl, "utf8");
  const revert = await readFile(dispatchModelAuthorityRevertUrl, "utf8");
  assert.match(sql, /CREATE FUNCTION codeops\.reserve_session_dispatch_model_budget/);
  assert.match(sql, /snapshot_json#>>'\{lease,status\}' = 'active'/);
  assert.match(sql, /snapshot_json#>>'\{lease,generation\}'/);
  assert.match(sql, /outbox\.dispatch_id = requested_dispatch_id/);
  assert.match(sql, /outbox\.status = 'claimed'/);
  assert.match(sql, /outbox\.claim_expires_at > clock_timestamp\(\)/);
  assert.match(sql, /command,type.*'prompt', 'resume'/s);
  assert.match(sql, /CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID/);
  assert.match(sql, /reserve_session_model_budget/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.match(revert, /session-dispatch-model-authority-v1/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
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

test("admits only the commandless progress events emitted by adopted Agent sessions", async () => {
  const sql = await readFile(agentTerminalProgressUrl, "utf8");
  const revert = await readFile(agentTerminalProgressRevertUrl, "utf8");
  assert.match(
    sql,
    /event_type IN \(\s*'session_created',\s*'permission_requested',\s*'acp_update',\s*'state_changed'\s*\)/,
  );
  assert.doesNotMatch(sql, /checkpoint_committed|lease_changed|session_archived/);
  assert.match(
    revert,
    /event_type IN \('session_created', 'permission_requested'\)/,
  );
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("persists exact terminal identity and a durable fair scan cursor", async () => {
  const sql = await readFile(runtimeTerminalReconciliationUrl, "utf8");
  const revert = await readFile(runtimeTerminalReconciliationRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_terminal_observations/);
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_job_progress/);
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_legacy_job_allowlist/);
  assert.match(sql, /CREATE TABLE codeops\.session_runtime_reconciliation_scan/);
  assert.match(sql, /job_uid uuid PRIMARY KEY/);
  assert.match(sql, /UNIQUE \(session_id, generation\)/);
  assert.match(sql, /job_resource_version numeric\(40, 0\)/);
  assert.match(sql, /last_session_id text NOT NULL/);
  assert.match(sql, /current_setting\('codeops\.retained_runtime_job_uids'\)/);
  assert.match(sql, /event_type IN \([\s\S]*'runtime_terminal'/);
  assert.match(revert, /cannot remove runtime terminal reconciliation while observations exist/);
  assert.match(revert, /cannot remove runtime terminal reconciliation while Job progress exists/);
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

test("permits request-scoped GitHub mutations while preserving every row", async () => {
  const sql = await readFile(requestScopedGithubMutationsUrl, "utf8");
  const revert = await readFile(requestScopedGithubMutationsRevertUrl, "utf8");
  assert.match(sql, /DROP CONSTRAINT session_runtime_github_mutations_dispatch_id_key/);
  assert.match(sql, /CREATE INDEX session_runtime_github_mutations_dispatch_started_idx/);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP TABLE/);
  assert.match(revert, /ADD CONSTRAINT session_runtime_github_mutations_dispatch_id_key/);
  assert.match(revert, /UNIQUE \(dispatch_id\)/);
  assert.doesNotMatch(revert, /DELETE|TRUNCATE|DROP TABLE/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("migrates authorization consumption into explicit provider effect state", async () => {
  const sql = await readFile(providerEffectReceiptsUrl, "utf8");
  const revert = await readFile(providerEffectReceiptsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.provider_effect_receipts/);
  assert.match(sql, /'authorized',[\s\S]*'attempting',[\s\S]*'succeeded',[\s\S]*'failed',[\s\S]*'unknown'/);
  assert.match(sql, /'reconciled_satisfied',[\s\S]*'reconciled_not_observed',[\s\S]*'operator_resolved'/);
  assert.match(sql, /CASE legacy\.status WHEN 'completed' THEN 'succeeded' ELSE 'unknown' END/);
  assert.match(sql, /provider effect migration could not recover every authorization identity/);
  assert.match(sql, /DROP TABLE codeops\.session_runtime_github_mutations/);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE/);
  assert.match(revert, /states that the legacy schema cannot represent/);
  assert.match(revert, /CREATE TABLE codeops\.session_runtime_github_mutations/);
  assert.match(revert, /CASE state WHEN 'succeeded' THEN 'completed' ELSE 'started' END/);
  assert.doesNotMatch(revert, /DELETE|TRUNCATE/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("adds reversible publication operations to provider effect receipts", async () => {
  const sql = await readFile(providerEffectPublicationUrl, "utf8");
  const revert = await readFile(providerEffectPublicationRevertUrl, "utf8");
  assert.match(sql, /'branch_publish'/);
  assert.match(sql, /'pull_request_create'/);
  assert.match(sql, /'inspect_branch_commit'/);
  assert.match(sql, /'search_pull_request_marker'/);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP TABLE/);
  assert.match(revert, /cannot remove publication operations while their provider effects exist/);
  assert.doesNotMatch(revert, /DELETE|TRUNCATE|DROP TABLE/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("retains immutable candidate identity with one bounded cleanup index and guarded revert", async () => {
  const sql = await readFile(githubBranchCandidatesUrl, "utf8");
  const revert = await readFile(githubBranchCandidatesRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.github_branch_publish_candidate_manifests/);
  assert.match(sql, /candidate_bytes integer NOT NULL CHECK \(candidate_bytes BETWEEN 1 AND 4194304\)/);
  assert.match(sql, /chunk_count integer NOT NULL CHECK \(chunk_count BETWEEN 1 AND 64\)/);
  assert.match(sql, /effect_digest text NOT NULL/);
  assert.match(sql, /CREATE TABLE codeops\.github_branch_publish_candidate_chunks/);
  assert.match(sql, /chunk_bytes integer NOT NULL CHECK \(chunk_bytes BETWEEN 1 AND 65536\)/);
  assert.match(sql, /github_branch_publish_chunks_dispatch_operation_ordinal_idx/);
  assert.match(sql, /\(dispatch_id, operation_id, ordinal\)/);
  assert.doesNotMatch(sql, /expires|tenant|artifact|retention/);
  assert.match(revert, /cannot remove GitHub branch candidates while immutable manifests exist/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
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

test("defines reversible principal-bound Web Push delivery state", async () => {
  const sql = await readFile(sessionNotificationsUrl, "utf8");
  const revert = await readFile(sessionNotificationsRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.web_push_subscriptions/);
  assert.match(sql, /UNIQUE \(principal_id, device_id\)/);
  assert.match(sql, /endpoint_digest text NOT NULL UNIQUE/);
  assert.match(sql, /CREATE TABLE codeops\.session_notification_projections/);
  assert.match(sql, /CREATE TABLE codeops\.session_notification_outbox/);
  assert.match(sql, /CREATE TABLE codeops\.session_notification_deliveries/);
  assert.match(sql, /attempt_count BETWEEN 0 AND 8/);
  assert.match(sql, /CREATE INDEX session_notification_deliveries_available_idx/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(
    revert,
    /^BEGIN;[\s\S]*DROP TABLE IF EXISTS codeops\.session_notification_deliveries;[\s\S]*DROP TABLE IF EXISTS codeops\.web_push_subscriptions;[\s\S]*COMMIT;\n$/,
  );
});

test("uses PostgreSQL-safe Web Push key bounds and proves the maximum insert", async () => {
  const sql = await readFile(sessionNotificationKeyConstraintUrl, "utf8");
  const revert = await readFile(sessionNotificationKeyConstraintRevertUrl, "utf8");
  assert.match(sql, /char_length\(p256dh\) BETWEEN 40 AND 256/);
  assert.match(sql, /p256dh ~ '\^\[A-Za-z0-9_-\]\+\$'/);
  assert.doesNotMatch(sql, /\{40,256\}/);
  assert.match(sql, /LIKE codeops\.web_push_subscriptions INCLUDING CONSTRAINTS/);
  assert.match(sql, /repeat\('A', 256\)/);
  assert.match(sql, /INSERT INTO web_push_subscription_constraint_probe/);
  assert.match(revert, /char_length\(p256dh\) BETWEEN 40 AND 256/);
  assert.doesNotMatch(revert, /\{40,256\}/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
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

test("defines a reversible durable model budget ledger", async () => {
  const sql = await readFile(modelBudgetLedgerUrl, "utf8");
  const revert = await readFile(modelBudgetLedgerRevertUrl, "utf8");
  assert.match(sql, /CREATE TABLE codeops\.session_model_budgets/);
  assert.match(sql, /CREATE TABLE codeops\.session_model_budget_reservations/);
  assert.match(
    sql,
    /FOREIGN KEY \(session_id, budget_id\)[\s\S]*REFERENCES codeops\.session_model_budgets\(session_id, budget_id\)/,
  );
  assert.match(sql, /committed_provider_requests <= provider_requests_limit/);
  assert.match(
    sql,
    /settled_output_tokens \+ reserved_output_tokens <= output_tokens_limit/,
  );
  assert.match(
    sql,
    /state IN \('reserved', 'settled', 'provider_rejected', 'charged_unknown'\)/,
  );
  assert.match(sql, /snapshot_json#>>'\{budget,version\}' = 'codeops\.session-budget\/v1'/);
  assert.match(sql, /ON CONFLICT \(session_id\) DO NOTHING/);
  assert.match(revert, /codeops\.session-budget\/v2/);
  assert.ok(
    revert.indexOf("session_model_budget_reservations") <
      revert.indexOf("session_model_budgets"),
  );
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("defines a least-privilege model budget state machine", async () => {
  const sql = await readFile(modelBudgetFunctionsUrl, "utf8");
  const revert = await readFile(modelBudgetFunctionsRevertUrl, "utf8");
  assert.match(sql, /CREATE FUNCTION codeops\.reserve_session_model_budget/);
  assert.match(sql, /CREATE FUNCTION codeops\.settle_session_model_budget/);
  assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 2);
  assert.equal((sql.match(/SET search_path = pg_catalog, codeops/g) ?? []).length, 2);
  assert.ok(
    sql.indexOf("FROM codeops.session_model_budgets AS budgets") <
      sql.indexOf("FROM codeops.session_model_budget_reservations AS reservations"),
  );
  assert.match(sql, /CODEOPS_MODEL_BUDGET_EXHAUSTED:provider_requests/);
  assert.match(sql, /CODEOPS_MODEL_BUDGET_EXHAUSTED:output_tokens/);
  assert.match(sql, /WHEN 'charged_unknown' THEN locked_reservation\.reserved_output_tokens/);
  assert.match(sql, /REVOKE ALL ON FUNCTION codeops\.reserve_session_model_budget/);
  assert.match(sql, /REVOKE ALL ON FUNCTION codeops\.settle_session_model_budget/);
  assert.ok(
    revert.indexOf("settle_session_model_budget") <
      revert.indexOf("reserve_session_model_budget"),
  );
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});

test("charges stale proxy reservations through one fixed recovery function", async () => {
  const sql = await readFile(modelBudgetRecoveryUrl, "utf8");
  const revert = await readFile(modelBudgetRecoveryRevertUrl, "utf8");
  assert.match(
    sql,
    /CREATE FUNCTION codeops\.charge_stale_session_model_budget_reservations\(\)/,
  );
  assert.match(sql, /interval '15 minutes'/);
  assert.match(sql, /failure_class = 'proxy_stopped'/);
  assert.ok(
    sql.indexOf("FROM codeops.session_model_budgets AS budgets") <
      sql.indexOf("FROM codeops.session_model_budget_reservations AS reservations\n     WHERE reservations.reservation_id"),
  );
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, codeops/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.match(revert, /DROP FUNCTION IF EXISTS/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\n$/);
  assert.match(revert, /^BEGIN;[\s\S]*COMMIT;\n$/);
});
