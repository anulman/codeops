import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelBudgetLedger,
  ModelBudgetAuthorityError,
  ModelBudgetConflictError,
  ModelBudgetExhaustedError,
} from "../src/model-budget-ledger.mjs";

const reservation = {
  reservationId: "018f5c9e-7606-4c6d-8c86-2b8d921c1d41",
  modelTokenId: `sha256:${"a".repeat(64)}`,
  sessionId: "ses_budget_1",
  budgetId: "budget_1",
  generation: 3,
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  requestedOutputTokens: 2_000,
  reservedOutputTokens: 1_500,
};

function databaseWith(row) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [row] };
    },
  };
}

test("reserves through only the fixed ledger function", async () => {
  const database = databaseWith({
    reservation_id: reservation.reservationId,
    reserved_output_tokens: "1500",
    remaining_provider_requests: "7",
    remaining_output_tokens: "8500",
    budget_revision: "4",
  });
  const ledger = createModelBudgetLedger(database);
  assert.deepEqual(await ledger.reserve(reservation), {
    reservationId: reservation.reservationId,
    reservedOutputTokens: 1_500,
    remainingProviderRequests: 7,
    remainingOutputTokens: 8_500,
    budgetRevision: 4,
  });
  assert.match(database.calls[0].text, /codeops\.reserve_session_model_budget/);
  assert.doesNotMatch(database.calls[0].text, /INSERT|UPDATE|FOR UPDATE/);
});

test("uses the dispatch-fenced ledger function for claimed authority", async () => {
  const database = databaseWith({
    reservation_id: reservation.reservationId,
    reserved_output_tokens: "1500",
    remaining_provider_requests: "7",
    remaining_output_tokens: "8500",
    budget_revision: "4",
  });
  await createModelBudgetLedger(database).reserve({
    ...reservation,
    leaseId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
  });
  assert.match(
    database.calls[0].text,
    /codeops\.reserve_session_dispatch_model_budget/,
  );
  assert.equal(database.calls[0].values[5], "11111111-1111-4111-8111-111111111111");
  assert.equal(database.calls[0].values[6], "22222222-2222-4222-8222-222222222222");
});

test("charges stale reservations through only the fixed recovery function", async () => {
  const database = databaseWith({ charged_reservations: "2" });
  assert.deepEqual(await createModelBudgetLedger(database).recover(), {
    chargedReservations: 2,
  });
  assert.match(
    database.calls[0].text,
    /codeops\.charge_stale_session_model_budget_reservations/,
  );
  assert.doesNotMatch(database.calls[0].text, /INSERT|UPDATE|FOR UPDATE/);
});

test("settles proved usage and unknown usage through one fixed function", async () => {
  for (const input of [
    {
      reservationId: reservation.reservationId,
      state: "settled",
      providerRequestId: "req_1",
      provedInputTokens: 120,
      provedOutputTokens: 80,
      provedTotalTokens: 200,
      failureClass: null,
    },
    {
      reservationId: reservation.reservationId,
      state: "charged_unknown",
      providerRequestId: null,
      provedInputTokens: null,
      provedOutputTokens: null,
      provedTotalTokens: null,
      failureClass: "truncated_stream",
    },
  ]) {
    const database = databaseWith({
      reservation_id: reservation.reservationId,
      state: input.state,
      charged_output_tokens: input.state === "settled" ? "80" : "1500",
      remaining_output_tokens: "8420",
      budget_revision: "5",
    });
    const result = await createModelBudgetLedger(database).settle(input);
    assert.equal(result.state, input.state);
    assert.match(database.calls[0].text, /codeops\.settle_session_model_budget/);
    assert.doesNotMatch(database.calls[0].text, /INSERT|UPDATE|FOR UPDATE/);
  }
});

test("rejects malformed reservation and settlement inputs before SQL", async () => {
  const database = databaseWith({});
  const ledger = createModelBudgetLedger(database);
  await assert.rejects(
    ledger.reserve({ ...reservation, generation: 0 }),
    /reservation input is invalid/,
  );
  await assert.rejects(
    ledger.settle({
      reservationId: reservation.reservationId,
      state: "settled",
      providerRequestId: null,
      provedInputTokens: 5,
      provedOutputTokens: 6,
      provedTotalTokens: 12,
      failureClass: null,
    }),
    /proved usage is invalid/,
  );
  assert.equal(database.calls.length, 0);
});

test("maps stable database denials without exposing SQL details", async () => {
  for (const [message, ErrorType] of [
    ["CODEOPS_MODEL_BUDGET_EXHAUSTED:output_tokens", ModelBudgetExhaustedError],
    ["CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID", ModelBudgetAuthorityError],
    ["CODEOPS_MODEL_BUDGET_RESERVATION_CONFLICT", ModelBudgetConflictError],
  ]) {
    const ledger = createModelBudgetLedger({
      async query() {
        throw new Error(message);
      },
    });
    await assert.rejects(ledger.reserve(reservation), ErrorType);
  }
});
