import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { Client } from "pg";
import { canonicalJsonText, createEventId, createTransitionId, DEFAULT_SESSION_BUDGET_V2_LIMITS,
  projectSessionBudgetV2, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { migrateSessionBroker } from "../dist/session-broker-migration.js";
import {
  authorizeSessionRuntimeGitHubMutation,
  beginSessionRuntimeGitHubMutationAttempt,
  completeSessionRuntimeGitHubMutation,
  SessionRuntimeGitHubMutationConflictError,
} from "../dist/session-runtime-github-mutations.js";
import { loadUnknownProviderEffectReconciliation } from
  "../dist/provider-effect-receipts.js";
import { submitSessionRuntimePermission } from "../dist/session-runtime-permissions.js";
import { serveSessionRuntime } from "../dist/session-broker-runtime-http.js";
import { claimSessionRuntimeDispatch } from "../dist/session-broker-runtime-outbox.js";
import { admitSessionRuntimeWorkItem, WorkItemAdmissionConflictError } from "../dist/work-item-admission.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";
import { acknowledgeWorkItemLifecyclePublication, appendWorkItemLifecycleEvent,
  claimWorkItemLifecyclePublication } from "../dist/work-item-lifecycle-journal.js";
import { claimAdmittedChildMaterialization,
  loadAdmittedChildMaterialization,
  releaseAdmittedChildMaterializationClaim } from
  "../dist/admitted-child-materialization-controller.js";

const databaseUrl = process.env.CODEOPS_TEST_POSTGRES_URL?.trim();
const skip = databaseUrl === undefined ? "CODEOPS_TEST_POSTGRES_URL is not configured" : false;

function requireDedicatedDatabase() {
  const database = new URL(databaseUrl).pathname.slice(1);
  if (!/^codeops[_-].*test$/i.test(database)) throw new Error("CODEOPS_TEST_POSTGRES_URL must name a dedicated codeops *test database");
}

async function client() {
  const connection = new Client({ connectionString: databaseUrl });
  await connection.connect();
  return connection;
}

let suiteLock;
before(async () => {
  if (skip !== false) return;
  requireDedicatedDatabase();
  suiteLock = await client();
  await suiteLock.query("SELECT pg_advisory_lock(hashtext('codeops-control-gateway-postgres-tests'))");
});
after(async () => {
  if (suiteLock === undefined) return;
  await suiteLock.query("SELECT pg_advisory_unlock(hashtext('codeops-control-gateway-postgres-tests'))");
  await suiteLock.end();
});

const parentSessionId = "session-parent";
const driftSessionId = "session-drift";
const parentDispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const parentLeaseId = "33333333-3333-4333-8333-333333333333";
const owner = "access:owner@example.com";
const workerId = "runtime-worker:parent";
const admittedAt = "2026-08-30T10:00:00.000Z";
const sourceSha = "a".repeat(40);
const materialization = { profile: "custom", release: "v0.5.0-alpha.58",
  agentImage: `registry.example/agent@sha256:${"1".repeat(64)}`,
  runtimeWorkerImage: `registry.example/worker@sha256:${"2".repeat(64)}` };
const planContent = { type: "items", entries: [{ content: "Implement both items", priority: "high", status: "pending" }] };
const planDigest = sha256CanonicalJsonDigest(planContent);
const workItems = [
  { repository: "example-org/example-repository", provider: { kind: "plane",
    workspaceId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" },
    workItemId: "66666666-6666-4666-8666-666666666666" },
  { repository: "example-org/example-repository", provider: { kind: "plane",
    workspaceId: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555" },
    workItemId: "77777777-7777-4777-8777-777777777777" },
];

function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

function parentSnapshot(eventCursor = 5, activeChildren = 4) {
  return { version: "codeops.session-snapshot/v1", sessionId: parentSessionId, generation: 1, state: "running",
    identity: { version: "codeops.session-workspace-identity/v1",
      policy: { version: "codeops.session-policy/v1", mode: "review", workspaceAccess: "read-only",
        modelCalls: "allowed", modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
      contextAttachments: [], workspace: { version: "codeops.workspace/v1", sources: [{ catalogKey: "repository",
        repository: workItems[0].repository, checkoutPath: "sources/repository", requestedRef: "main", resolvedSha: sourceSha }],
        scratchPath: "scratch" }, workflowId: "workspace-launch", runId: "launch-parent", displayName: "Parent",
      parentSessionId: null, forkedAtCursor: null },
    lease: { leaseId: parentLeaseId, generation: 1, status: "active", holderId: "workspace-runtime",
      acquiredAt: "2026-08-30T09:00:00.000Z", expiresAt: "2026-08-30T12:00:00.000Z" },
    checkpoint: null, pendingPermission: null,
    budget: projectSessionBudgetV2({ budgetId: parentSessionId, revision: 1,
      startedAt: "2026-08-30T09:00:00.000Z", observedAt: "2026-08-30T09:00:00.000Z",
      limits: { ...DEFAULT_SESSION_BUDGET_V2_LIMITS, activeChildren } }),
    eventCursor, capabilities: sessionCapabilitiesFor("running", false), updatedAt: admittedAt };
}

function admissionRequest(index = 0) {
  const tail = index === 0 ? "8" : "9";
  return { version: "codeops.work-item-admission/v1",
    admissionId: `${tail.repeat(8)}-${tail.repeat(4)}-4${tail.repeat(3)}-8${tail.repeat(3)}-${tail.repeat(12)}`,
    claimToken, plan: { planId: "approved-plan", planDigest, permissionRequestId: "approve-plan" },
    workItem: { ...workItems[index], workflowId: `workflow-${index}`, runId: `run-${index}`, sourceSha,
      title: `Implement item ${index}`, prompt: `Implement only approved item ${index}.` },
    child: { sessionId: `session-child-${index}`,
      leaseId: index === 0 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      holderId: `runtime-worker:child-${index}`,
      dispatchId: index === 0 ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      idempotencyKey: index === 0 ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : "ffffffff-ffff-4fff-8fff-ffffffffffff" } };
}

async function resetAndSeed(connection, activeChildren = 4) {
  await connection.query("DROP SCHEMA IF EXISTS codeops CASCADE");
  await migrateSessionBroker(connection);
  const dispatchSnapshot = parentSnapshot(2, activeChildren);
  const currentSnapshot = parentSnapshot(5, activeChildren);
  const dispatch = { version: "codeops.session-runtime-dispatch/v1", dispatchId: parentDispatchId,
    principalId: owner, command: { version: "codeops.session-command/v1", sessionId: parentSessionId,
      generation: 1, leaseId: parentLeaseId, idempotencyKey: "12121212-1212-4121-8121-121212121212",
      type: "prompt", prompt: "Prepare an implementation plan.", contextAttachments: [] }, snapshot: dispatchSnapshot,
    dispatchedAt: "2026-08-30T09:30:00.000Z" };
  const operation = { kind: "project_plan", planId: "approved-plan", planDigest, workItems };
  const permission = { version: "codeops.session-runtime-permission-submission/v1", claimToken,
    request: { requestId: "approve-plan", title: "Approve plan", description: "Admit the exact items.", operation,
      operationDigest: sha256CanonicalJsonDigest(operation), options: [{ optionId: "allow-once", label: "Allow once" }],
      requestedAt: "2026-08-30T09:45:00.000Z" }, acpSessionId: "parent-acp", toolCallId: "approve-plan-call",
    options: [{ optionId: "allow-once", acpOptionId: "allow_once" }] };
  const decisionId = "13131313-1313-4131-8131-131313131313";
  const decision = { version: "codeops.session-command/v1", sessionId: parentSessionId, generation: 1,
    leaseId: parentLeaseId, idempotencyKey: "14141414-1414-4141-8141-141414141414", type: "respond_permission",
    permissionRequestId: "approve-plan", decision: { outcome: "selected", optionId: "allow-once" } };
  const result = { version: "codeops.session-command-result/v1", commandId: decisionId,
    sessionId: parentSessionId, generation: 1, leaseId: parentLeaseId, idempotencyKey: decision.idempotencyKey,
    type: "respond_permission", disposition: "committed", eventCursor: 5, snapshot: currentSnapshot,
    committedAt: "2026-08-30T09:50:00.000Z" };
  const planBody = { sessionId: parentSessionId, generation: 1, cursor: 3, type: "acp_update",
    update: { kind: "plan_update", planId: "approved-plan", content: planContent }, occurredAt: "2026-08-30T09:40:00.000Z" };
  const planEvent = { version: "codeops.session-event/v1", eventId: digest(planBody), ...planBody };
  await connection.query("BEGIN");
  try {
    await connection.query(`INSERT INTO codeops.sessions(session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
      VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`, [parentSessionId, parentLeaseId, canonicalJsonText(currentSnapshot), admittedAt, owner]);
    const driftSnapshot = { ...currentSnapshot, sessionId: driftSessionId };
    await connection.query(`INSERT INTO codeops.sessions(session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
      VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`,
      [driftSessionId, parentLeaseId, canonicalJsonText(driftSnapshot), admittedAt, owner]);
    await connection.query(`INSERT INTO codeops.session_runtime_outbox(dispatch_id,session_id,idempotency_key,principal_id,
      dispatch_json,status,available_at,created_at,claim_token,claimed_by,claimed_at,claim_expires_at,claim_count)
      VALUES($1,$2,$3,$4,$5::jsonb,'claimed',$6::timestamptz,$6::timestamptz,$7,$8,$9::timestamptz,$10::timestamptz,1)`,
      [parentDispatchId, parentSessionId, dispatch.command.idempotencyKey, owner, canonicalJsonText(dispatch),
        dispatch.dispatchedAt, claimToken, workerId, "2026-08-30T09:55:00.000Z", "2026-08-30T11:00:00.000Z"]);
    await connection.query(`INSERT INTO codeops.session_runtime_permission_requests(dispatch_id,request_id,session_id,request_json,created_at)
      VALUES($1,'approve-plan',$2,$3::jsonb,$4::timestamptz)`,
      [parentDispatchId, parentSessionId, canonicalJsonText(permission), permission.request.requestedAt]);
    await connection.query(`INSERT INTO codeops.session_commands(command_id,session_id,idempotency_key,command_json,result_json,principal_id,committed_at)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`,
      [decisionId, parentSessionId, decision.idempotencyKey, canonicalJsonText(decision), canonicalJsonText(result), owner, result.committedAt]);
    await connection.query(`INSERT INTO codeops.session_events(event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,1,3,'acp_update',$3::jsonb,$4,$5::timestamptz)`,
      [planEvent.eventId, parentSessionId, canonicalJsonText(planEvent), decisionId, planEvent.occurredAt]);
    await connection.query("COMMIT");
  } catch (error) { await connection.query("ROLLBACK"); throw error; }
}

async function admit(connection, request = admissionRequest(0), time = admittedAt) {
  return admitSessionRuntimeWorkItem(connection, { dispatchId: parentDispatchId, workerId, request,
    materialization, now: () => new Date(time) });
}

async function commitGitHubPermissionDecision(connection, childSessionId, permission, ordinal = 0) {
  const current = (await connection.query(
    "SELECT snapshot_json FROM codeops.sessions WHERE session_id=$1",
    [childSessionId],
  )).rows[0].snapshot_json;
  const committedAt = `2026-08-30T10:${String(12 + ordinal).padStart(2, "0")}:00.000Z`;
  const next = { ...current, state: "running", pendingPermission: null,
    eventCursor: current.eventCursor + 1, capabilities: sessionCapabilitiesFor("running", false),
    updatedAt: committedAt };
  const digit = String(ordinal + 1);
  const commandId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const idempotencyKey = `${digit.repeat(7)}2-${digit.repeat(3)}2-4${digit.repeat(2)}2-8${digit.repeat(2)}2-${digit.repeat(11)}2`;
  const command = { version: "codeops.session-command/v1", sessionId: childSessionId,
    generation: 1, leaseId: current.lease.leaseId, idempotencyKey,
    type: "respond_permission", permissionRequestId: permission.request.requestId,
    decision: { outcome: "selected", optionId: "allow-once" } };
  const result = { version: "codeops.session-command-result/v1", commandId,
    sessionId: childSessionId, generation: 1, leaseId: current.lease.leaseId,
    idempotencyKey, type: "respond_permission", disposition: "committed",
    eventCursor: next.eventCursor, snapshot: next, committedAt };
  await connection.query(`INSERT INTO codeops.session_commands
    (command_id,session_id,idempotency_key,command_json,result_json,principal_id,committed_at)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`,
  [commandId, childSessionId, idempotencyKey, canonicalJsonText(command),
    canonicalJsonText(result), owner, committedAt]);
  await connection.query(`UPDATE codeops.sessions SET snapshot_json=$2::jsonb,updated_at=$3::timestamptz
    WHERE session_id=$1`, [childSessionId, canonicalJsonText(next), committedAt]);
  return { command, result };
}

test("PostgreSQL applies and truthfully reverts the admission migration", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await connection.query("DROP SCHEMA IF EXISTS codeops CASCADE");
    await migrateSessionBroker(connection);
    assert.deepEqual((await connection.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='codeops' AND table_name IN
        ('admitted_child_materializations','project_plan_approvals','work_item_admissions') ORDER BY table_name`))
      .rows.map((row) => row.table_name), ["admitted_child_materializations",
        "project_plan_approvals", "work_item_admissions"]);
    const materializationRevert = await readFile(new URL(
      "../sql/admitted-child-materializations-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(materializationRevert);
    const consumptionRevert = await readFile(new URL(
      "../sql/runtime-permission-consumption-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(consumptionRevert);
    const revert = await readFile(new URL("../sql/work-item-admission-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(revert);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.schema_migrations WHERE migration_name='work-item-admission-v1'"))
      .rows[0].count, 0);
    assert.equal((await connection.query("SELECT to_regclass('codeops.work_item_admissions') relation")).rows[0].relation, null);
  } finally { await connection.end(); }
});

test("PostgreSQL fences legacy GitHub authority without admission or permission rows", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const revert = await readFile(new URL(
      "../sql/runtime-permission-consumption-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(revert);
    const permissionEffectId = `githubmutation-${"a".repeat(64)}`;
    const missingPermissionEffectId = `githubmutation-${"b".repeat(64)}`;
    const unattemptedMissingPermissionEffectId = `githubmutation-${"e".repeat(64)}`;
    const operation = { kind: "github_mutation", repository: workItems[0].repository,
      operation: "check_rerun", pullRequestNumber: null, targetId: "1234",
      expectedHeadSha: sourceSha, payloadJson: "{}" };
    const permission = { version: "codeops.session-runtime-permission-submission/v1",
      claimToken, request: { requestId: "permission-legacy-without-admission",
        title: "Legacy permission", description: "Historical row.", operation,
        operationDigest: sha256CanonicalJsonDigest(operation),
        options: [{ optionId: "allow-once", label: "Allow once" }],
        requestedAt: admittedAt }, acpSessionId: "codeops-github",
      toolCallId: permissionEffectId,
      options: [{ optionId: "allow-once", acpOptionId: "allow-once" }] };
    await connection.query(`INSERT INTO codeops.session_runtime_permission_requests
      (dispatch_id,request_id,session_id,request_json,created_at)
      VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)`,
    [parentDispatchId, permission.request.requestId, parentSessionId,
      canonicalJsonText(permission), admittedAt]);
    await connection.query(`INSERT INTO codeops.provider_effect_receipts
      (effect_id,provider,repository,operation,pull_request_number,target_id,
       expected_head_sha,session_id,dispatch_id,payload_digest,permission_digest,
       state,reconciliation_action,authorized_at,attempted_at,updated_at)
      VALUES($1,'github',$2,'check_rerun',NULL,'1234',$3,$4,$5,$6,$7,
       'unknown','inspect_check_attempts',$8::timestamptz,$8::timestamptz,
       $8::timestamptz)`, [missingPermissionEffectId, workItems[0].repository,
      sourceSha, parentSessionId, parentDispatchId, `sha256:${"c".repeat(64)}`,
      `sha256:${"d".repeat(64)}`, admittedAt]);
    await connection.query(`INSERT INTO codeops.provider_effect_receipts
      (effect_id,provider,repository,operation,pull_request_number,target_id,
       expected_head_sha,session_id,dispatch_id,payload_digest,permission_digest,
       state,reconciliation_action,authorized_at,updated_at)
      VALUES($1,'github',$2,'check_rerun',NULL,'5678',$3,$4,$5,$6,$7,
       'authorized','inspect_check_attempts',$8::timestamptz,$8::timestamptz)`,
    [unattemptedMissingPermissionEffectId, workItems[0].repository,
      sourceSha, parentSessionId, parentDispatchId, `sha256:${"e".repeat(64)}`,
      `sha256:${"f".repeat(64)}`, admittedAt]);
    const migration = await readFile(new URL(
      "../sql/runtime-permission-consumption-v1.sql", import.meta.url), "utf8");
    await connection.query(migration);
    const fencedPermission = (await connection.query(
      `SELECT legacy_non_replayable,admission_id,operation_id
         FROM codeops.session_runtime_permission_requests WHERE request_id=$1`,
      [permission.request.requestId])).rows[0];
    assert.deepEqual(fencedPermission, {
      legacy_non_replayable: true, admission_id: null, operation_id: null,
    });
    const fencedReceipt = (await connection.query(
      `SELECT legacy_non_replayable,state,attempted_at IS NOT NULL AS attempted,
              permission_request_id,provider_effect_marker
         FROM codeops.provider_effect_receipts WHERE effect_id=$1`,
      [missingPermissionEffectId])).rows[0];
    assert.deepEqual(fencedReceipt, { legacy_non_replayable: true,
      state: "operator_resolved", attempted: true, permission_request_id: null,
      provider_effect_marker: `codeops-provider-effect:${missingPermissionEffectId}` });
    const unattemptedFencedReceipt = (await connection.query(
      `SELECT legacy_non_replayable,state,attempted_at IS NOT NULL AS attempted,
              permission_request_id,provider_effect_marker
         FROM codeops.provider_effect_receipts WHERE effect_id=$1`,
      [unattemptedMissingPermissionEffectId])).rows[0];
    assert.deepEqual(unattemptedFencedReceipt, { legacy_non_replayable: true,
      state: "not_attempted", attempted: false, permission_request_id: null,
      provider_effect_marker:
        `codeops-provider-effect:${unattemptedMissingPermissionEffectId}` });
  } finally { await connection.end(); }
});

test("PostgreSQL enforces admission constraints, rollback visibility, and row locking on admission rows", { skip }, async () => {
  requireDedicatedDatabase();
  const setup = await client(); const first = await client(); const second = await client();
  try {
    await resetAndSeed(setup); const created = await admit(setup);
    const durable = (await setup.query(`SELECT input_json,state_json FROM codeops.admitted_child_materializations
      WHERE admission_id=$1`, [created.admissionId])).rows[0];
    assert.equal(durable.input_json.contextAttachments.length, 0);
    assert.equal(durable.input_json.images.agent, materialization.agentImage);
    assert.equal(durable.input_json.initialDispatch.dispatchId, created.dispatchId);
    assert.equal(durable.state_json.state, "queued");
    await assert.rejects(setup.query(`UPDATE codeops.admitted_child_materializations
      SET input_json=jsonb_set(input_json,'{release}','"drift"') WHERE admission_id=$1`,
    [created.admissionId]), /input is immutable/);
    await setup.query("BEGIN");
    for (const next of ["provisioning", "runtime-authorized", "success-finalizing"]) {
      await setup.query(`UPDATE codeops.admitted_child_materializations SET state=$2,
        state_json=jsonb_set(state_json,'{state}',to_jsonb($2::text)) WHERE admission_id=$1`,
      [created.admissionId, next]);
    }
    await setup.query("SAVEPOINT success_finalization_transition");
    await assert.rejects(setup.query(`UPDATE codeops.admitted_child_materializations
      SET state='runtime-authorized',state_json=jsonb_set(state_json,'{state}',
        '"runtime-authorized"') WHERE admission_id=$1`, [created.admissionId]),
    /state cannot move backward/);
    await setup.query("ROLLBACK TO SAVEPOINT success_finalization_transition");
    await setup.query(`UPDATE codeops.admitted_child_materializations SET state='ready',
      state_json=jsonb_set(state_json,'{state}','"ready"') WHERE admission_id=$1`,
    [created.admissionId]);
    await setup.query("ROLLBACK");
    await assert.rejects(setup.query("UPDATE codeops.work_item_admissions SET source_sha=$2 WHERE admission_id=$1",
      [created.admissionId, "b".repeat(40)]), /immutable/);
    await setup.query("BEGIN");
    await setup.query("ALTER TABLE codeops.project_plan_approvals DISABLE TRIGGER project_plan_approvals_immutable");
    await assert.rejects(setup.query("UPDATE codeops.project_plan_approvals SET authority_json='{}'::jsonb"),
      (error) => error.code === "23514");
    await setup.query("ROLLBACK");

    await first.query("BEGIN");
    await first.query("ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable");
    await assert.rejects(first.query(
      "UPDATE codeops.work_item_admissions SET authority_digest=$2 WHERE admission_id=$1",
      [created.admissionId, `sha256:${"f".repeat(64)}`]),
    (error) => error.code === "23503" &&
      error.constraint === "admitted_child_materializations_admission_fk");
    await first.query("ROLLBACK");

    const rollbackOnlyAdmittedAt = "2026-08-30T10:01:00.000Z";
    await first.query("BEGIN");
    await first.query("ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable");
    await first.query(`UPDATE codeops.work_item_admissions SET admitted_at=$2::timestamptz,
      authority_json=jsonb_set(authority_json,'{admittedAt}',to_jsonb($2::text)) WHERE admission_id=$1`,
    [created.admissionId, rollbackOnlyAdmittedAt]);
    assert.notEqual((await second.query("SELECT admitted_at FROM codeops.work_item_admissions WHERE admission_id=$1",
      [created.admissionId])).rows[0].admitted_at.toISOString(), rollbackOnlyAdmittedAt);
    await first.query("ROLLBACK");

    await first.query("BEGIN");
    await first.query("SELECT admission_id FROM codeops.work_item_admissions WHERE admission_id=$1 FOR UPDATE", [created.admissionId]);
    await second.query("BEGIN"); await second.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(second.query("SELECT admission_id FROM codeops.work_item_admissions WHERE admission_id=$1 FOR UPDATE",
      [created.admissionId]), (error) => error.code === "55P03");
    await second.query("ROLLBACK"); await first.query("ROLLBACK");
  } finally {
    await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    await Promise.allSettled([first.end(), second.end(), setup.end()]);
  }
});

test("ordinary PostgreSQL role admits and exclusively claims one exact materialization owner", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  const role = "codeops_admission_ordinary_test";
  try {
    await resetAndSeed(connection);
    await connection.query(`DROP ROLE IF EXISTS ${role}`);
    await connection.query(`CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN`);
    await connection.query(`GRANT USAGE ON SCHEMA codeops TO ${role}`);
    await connection.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codeops TO ${role}`);
    await connection.query(`SET ROLE ${role}`);
    assert.equal((await connection.query(`SELECT rolsuper FROM pg_roles WHERE rolname=current_user`)).rows[0].rolsuper, false);
    const result = await admit(connection);
    assert.equal((await connection.query(`SELECT count(*)::integer AS count
      FROM codeops.admitted_child_materializations WHERE admission_id=$1`, [result.admissionId])).rows[0].count, 1);
    const firstToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const replacementToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    assert.deepEqual(await claimAdmittedChildMaterialization(
      connection, "ordinary-controller", firstToken), { admissionId: result.admissionId,
      token: firstToken });
    assert.equal(await claimAdmittedChildMaterialization(
      connection, "ordinary-controller", replacementToken), null);
    await releaseAdmittedChildMaterializationClaim(
      connection, result.admissionId, replacementToken);
    assert.equal((await connection.query(`SELECT reconciliation_token::text AS token
      FROM codeops.admitted_child_materializations WHERE admission_id=$1`,
    [result.admissionId])).rows[0].token, firstToken);
    await releaseAdmittedChildMaterializationClaim(connection, result.admissionId, firstToken);
    assert.deepEqual(await claimAdmittedChildMaterialization(
      connection, "replacement-controller", replacementToken), { admissionId: result.admissionId,
      token: replacementToken });
    await connection.query("RESET ROLE");
  } finally {
    await connection.query("RESET ROLE").catch(() => undefined);
    await connection.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await connection.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await connection.end();
  }
});

test("PostgreSQL fair scan serializes RFC3339 that scan-then-load parsing accepts", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const admitted = await admit(connection);
    assert.equal((await claimAdmittedChildMaterialization(connection))?.admissionId,
      admitted.admissionId);
    const loaded = await loadAdmittedChildMaterialization(connection, admitted.admissionId);
    assert.match(loaded.state.updatedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally { await connection.end(); }
});

test("PostgreSQL inserts and replays a maximum-size admitted prompt through a bounded dispatch key", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const request = admissionRequest(0);
    request.workItem = { ...request.workItem, prompt: "p".repeat(100_000) };
    const created = await admit(connection, request);
    assert.equal((await admit(connection, request, "2026-08-30T10:01:00.000Z")).disposition,
      "replayed");
    const row = (await connection.query(`SELECT octet_length(outbox.dispatch_json::text) AS bytes,
        outbox.dispatch_digest,materialization.initial_dispatch_digest
      FROM codeops.session_runtime_outbox outbox
      JOIN codeops.admitted_child_materializations materialization
        ON materialization.child_dispatch_id=outbox.dispatch_id
      WHERE materialization.admission_id=$1`, [created.admissionId])).rows[0];
    assert.ok(Number(row.bytes) > 100_000);
    assert.match(row.dispatch_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.dispatch_digest, row.initial_dispatch_digest);
    const definition = (await connection.query(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname='session_runtime_outbox_materialization_dispatch_key'`))
      .rows[0].definition;
    assert.match(definition, /dispatch_digest/);
    assert.doesNotMatch(definition, /dispatch_json/);
    await connection.query("BEGIN");
    await connection.query(`UPDATE codeops.session_runtime_outbox
      SET dispatch_digest=$2 WHERE dispatch_id=$1`, [created.dispatchId,
      `sha256:${"f".repeat(64)}`]);
    await assert.rejects(connection.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error) => error.code === "23503");
    await connection.query("ROLLBACK");
    const original = (await connection.query(`SELECT dispatch_json
      FROM codeops.session_runtime_outbox WHERE dispatch_id=$1`, [created.dispatchId]))
      .rows[0].dispatch_json;
    await connection.query(`UPDATE codeops.session_runtime_outbox SET dispatch_json=
      jsonb_set(dispatch_json,'{command,prompt}','"drift"') WHERE dispatch_id=$1`,
    [created.dispatchId]);
    await assert.rejects(admit(connection, request, "2026-08-30T10:02:00.000Z"),
      /child dispatch payload drifted/);
    await connection.query(`UPDATE codeops.session_runtime_outbox SET dispatch_json=$2::jsonb
      WHERE dispatch_id=$1`, [created.dispatchId, canonicalJsonText(original)]);
  } finally { await connection.end(); }
});

test("PostgreSQL prioritizes and concurrency-fences the exact admitted initial dispatch", { skip }, async () => {
  requireDedicatedDatabase();
  const setup = await client(); const first = await client(); const second = await client();
  try {
    for (const [ordinal, laterAt] of [
      [0, admittedAt],
      [1, "2026-08-30T09:00:00.000Z"],
    ]) {
      await resetAndSeed(setup);
      const admitted = await admit(setup);
      const stored = (await setup.query(`SELECT outbox.dispatch_json,session.snapshot_json
        FROM codeops.session_runtime_outbox outbox
        JOIN codeops.sessions session ON session.session_id=outbox.session_id
        WHERE outbox.dispatch_id=$1`, [admitted.dispatchId])).rows[0];
      const tail = ordinal === 0 ? "4" : "5";
      const laterDispatchId = `${tail.repeat(8)}-${tail.repeat(4)}-4${tail.repeat(3)}-8${tail.repeat(3)}-${tail.repeat(12)}`;
      const laterKey = `${tail.repeat(7)}6-${tail.repeat(3)}6-4${tail.repeat(2)}6-8${tail.repeat(2)}6-${tail.repeat(11)}6`;
      const later = { ...stored.dispatch_json, dispatchId: laterDispatchId,
        command: { ...stored.dispatch_json.command, idempotencyKey: laterKey,
          prompt: "A later child command." }, dispatchedAt: laterAt };
      await setup.query(`INSERT INTO codeops.session_runtime_outbox
        (dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,dispatch_digest,
         status,available_at,created_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,'pending',$7::timestamptz,$7::timestamptz)`,
      [laterDispatchId, later.command.sessionId, laterKey, later.principalId,
        canonicalJsonText(later), sha256CanonicalJsonDigest(later), laterAt]);
      const authority = { sessionId: later.command.sessionId,
        generation: later.command.generation, leaseId: later.command.leaseId,
        identity: stored.snapshot_json.identity };
      const claimInput = (worker, token) => ({ workerId: worker, ...authority,
        leaseMs: 60_000, now: () => new Date("2026-08-30T10:02:00.000Z"),
        claimToken: () => token });
      if (ordinal === 0) {
        const claimed = await claimSessionRuntimeDispatch(setup,
          claimInput("runtime-worker:equal", "56565656-5656-4565-8565-565656565656"));
        assert.equal(claimed.dispatch.dispatchId, admitted.dispatchId);
      } else {
        const claims = await Promise.all([
          claimSessionRuntimeDispatch(first, claimInput("runtime-worker:first",
            "57575757-5757-4575-8575-575757575757")),
          claimSessionRuntimeDispatch(second, claimInput("runtime-worker:second",
            "58585858-5858-4585-8585-585858585858")),
        ]);
        assert.deepEqual(claims.map((claim) => claim?.dispatch.dispatchId ?? null).sort(),
          [null, admitted.dispatchId].sort());
        assert.equal((await setup.query(`SELECT status FROM codeops.session_runtime_outbox
          WHERE dispatch_id=$1`, [laterDispatchId])).rows[0].status, "pending");
      }
    }
  } finally { await Promise.allSettled([first.end(), second.end(), setup.end()]); }
});

test("PostgreSQL rejects forged decision-result linkage before projection admission", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    for (const mutations of [
      [{ path: "{generation}", value: "2" }, { path: "{snapshot,generation}", value: "2" },
        { path: "{snapshot,lease,generation}", value: "2" }],
      [{ path: "{leaseId}", value: '"abababab-abab-4bab-8bab-abababababab"' }],
      [{ path: "{type}", value: '"cancel"' }],
      [{ path: "{eventCursor}", value: "999" }],
    ]) {
      await resetAndSeed(connection);
      for (const mutation of mutations) {
        await connection.query(`UPDATE codeops.session_commands
          SET result_json=jsonb_set(result_json,$1::text[],$2::jsonb)
          WHERE command_json->>'type'='respond_permission'`,
          [mutation.path, mutation.value]);
      }
      await assert.rejects(admit(connection), /does not bind its durable command and snapshot/);
      assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.project_plan_approvals")).rows[0].count, 0);
      assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.work_item_admissions")).rows[0].count, 0);
    }
  } finally { await connection.end(); }
});

test("PostgreSQL rejects schema-valid parent dispatch decision identity drift on creation and replay", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    await connection.query(`UPDATE codeops.session_commands SET result_json=jsonb_set(
      result_json,'{snapshot,identity,displayName}','"Decision identity drift"')
      WHERE command_json->>'type'='respond_permission'`);
    await assert.rejects(admit(connection), /claimed parent dispatch snapshot identity does not match/);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.project_plan_approvals")).rows[0].count, 0);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.work_item_admissions")).rows[0].count, 0);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.work_item_lifecycle")).rows[0].count, 0);

    await resetAndSeed(connection); const request = admissionRequest(0); await admit(connection, request);
    const stored = (await connection.query("SELECT authority_json FROM codeops.project_plan_approvals")).rows[0].authority_json;
    const driftedDecisionResult = { ...stored.decisionResult, snapshot: { ...stored.decisionResult.snapshot,
      identity: { ...stored.decisionResult.snapshot.identity, displayName: "Replay identity drift" } } };
    const driftedApproval = { ...stored, decisionResult: driftedDecisionResult };
    await connection.query("BEGIN");
    await connection.query("ALTER TABLE codeops.project_plan_approvals DISABLE TRIGGER project_plan_approvals_immutable");
    try {
      await assert.rejects(connection.query(
        `UPDATE codeops.project_plan_approvals SET authority_digest=$1,authority_json=$2::jsonb`,
        [sha256CanonicalJsonDigest(driftedApproval), canonicalJsonText(driftedApproval)]),
      (error) => error.code === "23503" &&
        error.constraint === "admitted_child_materializations_approval_fk");
    } finally {
      await connection.query("ROLLBACK");
    }
    await connection.query(`UPDATE codeops.session_commands SET result_json=$1::jsonb
      WHERE command_json->>'type'='respond_permission'`, [canonicalJsonText(driftedDecisionResult)]);
    await assert.rejects(admit(connection, request, "2026-08-30T10:01:00.000Z"),
      /project-plan decision result payload drifted/);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.work_item_admissions")).rows[0].count, 1);
  } finally { await connection.end(); }
});

test("PostgreSQL consumes one admitted runtime permission under concurrency and retains its authority", { skip }, async () => {
  requireDedicatedDatabase();
  const setup = await client(); const first = await client(); const second = await client();
  try {
    await resetAndSeed(setup);
    const admitted = await admit(setup);
    const child = admissionRequest(0).child;
    const runtimeClaim = "abababab-abab-4bab-8bab-abababababab";
    const runtimeWorker = "runtime-worker:child-0";
    await setup.query(`UPDATE codeops.session_runtime_outbox
      SET status='claimed',claim_token=$2,claimed_by=$3,claimed_at=$4::timestamptz,
          claim_expires_at=$5::timestamptz,claim_count=1
      WHERE dispatch_id=$1`, [admitted.dispatchId, runtimeClaim, runtimeWorker,
      "2026-08-30T10:05:00.000Z", "2026-08-30T11:00:00.000Z"]);
    const input = { repository: workItems[0].repository, pullRequestNumber: 27,
      expectedHeadSha: sourceSha, expectedBaseSha: "b".repeat(40),
      body: "Apply the exact admitted update." };
    const operationName = "pull_request_update";
    const operationId = `githubmutation-${createHash("sha256").update(canonicalJsonText({
      dispatchId: admitted.dispatchId, claimToken: runtimeClaim,
      operation: operationName, input,
    })).digest("hex")}`;
    const operation = { kind: "github_mutation", repository: input.repository,
      operation: operationName, pullRequestNumber: 27, targetId: null,
      expectedHeadSha: input.expectedHeadSha, payloadJson: canonicalJsonText(input) };
    const permissionRequestId = `permission-${createHash("sha256")
      .update(canonicalJsonText(operation)).update("\0").update(admitted.dispatchId)
      .update("\0").update(operationId).digest("hex")}`;
    const permission = { version: "codeops.session-runtime-permission-submission/v1",
      claimToken: runtimeClaim, request: { requestId: permissionRequestId,
        title: "Allow exact update?", description: "Consume one admitted permission.",
        operation, operationDigest: sha256CanonicalJsonDigest(operation),
        options: [{ optionId: "allow-once", label: "Allow once" },
          { optionId: "deny", label: "Do not allow" }],
        requestedAt: "2026-08-30T10:10:00.000Z" }, acpSessionId: "codeops-github",
      toolCallId: operationId, options: [
        { optionId: "allow-once", acpOptionId: "allow-once" },
        { optionId: "deny", acpOptionId: "deny" }] };
    await submitSessionRuntimePermission(setup, { dispatchId: admitted.dispatchId,
      workerId: runtimeWorker, submission: permission,
      now: () => new Date("2026-08-30T10:10:30.000Z") });
    const decision = await commitGitHubPermissionDecision(
      setup, child.sessionId, permission,
    );
    const request = { version: "codeops.session-runtime-github-mutation-request/v1",
      claimToken: runtimeClaim, operation: operationName, operationId, input };
    const authorization = await authorizeSessionRuntimeGitHubMutation(setup, {
      dispatchId: admitted.dispatchId, workerId: runtimeWorker, request,
      now: () => new Date("2026-08-30T10:13:00.000Z"),
    });
    assert.equal(authorization.disposition, "authorized");
    const recovered = await authorizeSessionRuntimeGitHubMutation(setup, {
      dispatchId: admitted.dispatchId, workerId: runtimeWorker, request,
      now: () => new Date("2026-08-30T10:14:00.000Z"),
    });
    assert.deepEqual(recovered, authorization);
    assert.equal((await setup.query(`SELECT pull_request_number,permission_request_id,
      admission_id,session_generation,session_lease_id,authorization_expires_at
      FROM codeops.provider_effect_receipts WHERE effect_id=$1`, [operationId])).rows[0]
      .pull_request_number, 27);

    const attempts = await Promise.allSettled([first, second].map((connection) =>
      beginSessionRuntimeGitHubMutationAttempt(connection, {
        request: authorization.request,
        now: () => new Date("2026-08-30T10:15:00.000Z"),
      })));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    await assert.rejects(authorizeSessionRuntimeGitHubMutation(setup, {
      dispatchId: admitted.dispatchId, workerId: runtimeWorker, request,
      now: () => new Date("2026-08-30T10:16:00.000Z"),
    }), /outcome is not known/);
    assert.equal((await setup.query(`SELECT state
      FROM codeops.provider_effect_receipts WHERE effect_id=$1`, [operationId]))
      .rows[0].state, "attempting");

    await setup.query(`UPDATE codeops.provider_effect_receipts
      SET attempted_at=now() - interval '60 seconds' WHERE effect_id=$1`,
    [operationId]);
    await assert.rejects(loadUnknownProviderEffectReconciliation(
      setup, operationId, owner,
    ), /not eligible for reconciliation/);
    assert.equal((await setup.query(`SELECT state
      FROM codeops.provider_effect_receipts WHERE effect_id=$1`, [operationId]))
      .rows[0].state, "attempting");

    const completedAt = new Date((await setup.query(
      "SELECT now() + interval '3 minutes' AS completed_at",
    )).rows[0].completed_at);
    const providerResult = {
      version: "codeops.github-pull-request-update-result/v1",
      repository: input.repository, operationId, pullRequestNumber: 27,
      headSha: sourceSha, baseSha: input.expectedBaseSha,
      title: "Admitted update", body: input.body, baseBranch: "main",
      url: "https://github.com/example-org/example-repository/pull/27",
    };
    assert.deepEqual(await completeSessionRuntimeGitHubMutation(setup, {
      request: authorization.request, result: providerResult,
      now: () => completedAt,
    }), providerResult);
    await assert.rejects(beginSessionRuntimeGitHubMutationAttempt(setup, {
      request: authorization.request,
      now: () => new Date("2026-08-30T11:00:00.000Z"),
    }), SessionRuntimeGitHubMutationConflictError);

    await setup.query(`DELETE FROM codeops.session_runtime_permission_requests AS permission
      USING codeops.session_runtime_outbox AS outbox
      WHERE permission.dispatch_id=outbox.dispatch_id AND outbox.session_id=$1
        AND NOT EXISTS (SELECT 1 FROM codeops.provider_effect_receipts AS effect
          WHERE effect.dispatch_id=permission.dispatch_id
            AND effect.permission_request_id=permission.request_id)`, [child.sessionId]);
    assert.equal((await setup.query(`SELECT count(*)::integer count
      FROM codeops.session_runtime_permission_requests WHERE dispatch_id=$1`,
    [admitted.dispatchId])).rows[0].count, 1);

    const duplicateId = "99999999-9999-4999-8999-999999999999";
    const duplicateKey = "98989898-9898-4989-8989-989898989898";
    const duplicateCommand = { ...decision.command, idempotencyKey: duplicateKey };
    const duplicateResult = { ...decision.result, commandId: duplicateId,
      idempotencyKey: duplicateKey };
    await setup.query(`INSERT INTO codeops.session_commands
      (command_id,session_id,idempotency_key,command_json,result_json,principal_id,committed_at)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`, [duplicateId,
      child.sessionId, duplicateKey, canonicalJsonText(duplicateCommand),
      canonicalJsonText(duplicateResult), owner, duplicateResult.committedAt]);
    await assert.rejects(authorizeSessionRuntimeGitHubMutation(setup, {
      dispatchId: admitted.dispatchId, workerId: runtimeWorker, request,
      now: () => new Date("2026-08-30T10:15:00.000Z"),
    }), /one durable permission decision/);

    const revert = await readFile(new URL(
      "../sql/runtime-permission-consumption-v1-revert.sql", import.meta.url), "utf8");
    await assert.rejects(setup.query(revert), /cannot revert runtime permission consumption after authority activation/);
  } finally {
    await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    await Promise.allSettled([first.end(), second.end(), setup.end()]);
  }
});

test("PostgreSQL binds approval owners and payload projections with composite foreign keys", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection); await admit(connection);
    for (const statement of [
      `UPDATE codeops.session_runtime_permission_requests SET session_id='${driftSessionId}'
        WHERE dispatch_id='${parentDispatchId}' AND request_id='approve-plan'`,
      `UPDATE codeops.session_events SET session_id='${driftSessionId}',
        event_json=jsonb_set(event_json,'{sessionId}','"${driftSessionId}"')
        WHERE event_json#>>'{update,kind}'='plan_update'`,
      `UPDATE codeops.session_commands SET principal_id='access:drift@example.com'
        WHERE command_json->>'type'='respond_permission'`,
    ]) {
      await connection.query("BEGIN");
      await assert.rejects(connection.query(statement), (error) => error.code === "23503");
      await connection.query("ROLLBACK");
    }
    await connection.query("BEGIN");
    await connection.query("ALTER TABLE codeops.project_plan_approvals DISABLE TRIGGER project_plan_approvals_immutable");
    await assert.rejects(connection.query(`UPDATE codeops.project_plan_approvals SET authority_json=
      jsonb_set(authority_json,'{permissionRequest,request,requestId}','"drift"')`),
      (error) => error.code === "23514");
    await connection.query("ROLLBACK");
    await connection.query("BEGIN");
    await connection.query("ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable");
    await assert.rejects(connection.query(`UPDATE codeops.work_item_admissions SET authority_json=
      jsonb_set(authority_json,'{request,workItem,provider,projectId}','"abababab-abab-4bab-8bab-abababababab"')`),
      (error) => error.code === "23514");
    await connection.query("ROLLBACK");

    const driftBody = { sessionId: driftSessionId, generation: 1, cursor: 1, type: "acp_update",
      update: { kind: "usage", usedTokens: 1, contextWindowTokens: 10 }, occurredAt: admittedAt };
    const driftEvent = { version: "codeops.session-event/v1", eventId: digest(driftBody), ...driftBody };
    await connection.query(`INSERT INTO codeops.session_events
      (event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,1,1,'acp_update',$3::jsonb,NULL,$4::timestamptz)`,
      [driftEvent.eventId, driftSessionId, canonicalJsonText(driftEvent), admittedAt]);
    await connection.query(`INSERT INTO codeops.work_item_lifecycle(repository,provider,workspace_id,project_id,
      work_item_id,workflow_id,run_id,phase,attention,sequence,source_sha,updated_at)
      VALUES($1,'plane',$2,$3,$4,'unrelated-workflow','unrelated-run','in_progress','clear',1,$5,$6::timestamptz)`,
      [workItems[1].repository, workItems[1].provider.workspaceId, workItems[1].provider.projectId,
        workItems[1].workItemId, sourceSha, admittedAt]);

    async function rejectsForeignKey(constraint, statements, materializationConstraint) {
      await connection.query("BEGIN");
      try {
        for (const statement of statements.slice(0, -1)) await connection.query(statement);
        if (materializationConstraint !== undefined) {
          await connection.query("SAVEPOINT materialization_guard_proof");
          await assert.rejects(connection.query(statements.at(-1)),
            (error) => error.code === "23503" && error.constraint === materializationConstraint);
          await connection.query("ROLLBACK TO SAVEPOINT materialization_guard_proof");
          await connection.query(`ALTER TABLE codeops.admitted_child_materializations
            DISABLE TRIGGER admitted_child_materializations_guard`);
          await connection.query("DELETE FROM codeops.admitted_child_materializations");
        }
        await assert.rejects(connection.query(statements.at(-1)),
          (error) => error.code === "23503" && error.constraint === constraint);
      } finally { await connection.query("ROLLBACK"); }
    }

    await rejectsForeignKey("work_item_admissions_approval_parent_fk", [
      "ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable",
      `UPDATE codeops.work_item_admissions SET parent_session_id='${driftSessionId}',
        supervision_event_id='${driftEvent.eventId}', authority_json=jsonb_set(jsonb_set(jsonb_set(
          authority_json,'{parentSessionId}','"${driftSessionId}"'),
          '{supervisionEventId}','"${driftEvent.eventId}"'),'{supervisionEvent}',
          '${canonicalJsonText(driftEvent)}'::jsonb)`,
    ], "admitted_child_materializations_admission_fk");
    await rejectsForeignKey("work_item_admissions_child_event_fk", [
      "ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable",
      `UPDATE codeops.work_item_admissions SET child_event_id='${driftEvent.eventId}',
        authority_json=jsonb_set(jsonb_set(authority_json,'{childEventId}','"${driftEvent.eventId}"'),
          '{childEvent}','${canonicalJsonText(driftEvent)}'::jsonb)`,
    ]);
    const childEvent = (await connection.query(`SELECT event_json FROM codeops.session_events
      WHERE session_id=$1 AND event_type='session_created'`, [admissionRequest(0).child.sessionId])).rows[0].event_json;
    await rejectsForeignKey("work_item_admissions_supervision_event_fk", [
      "ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable",
      `UPDATE codeops.work_item_admissions SET supervision_event_id='${childEvent.eventId}',
        authority_json=jsonb_set(jsonb_set(authority_json,'{supervisionEventId}','"${childEvent.eventId}"'),
          '{supervisionEvent}','${canonicalJsonText(childEvent)}'::jsonb)`,
    ]);
    await rejectsForeignKey("work_item_admissions_lifecycle_event_fk", [
      "ALTER TABLE codeops.work_item_lifecycle_events DISABLE TRIGGER work_item_lifecycle_events_immutable",
      `UPDATE codeops.work_item_lifecycle_events SET work_item_id='${workItems[1].workItemId}',
        event_json=jsonb_set(event_json,'{workItemId}','"${workItems[1].workItemId}"')
        WHERE work_item_id='${workItems[0].workItemId}'`,
    ]);
    await rejectsForeignKey("session_runtime_outbox_admission_child_fk", [
      `UPDATE codeops.session_runtime_outbox SET session_id='${driftSessionId}',
        dispatch_json=jsonb_set(dispatch_json,'{command,sessionId}','"${driftSessionId}"')
        WHERE admission_id IS NOT NULL`,
    ]);
  } finally { await connection.end(); }
});

test("PostgreSQL replay survives parent, budget, lifecycle, and publication progress and rejects drift", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection); const request = admissionRequest(0); const created = await admit(connection, request);
    const substituted = admissionRequest(1);
    substituted.workItem = { ...substituted.workItem, provider: { ...substituted.workItem.provider,
      projectId: "abababab-abab-4bab-8bab-abababababab" } };
    await assert.rejects(admit(connection, substituted, "2026-08-30T10:01:00.000Z"), /exact work item identity/);

    const progressBody = { sessionId: parentSessionId, generation: 1, cursor: 7, type: "acp_update",
      update: { kind: "usage", usedTokens: 10, contextWindowTokens: 100 }, occurredAt: "2026-08-30T10:05:00.000Z" };
    const progress = { version: "codeops.session-event/v1", eventId: digest(progressBody), ...progressBody };
    const current = { ...parentSnapshot(7, 4), updatedAt: progress.occurredAt };
    await connection.query("BEGIN");
    await connection.query("UPDATE codeops.sessions SET snapshot_json=$2::jsonb,updated_at=$3::timestamptz WHERE session_id=$1",
      [parentSessionId, canonicalJsonText(current), progress.occurredAt]);
    await connection.query(`INSERT INTO codeops.session_events(event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,1,7,'acp_update',$3::jsonb,NULL,$4::timestamptz)`,
      [progress.eventId, parentSessionId, canonicalJsonText(progress), progress.occurredAt]);
    await connection.query("COMMIT");

    await connection.query(`SELECT * FROM codeops.reserve_session_model_budget(
      $1::uuid,$2,$3,$4,1,'openai','gpt-5.6-sol','high',100,40)`,
      ["abababab-abab-4bab-8bab-abababababab", `sha256:${"e".repeat(64)}`,
        request.child.sessionId, request.child.sessionId]);
    const transitionKey = `progress:${request.admissionId}`;
    const transitionId = createTransitionId({ workflowId: request.workItem.workflowId, transitionKey,
      version: "codeops.work-item-lifecycle-event/v1" });
    const lifecycleProgress = { version: "codeops.work-item-lifecycle-event/v1",
      eventId: createEventId({ workflowId: request.workItem.workflowId, transitionId,
        version: "codeops.work-item-lifecycle-event/v1" }), transitionId, transitionKey, command: "request_review",
      repository: { owner: "example-org", name: "example-repository" }, provider: request.workItem.provider,
      workItemId: request.workItem.workItemId, workflowId: request.workItem.workflowId, runId: request.workItem.runId,
      sequence: 2, previousState: { phase: "in_progress", attention: "clear" },
      state: { phase: "in_review", attention: "clear" }, sourceSha: request.workItem.sourceSha,
      occurredAt: "2026-08-30T10:07:00.000Z", summary: "Normal lifecycle progress", evidence: [] };
    assert.equal(await appendWorkItemLifecycleEvent(connection, lifecycleProgress), "appended");
    const publication = await claimWorkItemLifecyclePublication(connection, {
      claimedBy: "lifecycle-relay:test", now: "2026-08-30T10:08:00.000Z", leaseMs: 60_000 });
    assert.equal(publication.event.eventId, created.lifecycleEventId);
    assert.equal(await acknowledgeWorkItemLifecyclePublication(connection, {
      eventId: created.lifecycleEventId, claimToken: publication.claimToken,
      receipt: { driver: "jetstream", destination: "codeops.lifecycle", position: "1", metadata: {} },
      publishedAt: "2026-08-30T10:08:10.000Z",
    }), "published");
    assert.equal((await admit(connection, request, "2026-08-30T10:09:00.000Z")).disposition, "replayed");

    const storedMaterialization = (await connection.query(`SELECT input_json FROM
      codeops.admitted_child_materializations WHERE admission_id=$1`, [created.admissionId])).rows[0].input_json;
    const driftedMaterialization = { ...storedMaterialization, release: "v0.5.0-alpha.59" };
    await connection.query("ALTER TABLE codeops.admitted_child_materializations DISABLE TRIGGER admitted_child_materializations_guard");
    await connection.query(`UPDATE codeops.admitted_child_materializations SET input_digest=$2,input_json=$3::jsonb,
      state_json=jsonb_set(state_json,'{inputDigest}',to_jsonb($2::text)) WHERE admission_id=$1`,
    [created.admissionId, sha256CanonicalJsonDigest(driftedMaterialization), canonicalJsonText(driftedMaterialization)]);
    await connection.query("ALTER TABLE codeops.admitted_child_materializations ENABLE TRIGGER admitted_child_materializations_guard");
    await assert.rejects(admit(connection, request, "2026-08-30T10:09:10.000Z"), /release identity drifted/);
    await connection.query("ALTER TABLE codeops.admitted_child_materializations DISABLE TRIGGER admitted_child_materializations_guard");
    await connection.query(`UPDATE codeops.admitted_child_materializations SET input_digest=$2,input_json=$3::jsonb,
      state_json=jsonb_set(state_json,'{inputDigest}',to_jsonb($2::text)) WHERE admission_id=$1`,
    [created.admissionId, sha256CanonicalJsonDigest(storedMaterialization), canonicalJsonText(storedMaterialization)]);
    await connection.query("ALTER TABLE codeops.admitted_child_materializations ENABLE TRIGGER admitted_child_materializations_guard");

    const permissionPayload = (await connection.query(`SELECT request_json FROM codeops.session_runtime_permission_requests
      WHERE dispatch_id=$1 AND request_id='approve-plan'`, [parentDispatchId])).rows[0].request_json;
    await connection.query(`UPDATE codeops.session_runtime_permission_requests SET request_json=
      jsonb_set(request_json,'{request,description}','"drift"') WHERE dispatch_id=$1 AND request_id='approve-plan'`,
      [parentDispatchId]);
    await assert.rejects(admit(connection, request, "2026-08-30T10:06:10.000Z"), /permission payload drifted/);
    await connection.query(`UPDATE codeops.session_runtime_permission_requests SET request_json=$2::jsonb
      WHERE dispatch_id=$1 AND request_id='approve-plan'`, [parentDispatchId, canonicalJsonText(permissionPayload)]);

    const planPayload = (await connection.query(`SELECT event_json FROM codeops.session_events
      WHERE event_json#>>'{update,kind}'='plan_update'`)).rows[0].event_json;
    await connection.query(`UPDATE codeops.session_events SET event_json=
      jsonb_set(event_json,'{update,content,entries,0,content}','"drift"')
      WHERE event_json#>>'{update,kind}'='plan_update'`);
    await assert.rejects(admit(connection, request, "2026-08-30T10:06:20.000Z"), /plan event payload drifted/);
    await connection.query(`UPDATE codeops.session_events SET event_json=$1::jsonb
      WHERE event_id=$2`, [canonicalJsonText(planPayload), planPayload.eventId]);

    const decisionPayload = (await connection.query(`SELECT command_json FROM codeops.session_commands
      WHERE command_json->>'type'='respond_permission'`)).rows[0].command_json;
    await connection.query(`UPDATE codeops.session_commands SET command_json=
      jsonb_set(command_json,'{decision,optionId}','"drift"') WHERE command_json->>'type'='respond_permission'`);
    await assert.rejects(admit(connection, request, "2026-08-30T10:06:30.000Z"), /decision command payload drifted/);
    await connection.query(`UPDATE codeops.session_commands SET command_json=$1::jsonb
      WHERE command_id=$2`, [canonicalJsonText(decisionPayload),
      "13131313-1313-4131-8131-131313131313"]);

    await connection.query("ALTER TABLE codeops.sessions DISABLE TRIGGER sessions_owner_immutable");
    await connection.query("UPDATE codeops.sessions SET owner_principal_id='access:drift@example.com' WHERE session_id=$1",
      [parentSessionId]);
    await connection.query("ALTER TABLE codeops.sessions ENABLE TRIGGER sessions_owner_immutable");
    await assert.rejects(admit(connection, request, "2026-08-30T10:06:40.000Z"), /durable linkage drifted/);
    await connection.query("ALTER TABLE codeops.sessions DISABLE TRIGGER sessions_owner_immutable");
    await connection.query("UPDATE codeops.sessions SET owner_principal_id=$2 WHERE session_id=$1", [parentSessionId, owner]);
    await connection.query("ALTER TABLE codeops.sessions ENABLE TRIGGER sessions_owner_immutable");

    const originalParentDispatch = (await connection.query("SELECT dispatch_json FROM codeops.session_runtime_outbox WHERE dispatch_id=$1",
      [parentDispatchId])).rows[0].dispatch_json;
    await connection.query("BEGIN");
    await connection.query("UPDATE codeops.session_runtime_outbox SET dispatch_json=jsonb_set(dispatch_json,'{command,prompt}','\"drift\"') WHERE dispatch_id=$1", [parentDispatchId]);
    await connection.query("COMMIT");
    await assert.rejects(admit(connection, request, "2026-08-30T10:07:00.000Z"), /parent dispatch payload drifted/);
    await connection.query("BEGIN");
    await connection.query("UPDATE codeops.session_runtime_outbox SET dispatch_json=$2::jsonb WHERE dispatch_id=$1",
      [parentDispatchId, canonicalJsonText(originalParentDispatch)]); await connection.query("COMMIT");

    const lifecycle = (await connection.query("SELECT event_json FROM codeops.work_item_lifecycle_events WHERE event_id=$1",
      [created.lifecycleEventId])).rows[0].event_json;
    await connection.query("ALTER TABLE codeops.work_item_lifecycle_events DISABLE TRIGGER work_item_lifecycle_events_immutable");
    await connection.query("UPDATE codeops.work_item_lifecycle_events SET event_json=jsonb_set(event_json,'{summary}','\"drift\"') WHERE event_id=$1",
      [created.lifecycleEventId]);
    await connection.query("ALTER TABLE codeops.work_item_lifecycle_events ENABLE TRIGGER work_item_lifecycle_events_immutable");
    await assert.rejects(admit(connection, request, "2026-08-30T10:08:00.000Z"), /lifecycle event payload drifted/);
    await connection.query("ALTER TABLE codeops.work_item_lifecycle_events DISABLE TRIGGER work_item_lifecycle_events_immutable");
    await connection.query("UPDATE codeops.work_item_lifecycle_events SET event_json=$2::jsonb WHERE event_id=$1",
      [created.lifecycleEventId, canonicalJsonText(lifecycle)]);
    await connection.query("ALTER TABLE codeops.work_item_lifecycle_events ENABLE TRIGGER work_item_lifecycle_events_immutable");

    await connection.query("ALTER TABLE codeops.sessions DISABLE TRIGGER sessions_owner_immutable");
    await connection.query("UPDATE codeops.sessions SET owner_principal_id='access:drift@example.com' WHERE session_id=$1", [request.child.sessionId]);
    await connection.query("ALTER TABLE codeops.sessions ENABLE TRIGGER sessions_owner_immutable");
    await assert.rejects(admit(connection, request, "2026-08-30T10:09:00.000Z"), /durable linkage drifted/);
    await connection.query("ALTER TABLE codeops.sessions DISABLE TRIGGER sessions_owner_immutable");
    await connection.query("UPDATE codeops.sessions SET owner_principal_id=$2 WHERE session_id=$1", [request.child.sessionId, owner]);
    await connection.query("ALTER TABLE codeops.sessions ENABLE TRIGGER sessions_owner_immutable");

    await connection.query("DELETE FROM codeops.work_item_lifecycle_publications WHERE event_id=$1", [created.lifecycleEventId]);
    await assert.rejects(admit(connection, request, "2026-08-30T10:10:00.000Z"), /durable owner is missing/);
    const materializationRevert = await readFile(new URL(
      "../sql/admitted-child-materializations-v1-revert.sql", import.meta.url), "utf8");
    await assert.rejects(connection.query(materializationRevert),
      /cannot revert admitted child materializations with durable rows/);
    await connection.query("ROLLBACK");
    await connection.query("ALTER TABLE codeops.admitted_child_materializations DISABLE TRIGGER admitted_child_materializations_guard");
    await connection.query("DELETE FROM codeops.admitted_child_materializations");
    await connection.query(materializationRevert);
    const consumptionRevert = await readFile(new URL(
      "../sql/runtime-permission-consumption-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(consumptionRevert);
    const revert = await readFile(new URL("../sql/work-item-admission-v1-revert.sql", import.meta.url), "utf8");
    await assert.rejects(connection.query(revert), /cannot revert work-item admission while admitted work exists/);
    await connection.query("ROLLBACK");
    assert.notEqual((await connection.query("SELECT to_regclass('codeops.work_item_admissions') relation")).rows[0].relation, null);
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.schema_migrations WHERE migration_name='work-item-admission-v1'"))
      .rows[0].count, 1);

    await resetAndSeed(connection); await admit(connection, request);
    await connection.query("ALTER TABLE codeops.admitted_child_materializations DISABLE TRIGGER admitted_child_materializations_guard");
    await connection.query("DELETE FROM codeops.admitted_child_materializations");
    const secondMaterializationRevert = await readFile(new URL(
      "../sql/admitted-child-materializations-v1-revert.sql", import.meta.url), "utf8");
    await connection.query(secondMaterializationRevert);
    await connection.query("BEGIN");
    await connection.query("ALTER TABLE codeops.work_item_admissions DISABLE TRIGGER work_item_admissions_immutable");
    await connection.query("UPDATE codeops.session_runtime_outbox SET admission_id=NULL WHERE admission_id IS NOT NULL");
    await connection.query("DELETE FROM codeops.work_item_admissions"); await connection.query("COMMIT");
    await assert.rejects(connection.query(revert), /cannot revert work-item admission while project-plan approval authority exists/);
    await connection.query("ROLLBACK");
    assert.equal((await connection.query("SELECT count(*)::integer count FROM codeops.schema_migrations WHERE migration_name='work-item-admission-v1'"))
      .rows[0].count, 1);
  } finally { await connection.end(); }
});

test("PostgreSQL preserves serialized concurrency failure and returns duplicate HTTP 409", { skip }, async () => {
  requireDedicatedDatabase();
  const setup = await client(); const first = await client(); const second = await client();
  try {
    await resetAndSeed(setup, 1);
    const outcomes = await Promise.allSettled([admit(first, admissionRequest(0)), admit(second, admissionRequest(1))]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "40001" &&
      !(outcome.reason instanceof WorkItemAdmissionConflictError)).length, 1);

    await resetAndSeed(setup, 4); await admit(setup, admissionRequest(0));
    const duplicate = { ...admissionRequest(0), admissionId: admissionRequest(1).admissionId,
      child: admissionRequest(1).child };
    const result = await serveSessionRuntime({ method: "POST",
      url: `/v1/session-runtime/dispatches/${parentDispatchId}/work-item-admissions`,
      headers: { authorization: "Bearer runtime-token", "content-type": "application/json" }, token: "runtime-token",
      workerId, readBody: async () => duplicate, claim: async () => null, complete: async () => ({}),
      submitPermission: async () => ({}), pollPermission: async () => ({}),
      admitWorkItem: async (input) => admitSessionRuntimeWorkItem(second, {
        ...input, materialization, now: () => new Date(admittedAt),
      }),
    });
    assert.deepEqual(result, { status: 409, body: { status: "conflict" } });
  } finally { await Promise.allSettled([first.end(), second.end(), setup.end()]); }
});
