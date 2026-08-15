import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  createModelBudgetLedger,
  ModelBudgetExhaustedError,
} from "../src/model-budget-ledger.mjs";

const ledgerDatabaseUrl = process.env.CODEOPS_TEST_MODEL_BUDGET_DATABASE_URL;
const ownerDatabaseUrl =
  process.env.CODEOPS_TEST_MODEL_BUDGET_OWNER_DATABASE_URL;

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
           (session_id, generation, lease_id, snapshot_json, updated_at)
         VALUES (
           'ses_concurrency_proof', 7,
           '11111111-1111-4111-8111-111111111111',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_concurrency_proof","generation":7,"state":"running","lease":{"leaseId":"11111111-1111-4111-8111-111111111111","generation":7,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz
         )`,
      );
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
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      requestedOutputTokens: outputTokens,
      reservedOutputTokens: outputTokens,
    });
    try {
      await ownerPool.query(
        `INSERT INTO codeops.sessions
           (session_id, generation, lease_id, snapshot_json, updated_at)
         VALUES (
           'ses_settlement_proof', 2,
           '22222222-2222-4222-8222-222222222222',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_settlement_proof","generation":2,"state":"running","lease":{"leaseId":"22222222-2222-4222-8222-222222222222","generation":2,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz
         )`,
      );
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
           (session_id, generation, lease_id, snapshot_json, updated_at)
         VALUES (
           'ses_recovery_proof', 1,
           '33333333-3333-4333-8333-333333333333',
           '{"version":"codeops.session-snapshot/v1","sessionId":"ses_recovery_proof","generation":1,"state":"running","lease":{"leaseId":"33333333-3333-4333-8333-333333333333","generation":1,"status":"active"},"pendingPermission":null,"updatedAt":"2026-08-15T18:25:00.000Z"}'::jsonb,
           '2026-08-15T18:25:00.000Z'::timestamptz
         )`,
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
