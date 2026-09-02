BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.provider_effect_receipts) OR EXISTS (
    SELECT 1
      FROM codeops.session_runtime_permission_requests
     WHERE operation_provider IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot revert runtime permission consumption after authority activation';
  END IF;
END;
$$;

ALTER TABLE codeops.provider_effect_receipts
  DROP CONSTRAINT provider_effect_receipts_exact_permission_fk,
  DROP CONSTRAINT provider_effect_receipts_permission_key,
  DROP CONSTRAINT provider_effect_receipts_authorization_expiry_check,
  DROP CONSTRAINT provider_effect_receipts_legacy_authority_shape_check,
  DROP CONSTRAINT provider_effect_receipts_state_shape_v2_check,
  DROP CONSTRAINT provider_effect_receipts_resolution_time_v2_check,
  DROP CONSTRAINT provider_effect_receipts_state_v2_check,
  DROP COLUMN provider_effect_marker,
  DROP COLUMN legacy_non_replayable,
  DROP COLUMN dispatch_claim_token,
  DROP COLUMN authorization_expires_at,
  DROP COLUMN session_lease_id,
  DROP COLUMN session_generation,
  DROP COLUMN admission_id,
  DROP COLUMN permission_request_id;

ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_state_v1_revert_check CHECK (state IN (
    'authorized', 'attempting', 'succeeded', 'failed', 'unknown',
    'reconciled_satisfied', 'reconciled_not_observed', 'operator_resolved'
  )),
  ADD CONSTRAINT provider_effect_receipts_resolution_time_v1_revert_check CHECK (
    resolved_at IS NULL OR (attempted_at IS NOT NULL AND resolved_at >= attempted_at)
  ),
  ADD CONSTRAINT provider_effect_receipts_state_shape_v1_revert_check CHECK (
    (state = 'authorized' AND attempted_at IS NULL AND resolved_at IS NULL) OR
    (state IN ('attempting', 'unknown') AND attempted_at IS NOT NULL
      AND resolved_at IS NULL) OR
    (state IN ('succeeded', 'failed', 'reconciled_satisfied',
      'reconciled_not_observed', 'operator_resolved') AND attempted_at IS NOT NULL
      AND resolved_at IS NOT NULL AND resolution_summary IS NOT NULL)
  );

DROP INDEX codeops.session_runtime_permission_requests_operation_key;
ALTER TABLE codeops.session_runtime_permission_requests
  DROP CONSTRAINT session_runtime_permission_requests_consumption_key,
  DROP CONSTRAINT session_runtime_permission_requests_admission_fk,
  DROP CONSTRAINT session_runtime_permission_requests_generation_check,
  DROP CONSTRAINT session_runtime_permission_requests_operation_id_check,
  DROP CONSTRAINT session_runtime_permission_requests_consumption_shape_check,
  DROP COLUMN legacy_non_replayable,
  DROP COLUMN operation_id,
  DROP COLUMN operation_provider,
  DROP COLUMN session_lease_id,
  DROP COLUMN session_generation,
  DROP COLUMN admission_id;

DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'runtime-permission-consumption-v1';

COMMIT;
