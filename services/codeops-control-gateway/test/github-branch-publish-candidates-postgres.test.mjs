import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { Client } from "pg";
import {
  canonicalJsonText,
  DEFAULT_SESSION_BUDGET_V2_LIMITS,
  projectSessionBudgetV2,
  sha256CanonicalJsonDigest,
} from "@codeops/codeops-contracts";
import {
  cleanupDefinitiveGitHubBranchCandidateChunks,
  cleanupNoReceiptGitHubBranchCandidatesForDispatch,
  cleanupTerminalOrphanGitHubBranchCandidateChunks,
  createGitHubBranchCandidateManifest,
  loadGitHubBranchCandidate,
  storeGitHubBranchCandidateChunk,
} from "../dist/github-branch-publish-candidates.js";
import { migrateSessionBroker } from "../dist/session-broker-migration.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";

const databaseUrl = process.env.CODEOPS_TEST_POSTGRES_URL?.trim();
const skip = databaseUrl === undefined
  ? "CODEOPS_TEST_POSTGRES_URL is not configured"
  : false;

function requireDedicatedDatabase() {
  const database = new URL(databaseUrl).pathname.slice(1);
  if (!/^codeops[_-].*test$/i.test(database)) {
    throw new Error(
      "CODEOPS_TEST_POSTGRES_URL must name a dedicated codeops *test database",
    );
  }
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

const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const idempotencyKey = "44444444-4444-4444-8444-444444444444";
const sessionId = "session-candidate-postgres";
const owner = "access:owner@example.com";
const workerId = "runtime-worker:candidate-proof";
const repository = "example-org/example-repository";
const sourceSha = "a".repeat(40);
const seededAt = "2026-08-30T10:00:00.000Z";

function snapshot() {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId,
    generation: 1,
    state: "running",
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: {
        version: "codeops.session-policy/v1",
        mode: "implement",
        workspaceAccess: "bounded-writes",
        modelCalls: "allowed",
        modelPolicy: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      },
      contextAttachments: [],
      workspace: {
        version: "codeops.workspace/v1",
        sources: [{
          catalogKey: "repository",
          repository,
          checkoutPath: "sources/repository",
          requestedRef: "main",
          resolvedSha: sourceSha,
        }],
        scratchPath: "scratch",
      },
      workflowId: "candidate-workflow",
      runId: "candidate-run",
      displayName: "Candidate proof",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "workspace-runtime",
      acquiredAt: "2026-08-30T09:00:00.000Z",
      expiresAt: "2026-08-30T12:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    budget: projectSessionBudgetV2({
      budgetId: sessionId,
      revision: 1,
      startedAt: "2026-08-30T09:00:00.000Z",
      observedAt: "2026-08-30T09:00:00.000Z",
      limits: DEFAULT_SESSION_BUDGET_V2_LIMITS,
    }),
    eventCursor: 0,
    capabilities: sessionCapabilitiesFor("running", false),
    updatedAt: seededAt,
  };
}

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: owner,
    command: {
      version: "codeops.session-command/v1",
      sessionId,
      generation: 1,
      leaseId,
      idempotencyKey,
      type: "prompt",
      prompt: "Publish the exact reviewed candidate.",
    },
    snapshot: snapshot(),
    dispatchedAt: seededAt,
  };
}

async function resetAndSeed(connection, status = "claimed") {
  await connection.query("DROP SCHEMA IF EXISTS codeops CASCADE");
  await migrateSessionBroker(connection);
  const claimed = status === "claimed";
  await connection.query(
    `INSERT INTO codeops.sessions(
       session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
     VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`,
    [sessionId, leaseId, canonicalJsonText(snapshot()), seededAt, owner],
  );
  await connection.query(
    `INSERT INTO codeops.session_runtime_outbox(
       dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
       available_at,created_at,claim_token,claimed_by,claimed_at,
       claim_expires_at,claim_count)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$7::timestamptz,
       $8,$9,$10::timestamptz,$11::timestamptz,$12)`,
    [dispatchId, sessionId, idempotencyKey, owner,
      canonicalJsonText(dispatch()), status, seededAt,
      claimed ? claimToken : null,
      claimed ? workerId : null,
      claimed ? "2026-08-30T10:01:00.000Z" : null,
      claimed ? "2026-08-30T11:00:00.000Z" : null,
      claimed ? 1 : 0],
  );
}

async function seedAdmittedAuthority(connection) {
  const parentSessionId = "session-candidate-authority-parent";
  const parentDispatchId = "abababab-abab-4bab-8bab-abababababab";
  const parentDispatchKey = "acacacac-acac-4cac-8cac-acacacacacac";
  const admissionId = "77777777-7777-4777-8777-777777777777";
  const approvalId = "66666666-6666-4666-8666-666666666666";
  const decisionCommandId = "55555555-5555-4555-8555-555555555555";
  const decisionKey = "56565656-5656-4565-8565-565656565656";
  const planEventId = `sha256:${"1".repeat(64)}`;
  const childEventId = `sha256:${"2".repeat(64)}`;
  const supervisionEventId = `sha256:${"3".repeat(64)}`;
  const lifecycleEventId = "candidate-lifecycle-event";
  const permissionRequestId = "candidate-plan-permission";
  const planDigest = `sha256:${"4".repeat(64)}`;
  const workspaceId = "88888888-8888-4888-8888-888888888888";
  const projectId = "99999999-9999-4999-8999-999999999999";
  const workItemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const workflowId = snapshot().identity.workflowId;
  const runId = snapshot().identity.runId;
  const parentSnapshot = { ...snapshot(), sessionId: parentSessionId };
  const parentDispatch = { ...dispatch(), dispatchId: parentDispatchId,
    command: { ...dispatch().command, sessionId: parentSessionId,
      idempotencyKey: parentDispatchKey }, snapshot: parentSnapshot };
  await connection.query(`INSERT INTO codeops.sessions(
    session_id,generation,lease_id,snapshot_json,updated_at,owner_principal_id)
    VALUES($1,1,$2,$3::jsonb,$4::timestamptz,$5)`,
  [parentSessionId, leaseId, canonicalJsonText(parentSnapshot), seededAt, owner]);
  await connection.query(`INSERT INTO codeops.session_runtime_outbox(
    dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
    available_at,created_at,claim_token,claimed_by,claimed_at,claim_expires_at,claim_count)
    VALUES($1,$2,$3,$4,$5::jsonb,'claimed',$6::timestamptz,$6::timestamptz,
      $7,$8,$9::timestamptz,$10::timestamptz,1)`,
  [parentDispatchId, parentSessionId, parentDispatchKey, owner,
    canonicalJsonText(parentDispatch), seededAt, claimToken, workerId,
    "2026-08-30T10:01:00.000Z", "2026-08-30T11:00:00.000Z"]);
  const command = { version: "codeops.session-command/v1", sessionId: parentSessionId,
    generation: 1, leaseId, idempotencyKey: decisionKey, type: "respond_permission",
    permissionRequestId, decision: { outcome: "selected", optionId: "allow-once" } };
  const result = { version: "codeops.session-command-result/v1", commandId: decisionCommandId,
    sessionId: parentSessionId, generation: 1, leaseId, idempotencyKey: decisionKey,
    type: "respond_permission", disposition: "committed", eventCursor: 2,
    snapshot: { sessionId: parentSessionId, generation: 1, lease: { leaseId }, eventCursor: 2 },
    committedAt: seededAt };
  await connection.query(`INSERT INTO codeops.session_commands(
    command_id,session_id,idempotency_key,command_json,result_json,principal_id,committed_at)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)`,
  [decisionCommandId, parentSessionId, decisionKey, canonicalJsonText(command),
    canonicalJsonText(result), owner, seededAt]);
  const events = [
    { eventId: planEventId, sessionId: parentSessionId, cursor: 1, type: "acp_update",
      update: { kind: "plan_update", planId: "candidate-plan" } },
    { eventId: childEventId, sessionId, cursor: 1, type: "session_created" },
    { eventId: supervisionEventId, sessionId: parentSessionId, cursor: 2, type: "acp_update" },
  ];
  for (const event of events) {
    const eventJson = { version: "codeops.session-event/v1", eventId: event.eventId,
      sessionId: event.sessionId, generation: 1, cursor: event.cursor, type: event.type,
      ...(event.update === undefined ? {} : { update: event.update }), occurredAt: seededAt };
    await connection.query(`INSERT INTO codeops.session_events(
      event_id,session_id,generation,cursor,event_type,event_json,command_id,occurred_at)
      VALUES($1,$2,1,$3,$4,$5::jsonb,$6,$7::timestamptz)`,
    [event.eventId, event.sessionId, event.cursor, event.type, canonicalJsonText(eventJson),
      decisionCommandId, seededAt]);
  }
  const planOperation = { kind: "project_plan", planId: "candidate-plan", planDigest, workItems: [] };
  const permissionRequest = { version: "codeops.session-runtime-permission-submission/v1", claimToken,
    request: { requestId: permissionRequestId, operation: planOperation, requestedAt: seededAt },
    acpSessionId: "candidate-acp", toolCallId: "candidate-plan-call", options: [] };
  await connection.query(`INSERT INTO codeops.session_runtime_permission_requests(
    dispatch_id,request_id,session_id,request_json,created_at)
    VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)`,
  [parentDispatchId, permissionRequestId, parentSessionId,
    canonicalJsonText(permissionRequest), seededAt]);
  const approval = { version: "codeops.project-plan-approval-authority/v1", approvalId,
    parentSessionId, dispatchId: parentDispatchId, permissionRequestId, planEventId,
    planId: "candidate-plan", planDigest, decisionCommandId, approvedByPrincipalId: owner,
    workItems: [], parentDispatch: { dispatchId: parentDispatchId, principalId: owner,
      command: { sessionId: parentSessionId } },
    permissionRequest: { request: { requestId: permissionRequestId, operation: planOperation } },
    planEvent: { eventId: planEventId, sessionId: parentSessionId,
      update: { kind: "plan_update", planId: "candidate-plan" } },
    decisionCommand: command, decisionResult: result, approvedAt: seededAt };
  const approvalDigest = sha256CanonicalJsonDigest(approval);
  await connection.query(`INSERT INTO codeops.project_plan_approvals(
    approval_id,parent_session_id,dispatch_id,permission_request_id,plan_event_id,plan_id,
    plan_digest,decision_command_id,approved_by_principal_id,authority_digest,authority_json,approved_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
  [approvalId, parentSessionId, parentDispatchId, permissionRequestId, planEventId, "candidate-plan",
    planDigest, decisionCommandId, owner, approvalDigest,
    canonicalJsonText(approval), seededAt]);
  const lifecycleEvent = { version: "codeops.work-item-lifecycle-event/v1", eventId: lifecycleEventId,
    transitionId: "candidate-lifecycle-transition", transitionKey: "candidate:admitted",
    repository: { owner: "example-org", name: "example-repository" },
    provider: { kind: "plane", workspaceId, projectId }, workItemId, workflowId, runId,
    sequence: 1, sourceSha, occurredAt: seededAt };
  await connection.query(`INSERT INTO codeops.work_item_lifecycle(
    repository,provider,workspace_id,project_id,work_item_id,workflow_id,run_id,phase,
    attention,sequence,source_sha,updated_at)
    VALUES($1,'plane',$2,$3,$4,$5,$6,'in_progress','clear',1,$7,$8::timestamptz)`,
  [repository, workspaceId, projectId, workItemId, workflowId, runId, sourceSha, seededAt]);
  await connection.query(`INSERT INTO codeops.work_item_lifecycle_events(
    event_id,transition_id,transition_key,repository,provider,workspace_id,project_id,
    work_item_id,workflow_id,run_id,source_sha,sequence,event_digest,event_json,created_at)
    VALUES($1,$2,$3,$4,'plane',$5,$6,$7,$8,$9,$10,1,$11,$12::jsonb,$13::timestamptz)`,
  [lifecycleEventId, lifecycleEvent.transitionId, lifecycleEvent.transitionKey, repository,
    workspaceId, projectId, workItemId, workflowId, runId, sourceSha, "5".repeat(64),
    canonicalJsonText(lifecycleEvent), seededAt]);
  const workItem = { repository, provider: { kind: "plane", workspaceId, projectId },
    workItemId, workflowId, runId, sourceSha };
  const admission = { version: "codeops.work-item-admission-authority/v1", admissionId,
    approvalId, parentSessionId, childSessionId: sessionId, dispatchId,
    childEventId, repository, provider: workItem.provider, workItemId, workflowId, runId,
    sourceSha, lifecycleEventId, supervisionEventId,
    request: { admissionId, workItem, child: { sessionId, dispatchId } },
    childSnapshot: { sessionId }, childEvent: { eventId: childEventId },
    dispatch: { dispatchId }, lifecycleEvent: { eventId: lifecycleEventId },
    supervisionEvent: { eventId: supervisionEventId }, admittedAt: seededAt };
  const admissionDigest = sha256CanonicalJsonDigest(admission);
  await connection.query("BEGIN");
  await connection.query(`INSERT INTO codeops.work_item_admissions(
    admission_id,approval_id,parent_session_id,child_session_id,child_dispatch_id,child_event_id,
    repository,provider,workspace_id,project_id,work_item_id,workflow_id,run_id,source_sha,
    lifecycle_event_id,supervision_event_id,authority_digest,authority_json,admitted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'plane',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::timestamptz)`,
  [admissionId, approvalId, parentSessionId, sessionId, dispatchId, childEventId, repository,
    workspaceId, projectId, workItemId, workflowId, runId, sourceSha, lifecycleEventId,
    supervisionEventId, admissionDigest, canonicalJsonText(admission), seededAt]);
  const materializationInput = {
    version: "codeops.admitted-child-materialization-input/v1",
    admissionId, admissionDigest, approvalId, approvalDigest, parentSessionId,
    childSessionId: sessionId, childDispatchId: dispatchId, principalId: owner,
    workItem, source: snapshot().identity.workspace.sources[0],
    policy: snapshot().identity.policy, profile: "custom", release: "fixture",
    images: {
      agent: `registry.example/agent@sha256:${"a".repeat(64)}`,
      runtimeWorker: `registry.example/worker@sha256:${"b".repeat(64)}`,
    },
    contextAttachments: [], generation: 1, lease: {
      leaseId, holderId: snapshot().lease.holderId,
      acquiredAt: snapshot().lease.acquiredAt, expiresAt: snapshot().lease.expiresAt,
    },
    workflowId, runId, initialDispatch: dispatch(), identity: snapshot().identity,
    admittedAt: seededAt,
  };
  const inputDigest = sha256CanonicalJsonDigest(materializationInput);
  const initialDispatchDigest = sha256CanonicalJsonDigest(materializationInput.initialDispatch);
  const materializationState = {
    version: "codeops.admitted-child-materialization-state/v1",
    admissionId, inputDigest, state: "queued", resources: {}, attemptCount: 0,
    createdAt: seededAt, updatedAt: seededAt,
  };
  await connection.query(`INSERT INTO codeops.admitted_child_materializations(
    admission_id,admission_digest,approval_id,approval_digest,parent_session_id,
    child_session_id,child_dispatch_id,initial_dispatch_digest,principal_id,repository,provider,workspace_id,
    project_id,work_item_id,workflow_id,run_id,source_sha,generation,lease_id,
    input_digest,input_json,state,state_json,attempt_count,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'plane',$11,$12,$13,$14,$15,$16,1,$17,
      $18,$19::jsonb,'queued',$20::jsonb,0,$21::timestamptz,$21::timestamptz)`,
  [admissionId, admissionDigest, approvalId, approvalDigest, parentSessionId, sessionId,
    dispatchId, initialDispatchDigest, owner, repository, workspaceId, projectId, workItemId, workflowId, runId,
    sourceSha, leaseId, inputDigest, canonicalJsonText(materializationInput),
    canonicalJsonText(materializationState), seededAt]);
  const initialDispatch = await connection.query(`UPDATE codeops.session_runtime_outbox
    SET admission_id=$2,dispatch_digest=$3,is_admitted_initial_dispatch=true
    WHERE dispatch_id=$1 RETURNING is_admitted_initial_dispatch`,
    [dispatchId, admissionId, initialDispatchDigest]);
  assert.equal(initialDispatch.rows[0]?.is_admitted_initial_dispatch, true);
  await connection.query("COMMIT");
  return admissionId;
}

async function seedGitHubPermissionAuthorities(connection, operations) {
  const admissionId = await seedAdmittedAuthority(connection);
  for (const [index, operation] of operations.entries()) {
    const requestId = `candidate-github-${String(index).padStart(3, "0")}`;
    const requestJson = { version: "codeops.session-runtime-permission-submission/v1", claimToken,
      request: { requestId, operation: { kind: "github_mutation", repository,
        operation: "branch_publish", targetId: operation.targetId, expectedHeadSha: sourceSha },
        operationDigest: operation.permissionDigest, requestedAt: seededAt },
      acpSessionId: "candidate-acp", toolCallId: operation.operationId, options: [] };
    await connection.query(`INSERT INTO codeops.session_runtime_permission_requests(
      dispatch_id,request_id,session_id,request_json,created_at,admission_id,
      session_generation,session_lease_id,operation_provider,operation_id)
      VALUES($1,$2,$3,$4::jsonb,$5::timestamptz,$6,1,$7,'github',$8)`,
    [dispatchId, requestId, sessionId, canonicalJsonText(requestJson), seededAt,
      admissionId, leaseId, operation.operationId]);
    operation.permissionRequestId = requestId;
    operation.admissionId = admissionId;
  }
}

function candidateFixture(changes = [
  { path: "proof.txt", oldText: "before\n", newText: "after\n" },
]) {
  const candidate = {
    version: "codeops.github-branch-publish-candidate/v1",
    changes,
  };
  const bytes = Buffer.from(canonicalJsonText(candidate));
  const chunks = Array.from(
    { length: Math.ceil(bytes.length / 65_536) },
    (_, ordinal) => bytes.subarray(ordinal * 65_536, (ordinal + 1) * 65_536),
  );
  const chunkIdentities = chunks.map((content, ordinal) => ({
    ordinal,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    sizeBytes: content.length,
  }));
  const logicalInput = {
    repository,
    expectedHeadSha: sourceSha,
    baseBranch: "main",
    branchName: "codeops/candidate-proof",
    commitMessage: "Publish the candidate proof",
    changes,
  };
  const effectDigest = sha256CanonicalJsonDigest(logicalInput);
  const operationId = `githubmutation-${createHash("sha256")
    .update(canonicalJsonText({
      dispatchId,
      operation: "branch_publish",
      input: logicalInput,
    })).digest("hex")}`;
  const candidateIdentity = {
    digest: sha256CanonicalJsonDigest(candidate),
    sizeBytes: bytes.length,
    chunkCount: chunks.length,
  };
  const manifestId = `githubcandidate-${createHash("sha256")
    .update(canonicalJsonText({
      version: "codeops.github-branch-publish-candidate-manifest/v1",
      dispatchId,
      sessionId,
      ownerPrincipalId: owner,
      repository,
      operationId,
      effectDigest,
      candidate: candidateIdentity,
      chunks: chunkIdentities,
      operation: "branch_publish",
    })).digest("hex")}`;
  return {
    candidate,
    operationId,
    manifestId,
    manifest: {
      version: "codeops.github-branch-publish-candidate-manifest-request/v1",
      claimToken,
      operationId,
      effectDigest,
      repository,
      candidate: { manifestId, ...candidateIdentity },
      chunks: chunkIdentities,
    },
    chunks: chunks.map((content, ordinal) => ({
      version: "codeops.github-branch-publish-candidate-chunk-request/v1",
      claimToken,
      operationId,
      manifestId,
      ordinal,
      digest: chunkIdentities[ordinal].digest,
      bytesBase64: content.toString("base64"),
    })),
  };
}

async function stage(connection, fixture = candidateFixture()) {
  await createGitHubBranchCandidateManifest(connection, {
    dispatchId,
    workerId,
    request: fixture.manifest,
    now: () => new Date("2026-08-30T10:02:00.000Z"),
  });
  for (const request of fixture.chunks) {
    await storeGitHubBranchCandidateChunk(connection, {
      dispatchId,
      workerId,
      request,
      now: () => new Date("2026-08-30T10:02:00.000Z"),
    });
  }
  return fixture;
}

test("PostgreSQL applies and truthfully reverts the candidate migration", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection, "pending");
    assert.deepEqual((await connection.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='codeops'
          AND table_name LIKE 'github_branch_publish_candidate_%'
        ORDER BY table_name`,
    )).rows.map((row) => row.table_name), [
      "github_branch_publish_candidate_chunks",
      "github_branch_publish_candidate_manifests",
    ]);
    const revert = await readFile(
      new URL("../sql/github-branch-publish-candidates-v1-revert.sql", import.meta.url),
      "utf8",
    );
    await connection.query(revert);
    assert.equal((await connection.query(
      "SELECT to_regclass('codeops.github_branch_publish_candidate_manifests') relation",
    )).rows[0].relation, null);
  } finally {
    await connection.end();
  }
});

test("PostgreSQL stores and loads one exact claimed candidate", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const fixture = await stage(connection);
    assert.deepEqual(await loadGitHubBranchCandidate(connection, {
      manifestId: fixture.manifestId,
      dispatchId,
      operationId: fixture.operationId,
      effectDigest: fixture.manifest.effectDigest,
      lock: false,
    }), fixture.candidate);
  } finally {
    await connection.end();
  }
});

test("PostgreSQL fails closed on claimed candidate authority drift", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const fixture = candidateFixture();
    await assert.rejects(createGitHubBranchCandidateManifest(connection, {
      dispatchId,
      workerId: "runtime-worker:other",
      request: fixture.manifest,
      now: () => new Date("2026-08-30T10:02:00.000Z"),
    }), /exact live dispatch claim/);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_manifests",
    )).rows[0].count, 0);
  } finally {
    await connection.end();
  }
});

test("PostgreSQL removes only candidates without a provider receipt", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    await stage(connection);
    await cleanupNoReceiptGitHubBranchCandidatesForDispatch(connection, dispatchId);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_manifests",
    )).rows[0].count, 0);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_chunks",
    )).rows[0].count, 0);
  } finally {
    await connection.end();
  }
});

test("PostgreSQL keeps manifest replay identity after definitive chunk cleanup", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const fixture = await stage(connection);
    const permissionDigest = sha256CanonicalJsonDigest({ permission: fixture.operationId });
    const authority = { operationId: fixture.operationId, targetId: "codeops/candidate-proof",
      permissionDigest };
    await seedGitHubPermissionAuthorities(connection, [authority]);
    await connection.query(
      `INSERT INTO codeops.provider_effect_receipts(
         effect_id,provider,repository,operation,pull_request_number,target_id,
         expected_head_sha,session_id,dispatch_id,payload_digest,
         permission_digest,state,evidence_json,resolution_summary,
         reconciliation_action,authorized_at,attempted_at,resolved_at,updated_at,
         permission_request_id,admission_id,session_generation,session_lease_id,
         authorization_expires_at)
       VALUES($1,'github',$2,'branch_publish',NULL,'codeops/candidate-proof',$3,
         $4,$5,$6,$7,'succeeded',$8::jsonb,'Candidate publication succeeded.',
         'none',$9::timestamptz,$10::timestamptz,$11::timestamptz,$11::timestamptz,
         $12,$13,1,$14,$15::timestamptz)`,
      [fixture.operationId, repository, sourceSha, sessionId, dispatchId,
        sha256CanonicalJsonDigest({ candidate: fixture.manifest.candidate }),
        permissionDigest,
        canonicalJsonText({ version: "codeops.github-branch-publish-result/v1" }),
        "2026-08-30T10:03:00.000Z", "2026-08-30T10:04:00.000Z",
        "2026-08-30T10:05:00.000Z", authority.permissionRequestId,
        authority.admissionId, leaseId, "2026-08-30T11:00:00.000Z"],
    );
    await cleanupDefinitiveGitHubBranchCandidateChunks(connection, fixture.operationId);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_manifests",
    )).rows[0].count, 1);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_chunks",
    )).rows[0].count, 0);
  } finally {
    await connection.end();
  }
});

test("PostgreSQL terminal cleanup progresses beyond 100 rows and retries idempotently", { skip }, async () => {
  requireDedicatedDatabase();
  const connection = await client();
  try {
    await resetAndSeed(connection);
    const permissions = Array.from({ length: 104 }, (_, index) => ({
      operationId: `githubmutation-${(index + 1).toString(16).padStart(64, "0")}`,
      targetId: "codeops/candidate-cleanup",
      permissionDigest: `sha256:${"d".repeat(64)}`,
    }));
    await seedGitHubPermissionAuthorities(connection, permissions);
    await connection.query(
      `WITH identities AS (
         SELECT index,
                'githubcandidate-' || lpad(to_hex(index), 64, '0') AS manifest_id,
                'githubmutation-' || lpad(to_hex(index), 64, '0') AS operation_id
           FROM generate_series(1, 104) AS generated(index)
       )
       INSERT INTO codeops.github_branch_publish_candidate_manifests(
         manifest_id, candidate_digest, candidate_bytes, chunk_count,
         dispatch_id, session_id, owner_principal_id, repository, operation,
         operation_id, effect_digest, chunk_identities_json, created_at)
       SELECT manifest_id, 'sha256:' || repeat('a', 64), 1, 1,
              $1, $2, $3, $4, 'branch_publish', operation_id,
              'sha256:' || repeat('e', 64),
              jsonb_build_array(jsonb_build_object(
                'ordinal', 0, 'digest', 'sha256:' || repeat('b', 64),
                'sizeBytes', 1)),
              $5::timestamptz + index * interval '1 second'
         FROM identities`,
      [dispatchId, sessionId, owner, repository, seededAt],
    );
    await connection.query(
      `INSERT INTO codeops.github_branch_publish_candidate_chunks(
         manifest_id, dispatch_id, operation_id, ordinal,
         chunk_digest, chunk_bytes, content)
       SELECT manifest_id, dispatch_id, operation_id, 0,
              'sha256:' || repeat('b', 64), 1, decode('78', 'hex')
         FROM codeops.github_branch_publish_candidate_manifests`,
    );
    await connection.query(
      `WITH identities AS (
         SELECT index,
                'githubmutation-' || lpad(to_hex(index), 64, '0') AS operation_id,
                CASE
                  WHEN index <= 101 THEN 'succeeded'
                  WHEN index = 102 THEN 'authorized'
                  WHEN index = 103 THEN 'attempting'
                  ELSE 'unknown'
                END AS state
           FROM generate_series(1, 104) AS generated(index)
       )
       INSERT INTO codeops.provider_effect_receipts(
         effect_id, provider, repository, operation, pull_request_number,
         target_id, expected_head_sha, session_id, dispatch_id, payload_digest,
         permission_digest, state, evidence_json, resolution_summary,
         reconciliation_action, authorized_at, attempted_at, resolved_at,
         updated_at,permission_request_id,admission_id,session_generation,
         session_lease_id,authorization_expires_at)
       SELECT identities.operation_id, 'github', $1, 'branch_publish', NULL,
              'codeops/candidate-cleanup', $2, $3, $4,
              'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
              state,
              CASE WHEN state = 'succeeded'
                THEN jsonb_build_object('result', identities.operation_id) ELSE NULL END,
              CASE WHEN state = 'succeeded'
                THEN 'Candidate publication succeeded.' ELSE NULL END,
              CASE WHEN state IN ('attempting', 'unknown')
                THEN 'operator_review' ELSE 'none' END,
              $5::timestamptz,
              CASE WHEN state = 'authorized' THEN NULL
                ELSE $5::timestamptz + interval '1 minute' END,
              CASE WHEN state = 'succeeded'
                THEN $5::timestamptz + interval '2 minutes' ELSE NULL END,
              $5::timestamptz + interval '2 minutes',permission.request_id,
              permission.admission_id,permission.session_generation,
              permission.session_lease_id,$5::timestamptz + interval '1 hour'
         FROM identities
         JOIN codeops.session_runtime_permission_requests AS permission
           ON permission.operation_provider='github'
          AND permission.operation_id=identities.operation_id`,
      [repository, sourceSha, sessionId, dispatchId, seededAt],
    );

    await cleanupTerminalOrphanGitHubBranchCandidateChunks(connection);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_chunks",
    )).rows[0].count, 4);

    await cleanupTerminalOrphanGitHubBranchCandidateChunks(connection);
    assert.equal((await connection.query(
      "SELECT count(*)::integer count FROM codeops.github_branch_publish_candidate_chunks",
    )).rows[0].count, 3);

    await cleanupTerminalOrphanGitHubBranchCandidateChunks(connection);
    assert.deepEqual((await connection.query(
      `SELECT effect.state, count(chunk.manifest_id)::integer AS chunks
         FROM codeops.github_branch_publish_candidate_manifests AS manifest
         JOIN codeops.provider_effect_receipts AS effect
           ON effect.effect_id = manifest.operation_id
         LEFT JOIN codeops.github_branch_publish_candidate_chunks AS chunk
           ON chunk.manifest_id = manifest.manifest_id
        GROUP BY effect.state
        ORDER BY effect.state`,
    )).rows, [
      { state: "attempting", chunks: 1 },
      { state: "authorized", chunks: 1 },
      { state: "succeeded", chunks: 0 },
      { state: "unknown", chunks: 1 },
    ]);
    assert.deepEqual((await connection.query(
      `SELECT count(*)::integer AS manifests,
              count(candidate_digest)::integer AS digests
         FROM codeops.github_branch_publish_candidate_manifests`,
    )).rows[0], { manifests: 104, digests: 104 });
  } finally {
    await connection.end();
  }
});
