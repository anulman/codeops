BEGIN;

CREATE OR REPLACE FUNCTION codeops.reserve_session_model_budget(
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
  snapshot jsonb;
  normal_requests bigint;
  threshold_at timestamptz;
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
  SELECT sessions.snapshot_json INTO snapshot FROM codeops.sessions AS sessions
    WHERE sessions.session_id = requested_session_id;
  IF snapshot#>>'{budget,limits,phase}' IS NOT NULL THEN
    IF snapshot#>>'{budget,limits,phase}' NOT IN
       ('plan', 'review', 'implementation', 'correction', 'explore', 'validate') OR
       (snapshot#>>'{budget,limits,providerRequests}')::bigint IS DISTINCT FROM
         locked_budget.provider_requests_limit THEN
      RAISE EXCEPTION 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
    END IF;
    normal_requests := greatest(0, locked_budget.provider_requests_limit - 20);
    -- Closeout is deterministic in the runtime. No model reservation may spend
    -- its reserve, including retries, parallel clients, and fresh proxy processes.
    IF locked_budget.committed_provider_requests >= ceil(normal_requests * 0.9) THEN
      RAISE EXCEPTION 'CODEOPS_MODEL_BUDGET_SIGNAL:closeout';
    END IF;
    IF locked_budget.committed_provider_requests >= ceil(normal_requests * 0.8) THEN
      SELECT reservations.reserved_at INTO threshold_at
        FROM codeops.session_model_budget_reservations AS reservations
       WHERE reservations.session_id = requested_session_id
         AND reservations.budget_id = requested_budget_id
       ORDER BY reservations.reserved_at, reservations.reservation_id
       OFFSET greatest(0, ceil(normal_requests * 0.8)::bigint - 1) LIMIT 1;
      IF threshold_at IS NULL OR
         (snapshot#>>'{checkpoint,createdAt}')::timestamptz IS NULL OR
         (snapshot#>>'{checkpoint,createdAt}')::timestamptz < threshold_at OR
         (snapshot#>>'{checkpoint,generation}')::bigint IS DISTINCT FROM requested_generation THEN
        RAISE EXCEPTION 'CODEOPS_MODEL_BUDGET_SIGNAL:checkpoint_required';
      END IF;
    END IF;
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

CREATE FUNCTION codeops.reserve_session_phase_model_budget(
  requested_reservation_id uuid, requested_model_token_id text,
  requested_session_id text, requested_budget_id text, requested_generation bigint,
  requested_lease_id uuid, requested_dispatch_id uuid, requested_claim_count bigint,
  requested_provider text, requested_model text, requested_reasoning_effort text,
  requested_output_tokens bigint, requested_reserved_output_tokens bigint
)
RETURNS TABLE (
  reservation_id uuid, reserved_output_tokens bigint,
  remaining_provider_requests bigint, remaining_output_tokens bigint,
  budget_revision bigint, phase text, budget_state text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, codeops
AS $function$
DECLARE
  reserved record;
  active_phase text;
  normal_requests bigint;
  used_requests bigint;
BEGIN
  -- This call retains the exact generation, lease, dispatch and claim fences.
  SELECT * INTO STRICT reserved FROM codeops.reserve_session_dispatch_model_budget(
    requested_reservation_id, requested_model_token_id, requested_session_id,
    requested_budget_id, requested_generation, requested_lease_id,
    requested_dispatch_id, requested_claim_count, requested_provider,
    requested_model, requested_reasoning_effort, requested_output_tokens,
    requested_reserved_output_tokens
  );
  SELECT session.snapshot_json#>>'{budget,limits,phase}',
         greatest(0, budgets.provider_requests_limit - 20), budgets.committed_provider_requests
    INTO active_phase, normal_requests, used_requests
    FROM codeops.sessions AS session JOIN codeops.session_model_budgets AS budgets
      ON budgets.session_id = session.session_id
   WHERE session.session_id = requested_session_id AND budgets.budget_id = requested_budget_id;
  RETURN QUERY SELECT reserved.reservation_id, reserved.reserved_output_tokens,
    reserved.remaining_provider_requests, reserved.remaining_output_tokens,
    reserved.budget_revision, active_phase,
    CASE WHEN active_phase IS NULL THEN 'normal'
         WHEN used_requests >= ceil(normal_requests * 0.9) THEN 'closeout'
         WHEN used_requests >= ceil(normal_requests * 0.8) THEN 'checkpoint_required'
         WHEN used_requests >= ceil(normal_requests * 0.6) THEN 'warning'
         ELSE 'normal' END;
END;
$function$;
REVOKE ALL ON FUNCTION codeops.reserve_session_phase_model_budget(
  uuid, text, text, text, bigint, uuid, uuid, bigint, text, text, text, bigint, bigint
) FROM PUBLIC;

COMMIT;
