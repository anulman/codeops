BEGIN;

CREATE FUNCTION codeops.charge_stale_session_model_budget_reservations()
RETURNS TABLE (charged_reservations bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, codeops
AS $function$
DECLARE
  candidate record;
  locked_budget codeops.session_model_budgets%ROWTYPE;
  locked_reservation codeops.session_model_budget_reservations%ROWTYPE;
  charged bigint := 0;
BEGIN
  FOR candidate IN
    SELECT reservations.reservation_id,
           reservations.session_id,
           reservations.budget_id
      FROM codeops.session_model_budget_reservations AS reservations
     WHERE reservations.state = 'reserved'
       AND reservations.reserved_at <=
         clock_timestamp() - interval '15 minutes'
     ORDER BY reservations.session_id,
              reservations.reserved_at,
              reservations.reservation_id
  LOOP
    SELECT budgets.*
      INTO locked_budget
      FROM codeops.session_model_budgets AS budgets
     WHERE budgets.session_id = candidate.session_id
       AND budgets.budget_id = candidate.budget_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'CODEOPS_MODEL_BUDGET_AUTHORITY_INVALID';
    END IF;

    SELECT reservations.*
      INTO locked_reservation
      FROM codeops.session_model_budget_reservations AS reservations
     WHERE reservations.reservation_id = candidate.reservation_id
       AND reservations.session_id = locked_budget.session_id
       AND reservations.budget_id = locked_budget.budget_id
     FOR UPDATE;
    IF FOUND AND
       locked_reservation.state = 'reserved' AND
       locked_reservation.reserved_at <=
         clock_timestamp() - interval '15 minutes' THEN
      UPDATE codeops.session_model_budget_reservations AS reservations
         SET state = 'charged_unknown',
             failure_class = 'proxy_stopped',
             settled_at = clock_timestamp()
       WHERE reservations.reservation_id = locked_reservation.reservation_id;

      UPDATE codeops.session_model_budgets AS budgets
         SET reserved_output_tokens = budgets.reserved_output_tokens -
               locked_reservation.reserved_output_tokens,
             settled_output_tokens = budgets.settled_output_tokens +
               locked_reservation.reserved_output_tokens,
             revision = budgets.revision + 1,
             updated_at = clock_timestamp()
       WHERE budgets.session_id = locked_budget.session_id
         AND budgets.budget_id = locked_budget.budget_id;
      charged := charged + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT charged;
END;
$function$;

REVOKE ALL ON FUNCTION
  codeops.charge_stale_session_model_budget_reservations()
  FROM PUBLIC;

COMMIT;
