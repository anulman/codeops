import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
    await connection.query(
      `INSERT INTO codeops.provider_effect_receipts(
         effect_id,provider,repository,operation,pull_request_number,target_id,
         expected_head_sha,session_id,dispatch_id,payload_digest,
         permission_digest,state,evidence_json,resolution_summary,
         reconciliation_action,authorized_at,attempted_at,resolved_at,updated_at)
       VALUES($1,'github',$2,'branch_publish',NULL,'codeops/candidate-proof',$3,
         $4,$5,$6,$7,'succeeded',$8::jsonb,'Candidate publication succeeded.',
         'none',$9::timestamptz,$10::timestamptz,$11::timestamptz,$11::timestamptz)`,
      [fixture.operationId, repository, sourceSha, sessionId, dispatchId,
        sha256CanonicalJsonDigest({ candidate: fixture.manifest.candidate }),
        sha256CanonicalJsonDigest({ permission: fixture.operationId }),
        canonicalJsonText({ version: "codeops.github-branch-publish-result/v1" }),
        "2026-08-30T10:03:00.000Z", "2026-08-30T10:04:00.000Z",
        "2026-08-30T10:05:00.000Z"],
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
         updated_at)
       SELECT operation_id, 'github', $1, 'branch_publish', NULL,
              'codeops/candidate-cleanup', $2, $3, $4,
              'sha256:' || repeat('c', 64), 'sha256:' || repeat('d', 64),
              state,
              CASE WHEN state = 'succeeded'
                THEN jsonb_build_object('result', operation_id) ELSE NULL END,
              CASE WHEN state = 'succeeded'
                THEN 'Candidate publication succeeded.' ELSE NULL END,
              CASE WHEN state IN ('attempting', 'unknown')
                THEN 'operator_review' ELSE 'none' END,
              $5::timestamptz,
              CASE WHEN state = 'authorized' THEN NULL
                ELSE $5::timestamptz + interval '1 minute' END,
              CASE WHEN state = 'succeeded'
                THEN $5::timestamptz + interval '2 minutes' ELSE NULL END,
              $5::timestamptz + interval '2 minutes'
         FROM identities`,
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
