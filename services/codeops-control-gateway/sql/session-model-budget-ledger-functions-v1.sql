BEGIN;

CREATE FUNCTION codeops.reserve_session_model_budget(
  requested_reservation_id uuid,
  requested_model_token_id text,
  requested_session_id text,
  requested_budget_id text,
  requested_generation bigint,
  requested_provider text,
  requested_model text,
  requested_reasoning_effort text,
  requested_output_tokens bigint,
  requested_reserved_output_tokens bigint
)
RETURNS TABLE (
  reservation_id uuid,
  reserved_output_tokens bigint,
  remaining_provider_requests bigint,
  remaining_output_tokens bigint,
  budget_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, codeops
AS $function$
DECLARE
  locked_budget codeops.session_model_budgets%ROWTYPE;
  existing_reservation codeops.session_model_budget_reservations%ROWTYPE;
  live_generation bigint;
BEGIN
  IF requested_model_token_id !~ '^sha256:[0-9a-f]{64}$' OR
     requested_generation < 1 OR
     requested_provider <> 'openai' OR
     requested_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
     requested_reasoning_effort NOT IN ('none', 'low', 'medium', 'high', 'xhigh') OR
     requested_output_tokens < 1 OR
     requested_reserved_output_tokens < 1 OR
     requested_reserved_output_tokens > requested_output_tokens THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_REQUEST_INVALID';
  END IF;

  SELECT budgets.*
    INTO locked_budget
    FROM codeops.session_model_budgets AS budgets
   WHERE budgets.session_id = requested_session_id
     AND budgets.budget_id = requested_budget_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
  END IF;

  SELECT reservations.*
    INTO existing_reservation
    FROM codeops.session_model_budget_reservations AS reservations
   WHERE reservations.reservation_id = requested_reservation_id
   FOR UPDATE;
  IF FOUND THEN
    IF existing_reservation.model_token_id <> requested_model_token_id OR
       existing_reservation.session_id <> requested_session_id OR
       existing_reservation.budget_id <> requested_budget_id OR
       existing_reservation.generation <> requested_generation OR
       existing_reservation.provider <> requested_provider OR
       existing_reservation.model <> requested_model OR
       existing_reservation.reasoning_effort <> requested_reasoning_effort OR
       existing_reservation.requested_output_tokens <> requested_output_tokens OR
       existing_reservation.reserved_output_tokens <> requested_reserved_output_tokens OR
       existing_reservation.state <> 'reserved' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'CODEOPS_MODEL_BUDGET_RESERVATION_CONFLICT';
    END IF;
    RETURN QUERY SELECT
      existing_reservation.reservation_id,
      existing_reservation.reserved_output_tokens,
      locked_budget.provider_requests_limit - locked_budget.committed_provider_requests,
      locked_budget.output_tokens_limit - locked_budget.settled_output_tokens -
        locked_budget.reserved_output_tokens,
      locked_budget.revision;
    RETURN;
  END IF;

  SELECT (sessions.snapshot_json->>'generation')::bigint
    INTO live_generation
    FROM codeops.sessions AS sessions
   WHERE sessions.session_id = requested_session_id;
  IF live_generation IS DISTINCT FROM requested_generation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
  END IF;
  IF locked_budget.committed_provider_requests >=
     locked_budget.provider_requests_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_EXHAUSTED:provider_requests';
  END IF;
  IF locked_budget.settled_output_tokens + locked_budget.reserved_output_tokens +
     requested_reserved_output_tokens > locked_budget.output_tokens_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_EXHAUSTED:output_tokens';
  END IF;

  INSERT INTO codeops.session_model_budget_reservations (
    reservation_id,
    model_token_id,
    session_id,
    budget_id,
    generation,
    provider,
    model,
    reasoning_effort,
    requested_output_tokens,
    reserved_output_tokens,
    state,
    reserved_at
  ) VALUES (
    requested_reservation_id,
    requested_model_token_id,
    requested_session_id,
    requested_budget_id,
    requested_generation,
    requested_provider,
    requested_model,
    requested_reasoning_effort,
    requested_output_tokens,
    requested_reserved_output_tokens,
    'reserved',
    clock_timestamp()
  );

  UPDATE codeops.session_model_budgets AS budgets
     SET committed_provider_requests = budgets.committed_provider_requests + 1,
         reserved_output_tokens = budgets.reserved_output_tokens +
           requested_reserved_output_tokens,
         revision = budgets.revision + 1,
         updated_at = clock_timestamp()
   WHERE budgets.session_id = requested_session_id
     AND budgets.budget_id = requested_budget_id
  RETURNING budgets.* INTO locked_budget;

  RETURN QUERY SELECT
    requested_reservation_id,
    requested_reserved_output_tokens,
    locked_budget.provider_requests_limit - locked_budget.committed_provider_requests,
    locked_budget.output_tokens_limit - locked_budget.settled_output_tokens -
      locked_budget.reserved_output_tokens,
    locked_budget.revision;
END;
$function$;

CREATE FUNCTION codeops.settle_session_model_budget(
  requested_reservation_id uuid,
  requested_state text,
  requested_provider_request_id text,
  requested_proved_input_tokens bigint,
  requested_proved_output_tokens bigint,
  requested_proved_total_tokens bigint,
  requested_failure_class text
)
RETURNS TABLE (
  reservation_id uuid,
  state text,
  charged_output_tokens bigint,
  remaining_output_tokens bigint,
  budget_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, codeops
AS $function$
DECLARE
  discovered_reservation codeops.session_model_budget_reservations%ROWTYPE;
  locked_reservation codeops.session_model_budget_reservations%ROWTYPE;
  locked_budget codeops.session_model_budgets%ROWTYPE;
  output_charge bigint;
BEGIN
  IF requested_state NOT IN ('settled', 'provider_rejected', 'charged_unknown') OR
     (requested_provider_request_id IS NOT NULL AND
       requested_provider_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$') OR
     (requested_state = 'settled' AND (
       requested_proved_input_tokens IS NULL OR requested_proved_input_tokens < 0 OR
       requested_proved_output_tokens IS NULL OR requested_proved_output_tokens < 0 OR
       requested_proved_total_tokens IS NULL OR
       requested_proved_total_tokens <> requested_proved_input_tokens +
         requested_proved_output_tokens OR
       requested_failure_class IS NOT NULL
     )) OR
     (requested_state = 'provider_rejected' AND (
       requested_proved_input_tokens IS NOT NULL OR
       requested_proved_output_tokens IS NOT NULL OR
       requested_proved_total_tokens IS NOT NULL OR
       requested_failure_class <> 'provider_rejected'
     )) OR
     (requested_state = 'charged_unknown' AND (
       requested_proved_input_tokens IS NOT NULL OR
       requested_proved_output_tokens IS NOT NULL OR
       requested_proved_total_tokens IS NOT NULL OR
       requested_failure_class NOT IN (
         'transport', 'timeout', 'truncated_stream', 'missing_terminal_usage',
         'invalid_terminal_usage', 'proxy_stopped'
       )
     )) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_SETTLEMENT_INVALID';
  END IF;

  SELECT reservations.*
    INTO discovered_reservation
    FROM codeops.session_model_budget_reservations AS reservations
   WHERE reservations.reservation_id = requested_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_RESERVATION_NOT_FOUND';
  END IF;

  SELECT budgets.*
    INTO locked_budget
    FROM codeops.session_model_budgets AS budgets
   WHERE budgets.session_id = discovered_reservation.session_id
     AND budgets.budget_id = discovered_reservation.budget_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
  END IF;

  SELECT reservations.*
    INTO locked_reservation
    FROM codeops.session_model_budget_reservations AS reservations
   WHERE reservations.reservation_id = requested_reservation_id
     AND reservations.session_id = locked_budget.session_id
     AND reservations.budget_id = locked_budget.budget_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
  END IF;

  IF locked_reservation.state <> 'reserved' THEN
    IF locked_reservation.state = requested_state AND
       locked_reservation.provider_request_id IS NOT DISTINCT FROM
         requested_provider_request_id AND
       locked_reservation.proved_input_tokens IS NOT DISTINCT FROM
         requested_proved_input_tokens AND
       locked_reservation.proved_output_tokens IS NOT DISTINCT FROM
         requested_proved_output_tokens AND
       locked_reservation.proved_total_tokens IS NOT DISTINCT FROM
         requested_proved_total_tokens AND
       locked_reservation.failure_class IS NOT DISTINCT FROM
         requested_failure_class THEN
      output_charge := CASE locked_reservation.state
        WHEN 'settled' THEN locked_reservation.proved_output_tokens
        WHEN 'charged_unknown' THEN locked_reservation.reserved_output_tokens
        ELSE 0
      END;
      RETURN QUERY SELECT
        locked_reservation.reservation_id,
        locked_reservation.state,
        output_charge,
        locked_budget.output_tokens_limit - locked_budget.settled_output_tokens -
          locked_budget.reserved_output_tokens,
        locked_budget.revision;
      RETURN;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_SETTLEMENT_CONFLICT';
  END IF;

  IF requested_state = 'settled' AND
     requested_proved_output_tokens > locked_reservation.reserved_output_tokens THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_SETTLEMENT_INVALID';
  END IF;

  output_charge := CASE requested_state
    WHEN 'settled' THEN requested_proved_output_tokens
    WHEN 'charged_unknown' THEN locked_reservation.reserved_output_tokens
    ELSE 0
  END;

  UPDATE codeops.session_model_budget_reservations AS reservations
     SET state = requested_state,
         provider_request_id = requested_provider_request_id,
         proved_input_tokens = requested_proved_input_tokens,
         proved_output_tokens = requested_proved_output_tokens,
         proved_total_tokens = requested_proved_total_tokens,
         failure_class = requested_failure_class,
         settled_at = clock_timestamp()
   WHERE reservations.reservation_id = requested_reservation_id;

  UPDATE codeops.session_model_budgets AS budgets
     SET reserved_output_tokens = budgets.reserved_output_tokens -
           locked_reservation.reserved_output_tokens,
         settled_output_tokens = budgets.settled_output_tokens + output_charge,
         observed_input_tokens = budgets.observed_input_tokens +
           CASE WHEN requested_state = 'settled'
             THEN requested_proved_input_tokens ELSE 0 END,
         observed_total_tokens = budgets.observed_total_tokens +
           CASE WHEN requested_state = 'settled'
             THEN requested_proved_total_tokens ELSE 0 END,
         revision = budgets.revision + 1,
         updated_at = clock_timestamp()
   WHERE budgets.session_id = locked_budget.session_id
     AND budgets.budget_id = locked_budget.budget_id
  RETURNING budgets.* INTO locked_budget;

  RETURN QUERY SELECT
    requested_reservation_id,
    requested_state,
    output_charge,
    locked_budget.output_tokens_limit - locked_budget.settled_output_tokens -
      locked_budget.reserved_output_tokens,
    locked_budget.revision;
END;
$function$;

REVOKE ALL ON FUNCTION codeops.reserve_session_model_budget(
  uuid, text, text, text, bigint, text, text, text, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION codeops.settle_session_model_budget(
  uuid, text, text, bigint, bigint, bigint, text
) FROM PUBLIC;

COMMIT;
