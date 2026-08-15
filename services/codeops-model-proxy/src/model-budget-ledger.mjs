const RESERVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_TOKEN_ID = /^sha256:[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
const UNKNOWN_FAILURE_CLASSES = new Set([
  "transport",
  "timeout",
  "truncated_stream",
  "missing_terminal_usage",
  "invalid_terminal_usage",
  "proxy_stopped",
]);

export class ModelBudgetExhaustedError extends Error {
  constructor(limit) {
    super(`model budget ${limit} limit is exhausted`);
    this.limit = limit;
  }
}

export class ModelBudgetAuthorityError extends Error {}
export class ModelBudgetConflictError extends Error {}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCount(value, name) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!safeCount(parsed)) throw new Error(`model budget ${name} is invalid`);
  return parsed;
}

function translateDatabaseError(error) {
  if (!(error instanceof Error)) return error;
  const exhausted = error.message.match(
    /CODEOPS_MODEL_BUDGET_EXHAUSTED:(provider_requests|output_tokens)/,
  );
  if (exhausted) return new ModelBudgetExhaustedError(exhausted[1]);
  if (error.message.includes("CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID")) {
    return new ModelBudgetAuthorityError("model budget authority is invalid");
  }
  if (
    error.message.includes("CODEOPS_MODEL_BUDGET_RESERVATION_CONFLICT") ||
    error.message.includes("CODEOPS_MODEL_BUDGET_SETTLEMENT_CONFLICT")
  ) {
    return new ModelBudgetConflictError("model budget operation conflicts");
  }
  return error;
}

function reservationInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !RESERVATION_ID.test(input.reservationId) ||
    !MODEL_TOKEN_ID.test(input.modelTokenId) ||
    !BOUNDED_ID.test(input.sessionId) ||
    !BOUNDED_ID.test(input.budgetId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    input.provider !== "openai" ||
    !MODEL.test(input.model) ||
    !REASONING_EFFORTS.has(input.reasoningEffort) ||
    !Number.isSafeInteger(input.requestedOutputTokens) ||
    input.requestedOutputTokens < 1 ||
    !Number.isSafeInteger(input.reservedOutputTokens) ||
    input.reservedOutputTokens < 1 ||
    input.reservedOutputTokens > input.requestedOutputTokens
  ) {
    throw new Error("model budget reservation input is invalid");
  }
  return input;
}

function settlementInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !RESERVATION_ID.test(input.reservationId) ||
    !["settled", "provider_rejected", "charged_unknown"].includes(input.state) ||
    (input.providerRequestId !== null &&
      !PROVIDER_REQUEST_ID.test(input.providerRequestId))
  ) {
    throw new Error("model budget settlement input is invalid");
  }
  if (
    input.state === "settled" &&
    (!safeCount(input.provedInputTokens) ||
      !safeCount(input.provedOutputTokens) ||
      !safeCount(input.provedTotalTokens) ||
      input.provedTotalTokens !==
        input.provedInputTokens + input.provedOutputTokens ||
      input.failureClass !== null)
  ) {
    throw new Error("model budget proved usage is invalid");
  }
  if (
    input.state === "provider_rejected" &&
    (input.provedInputTokens !== null ||
      input.provedOutputTokens !== null ||
      input.provedTotalTokens !== null ||
      input.failureClass !== "provider_rejected")
  ) {
    throw new Error("model budget provider rejection is invalid");
  }
  if (
    input.state === "charged_unknown" &&
    (input.provedInputTokens !== null ||
      input.provedOutputTokens !== null ||
      input.provedTotalTokens !== null ||
      !UNKNOWN_FAILURE_CLASSES.has(input.failureClass))
  ) {
    throw new Error("model budget unknown charge is invalid");
  }
  return input;
}

export function createModelBudgetLedger(database) {
  if (database === null || typeof database?.query !== "function") {
    throw new Error("model budget database is invalid");
  }
  return {
    async recover() {
      try {
        const result = await database.query(
          "SELECT * FROM codeops.charge_stale_session_model_budget_reservations()",
        );
        const row = result.rows[0];
        if (!row || result.rows.length !== 1) {
          throw new Error("model budget recovery result is invalid");
        }
        return {
          chargedReservations: parseCount(
            row.charged_reservations,
            "charged reservations",
          ),
        };
      } catch (error) {
        throw translateDatabaseError(error);
      }
    },

    async reserve(rawInput) {
      const input = reservationInput(rawInput);
      try {
        const result = await database.query(
          `SELECT * FROM codeops.reserve_session_model_budget(
            $1::uuid, $2::text, $3::text, $4::text, $5::bigint,
            $6::text, $7::text, $8::text, $9::bigint, $10::bigint
          )`,
          [
            input.reservationId,
            input.modelTokenId,
            input.sessionId,
            input.budgetId,
            input.generation,
            input.provider,
            input.model,
            input.reasoningEffort,
            input.requestedOutputTokens,
            input.reservedOutputTokens,
          ],
        );
        const row = result.rows[0];
        if (!row || result.rows.length !== 1) {
          throw new Error("model budget reservation result is invalid");
        }
        return {
          reservationId: row.reservation_id,
          reservedOutputTokens: parseCount(
            row.reserved_output_tokens,
            "reserved output tokens",
          ),
          remainingProviderRequests: parseCount(
            row.remaining_provider_requests,
            "remaining provider requests",
          ),
          remainingOutputTokens: parseCount(
            row.remaining_output_tokens,
            "remaining output tokens",
          ),
          budgetRevision: parseCount(row.budget_revision, "revision"),
        };
      } catch (error) {
        throw translateDatabaseError(error);
      }
    },

    async settle(rawInput) {
      const input = settlementInput(rawInput);
      try {
        const result = await database.query(
          `SELECT * FROM codeops.settle_session_model_budget(
            $1::uuid, $2::text, $3::text, $4::bigint,
            $5::bigint, $6::bigint, $7::text
          )`,
          [
            input.reservationId,
            input.state,
            input.providerRequestId,
            input.provedInputTokens,
            input.provedOutputTokens,
            input.provedTotalTokens,
            input.failureClass,
          ],
        );
        const row = result.rows[0];
        if (!row || result.rows.length !== 1) {
          throw new Error("model budget settlement result is invalid");
        }
        return {
          reservationId: row.reservation_id,
          state: row.state,
          chargedOutputTokens: parseCount(
            row.charged_output_tokens,
            "charged output tokens",
          ),
          remainingOutputTokens: parseCount(
            row.remaining_output_tokens,
            "remaining output tokens",
          ),
          budgetRevision: parseCount(row.budget_revision, "revision"),
        };
      } catch (error) {
        throw translateDatabaseError(error);
      }
    },
  };
}
