import { requireDisposablePostgres } from "../../../infra/scripts/disposable-postgres.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  createModelBudgetLedger,
  ModelBudgetExhaustedError,
} from "../src/model-budget-ledger.mjs";

const ledgerDatabaseUrl = process.env.CODEOPS_TEST_MODEL_BUDGET_DATABASE_URL;
const ownerDatabaseUrl =
  process.env.CODEOPS_TEST_MODEL_BUDGET_OWNER_DATABASE_URL;
if (ownerDatabaseUrl || ledgerDatabaseUrl) {
  await requireDisposablePostgres(ownerDatabaseUrl);
  const ledger = new URL(ledgerDatabaseUrl);
  const owner = new URL(ownerDatabaseUrl);
  if (ledger.protocol !== owner.protocol || ledger.host !== owner.host ||
      ledger.pathname !== owner.pathname || ledger.search || ledger.hash) {
    throw new Error("Model ledger must use the disposable PostgreSQL target");
  }
}

const canonical = (value) => JSON.stringify(value, (_, nested) =>
  nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested);
const runtimeRequirements = { version: "codeops.runtime-requirements/v1", capabilities: ["model-proxy"],
  minimumResources: { cpuMillis: 100, memoryMiB: 128, ephemeralStorageMiB: 128 },
  requiredAuthority: { workspaceAccess: "read-only", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "read-only", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "policy-7" };
const runtimeRequirementDigest = `sha256:${createHash("sha256").update(canonical(runtimeRequirements)).digest("hex")}`;
const runtimeLaunchBinding = { version: "codeops.runtime-launch-binding/v1", requirementDigest: runtimeRequirementDigest,
  selectedAt: "2026-08-15T18:25:00.000Z", profile: { version: "codeops.runtime-profile/v1",
    profileId: "model-proxy-test-v1", releaseDigest: `sha256:${"7".repeat(64)}`,
    capabilities: ["model-proxy"], capabilityDigest: `sha256:${createHash("sha256").update(canonical(["model-proxy"])).digest("hex")}`,
    resources: { cpuMillis: 100, memoryMiB: 128, ephemeralStorageMiB: 128 },
    authority: runtimeRequirements.maximumAuthority, compatibilityPolicyRevision: "policy-7",
    images: { agent: `example/agent@sha256:${"8".repeat(64)}`, worker: `example/worker@sha256:${"9".repeat(64)}`,
      sessionGateway: `example/gateway@sha256:${"a".repeat(64)}` } } };
const runtimeProfile = runtimeLaunchBinding.profile;
const runtimeBinding = { version: "codeops.runtime-binding/v1",
  requirementDigest: runtimeRequirementDigest,
  compatibilityPolicyRevision: runtimeProfile.compatibilityPolicyRevision,
  selectedProfileId: runtimeProfile.profileId,
  selectedReleaseDigest: runtimeProfile.releaseDigest,
  selectedCapabilityDigest: runtimeProfile.capabilityDigest,
  selectedProfile: runtimeProfile, selectedAt: runtimeLaunchBinding.selectedAt };
const runtimeOwnerValues = [canonical(runtimeRequirements), runtimeRequirementDigest, canonical(runtimeLaunchBinding)];

async function insertClaimedDispatch(pool, { sessionId, generation, leaseId, dispatchId }) {
  const dispatch = {
    version: "codeops.session-runtime-dispatch/v1", dispatchId,
    principalId: "codeops:model-proxy-test",
    command: { version: "codeops.session-command/v1", sessionId, generation, leaseId,
      idempotencyKey: dispatchId, type: "prompt", prompt: "Exercise the model budget." },
    snapshot: { version: "codeops.session-snapshot/v1", sessionId, generation,
      state: "running", lease: { leaseId, generation, status: "active" },
      pendingPermission: null, updatedAt: "2026-08-15T18:25:00.000Z" },
    dispatchedAt: "2026-08-15T18:25:00.000Z",
  };
  await pool.query(`INSERT INTO codeops.session_runtime_outbox (
      dispatch_id,session_id,idempotency_key,principal_id,dispatch_json,status,
      available_at,created_at,claim_token,claimed_by,claimed_at,claim_expires_at,claim_count,
      runtime_binding_json,runtime_binding_revision,runtime_claim_protocol,
      runtime_requirement_digest,runtime_profile_id,runtime_release_digest,runtime_capability_digest)
    VALUES ($1,$2,$1,'codeops:model-proxy-test',$3::jsonb,'claimed',clock_timestamp(),
      ($3::jsonb->>'dispatchedAt')::timestamptz,$1,'runtime-worker:model-budget-proof',clock_timestamp(),
      clock_timestamp() + interval '1 hour',1,$4::jsonb,1,'bound-v2',$5,$6,$7,$8)`,
  [dispatchId, sessionId, canonical(dispatch), canonical(runtimeBinding),
    runtimeRequirementDigest, runtimeProfile.profileId, runtimeProfile.releaseDigest,
    runtimeProfile.capabilityDigest]);
}

test(
  "serializes two proxy clients and preserves durable unknown charges",
  { skip: !ledgerDatabaseUrl || !ownerDatabaseUrl },
  async () => {
    const firstPool = new pg.Pool({ connectionString: ledgerDatabaseUrl, max: 1 });
    const secondPool = new pg.Pool({ connectionString: ledgerDatabaseUrl, max: 1 });
    const ownerPool = new pg.Pool({ connectionString: ownerDatabaseUrl, max: 1 });
    const reservationInput = (reservationId) => ({
      reservationId,
      modelTokenId: `sha256:${"a".repeat(64)}`,
      sessionId: "ses_concurrency_proof",
      budgetId: "budget_concurrency_proof",
      generation: 7,
      leaseId: "11111111-1111-4111-8111-111111111111",
      dispatchId: "12121212-1212-4121-8121-121212121212",
      claimCount: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      requestedOutputTokens: 60,
      reservedOutputTokens: 60,
    });
    let firstPoolEnded = false;
    try {
      await ownerPool.query(
        `INSERT INTO codeops.sessions
           (session_id, generation, lease_id, snapshot_json, updated_at, owner_principal_id,
            runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
         VALUES (
           'ses_concurrency_proof', 7,
           '11111111-1111-4111-8111-111111111111',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_concurrency_proof","generation":7,"state":"running","lease":{"leaseId":"11111111-1111-4111-8111-111111111111","generation":7,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz, 'codeops:model-proxy-test',
           $1::jsonb,$2,$3::jsonb
        )`, runtimeOwnerValues,
      );
      await insertClaimedDispatch(ownerPool, {
        sessionId: "ses_concurrency_proof", generation: 7,
        leaseId: "11111111-1111-4111-8111-111111111111",
        dispatchId: "12121212-1212-4121-8121-121212121212",
      });
      await ownerPool.query(
        `INSERT INTO codeops.session_model_budgets (
           session_id, budget_id, started_at, provider_requests_limit,
           output_tokens_limit, updated_at
         ) VALUES (
           'ses_concurrency_proof', 'budget_concurrency_proof',
           clock_timestamp(), 1, 100, clock_timestamp()
         )`,
      );
      const firstReservationId = randomUUID();
      const secondReservationId = randomUUID();
      const attempts = await Promise.allSettled([
        createModelBudgetLedger(firstPool).reserve(
          reservationInput(firstReservationId),
        ),
        createModelBudgetLedger(secondPool).reserve(
          reservationInput(secondReservationId),
        ),
      ]);
      assert.equal(
        attempts.filter(({ status }) => status === "fulfilled").length,
        1,
      );
      const rejected = attempts.find(({ status }) => status === "rejected");
      assert.ok(rejected.reason instanceof ModelBudgetExhaustedError);

      const durable = await ownerPool.query(
        `SELECT committed_provider_requests, settled_output_tokens,
                reserved_output_tokens, revision
           FROM codeops.session_model_budgets
          WHERE session_id = 'ses_concurrency_proof'`,
      );
      assert.deepEqual(durable.rows[0], {
        committed_provider_requests: "1",
        settled_output_tokens: "0",
        reserved_output_tokens: "60",
        revision: "2",
      });

      await firstPool.end();
      firstPoolEnded = true;
      const restartedPool = new pg.Pool({
        connectionString: ledgerDatabaseUrl,
        max: 1,
      });
      try {
        await assert.rejects(
          createModelBudgetLedger(restartedPool).reserve(
            reservationInput(randomUUID()),
          ),
          ModelBudgetExhaustedError,
        );
        const accepted = attempts.find(({ status }) => status === "fulfilled");
        const settlement = {
          reservationId: accepted.value.reservationId,
          state: "charged_unknown",
          providerRequestId: null,
          provedInputTokens: null,
          provedOutputTokens: null,
          provedTotalTokens: null,
          failureClass: "timeout",
        };
        const firstSettlement = await createModelBudgetLedger(
          restartedPool,
        ).settle(settlement);
        const repeatedSettlement = await createModelBudgetLedger(
          restartedPool,
        ).settle(settlement);
        assert.deepEqual(repeatedSettlement, firstSettlement);
      } finally {
        await restartedPool.end();
      }

      const charged = await ownerPool.query(
        `SELECT committed_provider_requests, settled_output_tokens,
                reserved_output_tokens, revision
           FROM codeops.session_model_budgets
          WHERE session_id = 'ses_concurrency_proof'`,
      );
      assert.deepEqual(charged.rows[0], {
        committed_provider_requests: "1",
        settled_output_tokens: "60",
        reserved_output_tokens: "0",
        revision: "3",
      });
      await assert.rejects(
        secondPool.query("SELECT * FROM codeops.session_model_budgets"),
        /permission denied/,
      );
    } finally {
      if (!firstPoolEnded) await firstPool.end();
      await secondPool.end();
      await ownerPool.end();
    }
  },
);

test(
  "settles proved usage and releases a proved provider rejection",
  { skip: !ledgerDatabaseUrl || !ownerDatabaseUrl },
  async () => {
    const ledgerPool = new pg.Pool({ connectionString: ledgerDatabaseUrl, max: 1 });
    const ownerPool = new pg.Pool({ connectionString: ownerDatabaseUrl, max: 1 });
    const input = (reservationId, outputTokens) => ({
      reservationId,
      modelTokenId: `sha256:${"b".repeat(64)}`,
      sessionId: "ses_settlement_proof",
      budgetId: "budget_settlement_proof",
      generation: 2,
      leaseId: "22222222-2222-4222-8222-222222222222",
      dispatchId: "23232323-2323-4232-8232-232323232323",
      claimCount: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      requestedOutputTokens: outputTokens,
      reservedOutputTokens: outputTokens,
    });
    try {
      await ownerPool.query(
        `INSERT INTO codeops.sessions
           (session_id, generation, lease_id, snapshot_json, updated_at, owner_principal_id,
            runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
         VALUES (
           'ses_settlement_proof', 2,
           '22222222-2222-4222-8222-222222222222',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_settlement_proof","generation":2,"state":"running","lease":{"leaseId":"22222222-2222-4222-8222-222222222222","generation":2,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz, 'codeops:model-proxy-test',
           $1::jsonb,$2,$3::jsonb
        )`, runtimeOwnerValues,
      );
      await insertClaimedDispatch(ownerPool, {
        sessionId: "ses_settlement_proof", generation: 2,
        leaseId: "22222222-2222-4222-8222-222222222222",
        dispatchId: "23232323-2323-4232-8232-232323232323",
      });
      await ownerPool.query(
        `INSERT INTO codeops.session_model_budgets (
           session_id, budget_id, started_at, provider_requests_limit,
           output_tokens_limit, updated_at
         ) VALUES (
           'ses_settlement_proof', 'budget_settlement_proof',
           clock_timestamp(), 3, 100, clock_timestamp()
         )`,
      );
      const ledger = createModelBudgetLedger(ledgerPool);
      const settledId = randomUUID();
      await ledger.reserve(input(settledId, 60));
      assert.deepEqual(
        await ledger.settle({
          reservationId: settledId,
          state: "settled",
          providerRequestId: "resp_settled_1",
          provedInputTokens: 30,
          provedOutputTokens: 40,
          provedTotalTokens: 70,
          failureClass: null,
        }),
        {
          reservationId: settledId,
          state: "settled",
          chargedOutputTokens: 40,
          remainingOutputTokens: 60,
          budgetRevision: 3,
        },
      );

      const rejectedId = randomUUID();
      await ledger.reserve(input(rejectedId, 50));
      assert.deepEqual(
        await ledger.settle({
          reservationId: rejectedId,
          state: "provider_rejected",
          providerRequestId: "resp_rejected_1",
          provedInputTokens: null,
          provedOutputTokens: null,
          provedTotalTokens: null,
          failureClass: "provider_rejected",
        }),
        {
          reservationId: rejectedId,
          state: "provider_rejected",
          chargedOutputTokens: 0,
          remainingOutputTokens: 60,
          budgetRevision: 5,
        },
      );

      const durable = await ownerPool.query(
        `SELECT committed_provider_requests, settled_output_tokens,
                reserved_output_tokens, observed_input_tokens,
                observed_total_tokens, revision
           FROM codeops.session_model_budgets
          WHERE session_id = 'ses_settlement_proof'`,
      );
      assert.deepEqual(durable.rows[0], {
        committed_provider_requests: "2",
        settled_output_tokens: "40",
        reserved_output_tokens: "0",
        observed_input_tokens: "30",
        observed_total_tokens: "70",
        revision: "5",
      });
    } finally {
      await ledgerPool.end();
      await ownerPool.end();
    }
  },
);

test(
  "charges a stale reservation after a proxy crash",
  { skip: !ledgerDatabaseUrl || !ownerDatabaseUrl },
  async () => {
    const ledgerPool = new pg.Pool({ connectionString: ledgerDatabaseUrl, max: 1 });
    const ownerPool = new pg.Pool({ connectionString: ownerDatabaseUrl, max: 1 });
    const reservationId = randomUUID();
    try {
      await ownerPool.query(
        `INSERT INTO codeops.sessions
           (session_id, generation, lease_id, snapshot_json, updated_at, owner_principal_id,
            runtime_requirements_json,runtime_requirement_digest,runtime_launch_binding_json)
         VALUES (
           'ses_recovery_proof', 1,
           '33333333-3333-4333-8333-333333333333',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_recovery_proof","generation":1,"state":"running","lease":{"leaseId":"33333333-3333-4333-8333-333333333333","generation":1,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz, 'codeops:model-proxy-test',
           $1::jsonb,$2,$3::jsonb
         )`, runtimeOwnerValues,
      );
      await ownerPool.query(
        `INSERT INTO codeops.session_model_budgets (
           session_id, budget_id, started_at, provider_requests_limit,
           output_tokens_limit, committed_provider_requests,
           reserved_output_tokens, revision, updated_at
         ) VALUES (
           'ses_recovery_proof', 'budget_recovery_proof',
           clock_timestamp() - interval '1 hour', 3, 100, 1, 70, 2,
           clock_timestamp() - interval '1 hour'
         )`,
      );
      await ownerPool.query(
        `INSERT INTO codeops.session_model_budget_reservations (
           reservation_id, model_token_id, session_id, budget_id, generation,
           provider, model, reasoning_effort, requested_output_tokens,
           reserved_output_tokens, state, reserved_at
         ) VALUES (
           $1, $2, 'ses_recovery_proof', 'budget_recovery_proof', 1,
           'openai', 'gpt-5.6-sol', 'high', 70, 70, 'reserved',
           clock_timestamp() - interval '16 minutes'
         )`,
        [reservationId, `sha256:${"c".repeat(64)}`],
      );

      assert.deepEqual(await createModelBudgetLedger(ledgerPool).recover(), {
        chargedReservations: 1,
      });
      const durable = await ownerPool.query(
        `SELECT budgets.settled_output_tokens,
                budgets.reserved_output_tokens,
                budgets.revision,
                reservations.state,
                reservations.failure_class
           FROM codeops.session_model_budgets budgets
           JOIN codeops.session_model_budget_reservations reservations
             ON reservations.session_id = budgets.session_id
          WHERE budgets.session_id = 'ses_recovery_proof'`,
      );
      assert.deepEqual(durable.rows[0], {
        settled_output_tokens: "70",
        reserved_output_tokens: "0",
        revision: "3",
        state: "charged_unknown",
        failure_class: "proxy_stopped",
      });
    } finally {
      await ledgerPool.end();
      await ownerPool.end();
    }
  },
);
