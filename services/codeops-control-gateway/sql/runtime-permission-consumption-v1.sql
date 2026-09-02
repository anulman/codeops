BEGIN;

ALTER TABLE codeops.session_runtime_permission_requests
  ADD COLUMN admission_id uuid,
  ADD COLUMN session_generation bigint,
  ADD COLUMN session_lease_id uuid,
  ADD COLUMN operation_provider text,
  ADD COLUMN operation_id text,
  ADD COLUMN legacy_non_replayable boolean NOT NULL DEFAULT false;

UPDATE codeops.session_runtime_permission_requests AS permission
   SET admission_id = admission.admission_id,
       session_generation =
         (outbox.dispatch_json#>>'{command,generation}')::bigint,
       session_lease_id =
         (outbox.dispatch_json#>>'{command,leaseId}')::uuid,
       operation_provider = 'github',
       operation_id = permission.request_json->>'toolCallId'
  FROM codeops.session_runtime_outbox AS outbox
  JOIN codeops.work_item_admissions AS admission
    ON admission.admission_id = outbox.admission_id
   AND admission.child_dispatch_id = outbox.dispatch_id
   AND admission.child_session_id = outbox.session_id
 WHERE permission.dispatch_id = outbox.dispatch_id
   AND permission.session_id = outbox.session_id
   AND permission.request_json#>>'{request,operation,kind}' = 'github_mutation';

UPDATE codeops.session_runtime_permission_requests
   SET legacy_non_replayable = true
 WHERE request_json#>>'{request,operation,kind}' = 'github_mutation'
   AND admission_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT operation_provider, operation_id
      FROM codeops.session_runtime_permission_requests
     WHERE operation_provider IS NOT NULL AND NOT legacy_non_replayable
     GROUP BY operation_provider, operation_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'runtime permission backfill found a shared operation identity';
  END IF;
END;
$$;

ALTER TABLE codeops.session_runtime_permission_requests
  ADD CONSTRAINT session_runtime_permission_requests_consumption_shape_check
  CHECK (
    (request_json#>>'{request,operation,kind}' = 'github_mutation' AND
      ((NOT legacy_non_replayable AND admission_id IS NOT NULL AND
        session_generation IS NOT NULL AND session_lease_id IS NOT NULL AND
        operation_provider = 'github' AND operation_id IS NOT NULL) OR
       (legacy_non_replayable AND admission_id IS NULL AND
        session_generation IS NULL AND session_lease_id IS NULL AND
        operation_provider IS NULL AND operation_id IS NULL))) OR
    (request_json#>>'{request,operation,kind}' <> 'github_mutation' AND
      NOT legacy_non_replayable AND admission_id IS NULL AND
      session_generation IS NULL AND session_lease_id IS NULL AND
      operation_provider IS NULL AND operation_id IS NULL)
  ),
  ADD CONSTRAINT session_runtime_permission_requests_operation_id_check
  CHECK (operation_id IS NULL OR operation_id ~ '^githubmutation-[0-9a-f]{64}$'),
  ADD CONSTRAINT session_runtime_permission_requests_generation_check
  CHECK (session_generation IS NULL OR session_generation > 0),
  ADD CONSTRAINT session_runtime_permission_requests_admission_fk
  FOREIGN KEY (admission_id, dispatch_id, session_id)
  REFERENCES codeops.work_item_admissions
    (admission_id, child_dispatch_id, child_session_id),
  ADD CONSTRAINT session_runtime_permission_requests_consumption_key
  UNIQUE (dispatch_id, request_id, session_id, admission_id,
          session_generation, session_lease_id, operation_provider, operation_id);

CREATE UNIQUE INDEX session_runtime_permission_requests_operation_key
  ON codeops.session_runtime_permission_requests (operation_provider, operation_id)
  WHERE operation_provider IS NOT NULL;

ALTER TABLE codeops.provider_effect_receipts
  ADD COLUMN permission_request_id text,
  ADD COLUMN admission_id uuid,
  ADD COLUMN session_generation bigint,
  ADD COLUMN session_lease_id uuid,
  ADD COLUMN authorization_expires_at timestamptz,
  ADD COLUMN dispatch_claim_token uuid,
  ADD COLUMN legacy_non_replayable boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_effect_marker text GENERATED ALWAYS AS
    ('codeops-provider-effect:' || effect_id) STORED;

UPDATE codeops.provider_effect_receipts AS effect
   SET permission_request_id = permission.request_id,
       admission_id = permission.admission_id,
       session_generation = permission.session_generation,
       session_lease_id = permission.session_lease_id,
       authorization_expires_at = GREATEST(
         effect.authorized_at,
         LEAST(
           COALESCE(outbox.claim_expires_at, effect.authorized_at),
           (outbox.dispatch_json#>>'{snapshot,lease,expiresAt}')::timestamptz
         )
       ),
       dispatch_claim_token = outbox.claim_token
  FROM codeops.session_runtime_permission_requests AS permission
  JOIN codeops.session_runtime_outbox AS outbox
    ON outbox.dispatch_id = permission.dispatch_id
 WHERE permission.dispatch_id = effect.dispatch_id
   AND permission.session_id = effect.session_id
   AND permission.operation_provider = effect.provider
   AND permission.operation_id = effect.effect_id
   AND NOT permission.legacy_non_replayable;

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'codeops.provider_effect_receipts'::regclass
       AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%state = ANY%authorized%attempting%'
         OR pg_get_constraintdef(oid) LIKE $pattern$%state = 'authorized'%attempted_at%$pattern$
         OR pg_get_constraintdef(oid) LIKE '%resolved_at IS NULL%attempted_at IS NOT NULL%')
  LOOP
    EXECUTE format('ALTER TABLE codeops.provider_effect_receipts DROP CONSTRAINT %I',
                   constraint_row.conname);
  END LOOP;
END;
$$;

UPDATE codeops.provider_effect_receipts
   SET legacy_non_replayable = true,
       state = CASE WHEN attempted_at IS NULL
                    THEN 'not_attempted'
                    ELSE 'operator_resolved'
               END,
       resolution_summary =
         'Legacy authorization lacks durable admission evidence and is non-replayable.',
       reconciliation_action = 'none',
       resolved_at = COALESCE(resolved_at, attempted_at, updated_at, authorized_at),
       updated_at = GREATEST(
         updated_at,
         COALESCE(resolved_at, attempted_at, updated_at, authorized_at)
       )
 WHERE permission_request_id IS NULL;

ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_state_v2_check CHECK (state IN (
    'authorized', 'not_attempted', 'attempting', 'succeeded', 'failed',
    'unknown', 'reconciled_satisfied', 'reconciled_not_observed',
    'operator_resolved'
  )),
  ADD CONSTRAINT provider_effect_receipts_resolution_time_v2_check CHECK (
    resolved_at IS NULL OR
    (state = 'not_attempted' AND attempted_at IS NULL AND resolved_at >= authorized_at) OR
    (attempted_at IS NOT NULL AND resolved_at >= attempted_at)
  ),
  ADD CONSTRAINT provider_effect_receipts_state_shape_v2_check CHECK (
    (state = 'authorized' AND attempted_at IS NULL AND resolved_at IS NULL) OR
    (state = 'not_attempted' AND attempted_at IS NULL AND resolved_at IS NOT NULL
      AND resolution_summary IS NOT NULL) OR
    (state IN ('attempting', 'unknown') AND attempted_at IS NOT NULL
      AND resolved_at IS NULL) OR
    (state IN ('succeeded', 'failed', 'reconciled_satisfied',
      'reconciled_not_observed', 'operator_resolved') AND attempted_at IS NOT NULL
      AND resolved_at IS NOT NULL AND resolution_summary IS NOT NULL)
  );

ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_legacy_authority_shape_check CHECK (
    (NOT legacy_non_replayable AND permission_request_id IS NOT NULL AND
      admission_id IS NOT NULL AND session_generation IS NOT NULL AND
      session_lease_id IS NOT NULL AND authorization_expires_at IS NOT NULL) OR
    (legacy_non_replayable AND state IN ('not_attempted', 'operator_resolved') AND
      permission_request_id IS NULL AND admission_id IS NULL AND
      session_generation IS NULL AND session_lease_id IS NULL AND
      authorization_expires_at IS NULL AND dispatch_claim_token IS NULL)
  ),
  ADD CONSTRAINT provider_effect_receipts_authorization_expiry_check
  CHECK (authorization_expires_at IS NULL OR authorization_expires_at >= authorized_at),
  ADD CONSTRAINT provider_effect_receipts_permission_key
  UNIQUE (dispatch_id, permission_request_id),
  ADD CONSTRAINT provider_effect_receipts_exact_permission_fk
  FOREIGN KEY (dispatch_id, permission_request_id, session_id, admission_id,
               session_generation, session_lease_id, provider, effect_id)
  REFERENCES codeops.session_runtime_permission_requests
    (dispatch_id, request_id, session_id, admission_id,
     session_generation, session_lease_id, operation_provider, operation_id);

COMMIT;
