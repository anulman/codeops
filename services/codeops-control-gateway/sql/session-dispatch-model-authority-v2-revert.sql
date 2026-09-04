BEGIN;

DROP FUNCTION codeops.reserve_session_dispatch_model_budget(
  uuid, text, text, text, bigint, uuid, uuid, bigint,
  text, text, text, bigint, bigint
);

CREATE FUNCTION codeops.reserve_session_dispatch_model_budget(
  requested_reservation_id uuid,
  requested_model_token_id text,
  requested_session_id text,
  requested_budget_id text,
  requested_generation bigint,
  requested_lease_id uuid,
  requested_dispatch_id uuid,
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
BEGIN
  PERFORM 1
    FROM codeops.sessions AS session
    JOIN codeops.session_runtime_outbox AS outbox
      ON outbox.session_id = session.session_id
   WHERE session.session_id = requested_session_id
     AND (session.snapshot_json->>'generation')::bigint = requested_generation
     AND session.snapshot_json#>>'{lease,status}' = 'active'
     AND (session.snapshot_json#>>'{lease,generation}')::bigint = requested_generation
     AND (session.snapshot_json#>>'{lease,leaseId}')::uuid = requested_lease_id
     AND outbox.dispatch_id = requested_dispatch_id
     AND outbox.status = 'claimed'
     AND outbox.claim_expires_at > clock_timestamp()
     AND (outbox.dispatch_json#>>'{command,generation}')::bigint = requested_generation
     AND (outbox.dispatch_json#>>'{command,leaseId}')::uuid = requested_lease_id
     AND outbox.dispatch_json#>>'{command,type}' IN ('prompt', 'resume')
   FOR UPDATE OF session, outbox;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
  END IF;

  RETURN QUERY
  SELECT * FROM codeops.reserve_session_model_budget(
    requested_reservation_id,
    requested_model_token_id,
    requested_session_id,
    requested_budget_id,
    requested_generation,
    requested_provider,
    requested_model,
    requested_reasoning_effort,
    requested_output_tokens,
    requested_reserved_output_tokens
  );
END;
$function$;

REVOKE ALL ON FUNCTION codeops.reserve_session_dispatch_model_budget(
  uuid, text, text, text, bigint, uuid, uuid, text, text, text, bigint, bigint
) FROM PUBLIC;

COMMIT;
