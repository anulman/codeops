BEGIN;

ALTER TABLE codeops.work_item_admissions
  ADD COLUMN root_admission_id uuid,
  ADD COLUMN attempt smallint,
  ADD COLUMN retry_disposition_id uuid;

ALTER TABLE codeops.work_item_admissions
  DISABLE TRIGGER work_item_admissions_immutable;
UPDATE codeops.work_item_admissions
   SET root_admission_id = admission_id, attempt = 1;
ALTER TABLE codeops.work_item_admissions
  ENABLE TRIGGER work_item_admissions_immutable;

CREATE FUNCTION codeops.default_work_item_root_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_admission_id IS NULL THEN
    NEW.root_admission_id := NEW.admission_id;
    NEW.attempt := 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX work_item_admissions_initial_approval_work_item_idx
  ON codeops.work_item_admissions
    (approval_id, repository, provider, workspace_id, project_id, work_item_id)
  WHERE attempt = 1;
CREATE UNIQUE INDEX work_item_admissions_initial_work_item_idx
  ON codeops.work_item_admissions
    (repository, provider, workspace_id, project_id, work_item_id)
  WHERE attempt = 1;
CREATE UNIQUE INDEX work_item_admissions_initial_workflow_run_idx
  ON codeops.work_item_admissions(workflow_id, run_id)
  WHERE attempt = 1;
CREATE TRIGGER work_item_admissions_default_root
BEFORE INSERT ON codeops.work_item_admissions
FOR EACH ROW EXECUTE FUNCTION codeops.default_work_item_root_admission();

ALTER TABLE codeops.work_item_admissions
  ALTER COLUMN root_admission_id SET NOT NULL,
  ALTER COLUMN attempt SET NOT NULL,
  ADD CONSTRAINT work_item_admissions_attempt_check CHECK (attempt BETWEEN 1 AND 4),
  ADD CONSTRAINT work_item_admissions_root_attempt_key UNIQUE (root_admission_id, attempt),
  ADD CONSTRAINT work_item_admissions_retry_owner_key UNIQUE (admission_id, root_admission_id, attempt),
  ADD CONSTRAINT work_item_admissions_root_fk FOREIGN KEY (root_admission_id)
    REFERENCES codeops.work_item_admissions(admission_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT work_item_admissions_retry_shape_check CHECK (
    (attempt = 1 AND root_admission_id = admission_id AND retry_disposition_id IS NULL) OR
    (attempt > 1 AND root_admission_id <> admission_id AND retry_disposition_id IS NOT NULL)
  );

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'codeops.work_item_admissions'::regclass
       AND contype = 'u'
       AND (pg_get_constraintdef(oid) LIKE 'UNIQUE (approval_id, repository, provider, workspace_id, project_id, work_item_id)%'
         OR pg_get_constraintdef(oid) LIKE 'UNIQUE (repository, provider, workspace_id, project_id, work_item_id)%'
         OR pg_get_constraintdef(oid) LIKE 'UNIQUE (workflow_id, run_id)%')
  LOOP
    EXECUTE format('ALTER TABLE codeops.work_item_admissions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE codeops.provider_effect_receipts
  ADD COLUMN failure_code text;

UPDATE codeops.provider_effect_receipts
   SET failure_code = 'provider_no_effect'
 WHERE state = 'failed';

ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'rate_limited', 'provider_timeout', 'provider_unavailable',
      'transport_error', 'server_error', 'provider_no_effect'
    )
  ),
  ADD CONSTRAINT provider_effect_receipts_failure_shape_check CHECK (
    (state = 'failed') = (failure_code IS NOT NULL)
  );

CREATE TABLE codeops.work_item_retry_dispositions (
  disposition_id uuid PRIMARY KEY,
  root_admission_id uuid NOT NULL REFERENCES codeops.work_item_admissions(admission_id),
  lineage_revision bigint NOT NULL CHECK (lineage_revision > 0),
  predecessor_admission_id uuid NOT NULL REFERENCES codeops.work_item_admissions(admission_id),
  predecessor_session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  predecessor_generation bigint NOT NULL CHECK (predecessor_generation > 0),
  predecessor_lease_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'retry-same-input', 'recover-checkpoint', 'correct-candidate', 'replan',
    'wait-external', 'wait-human', 'reconcile-unknown-effect', 'stop-terminal'
  )),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  effect_state text NOT NULL CHECK (effect_state IN (
    'none', 'authorized', 'not_attempted', 'attempting', 'succeeded', 'failed',
    'unknown', 'reconciled_satisfied', 'reconciled_not_observed', 'operator_resolved'
  )),
  effect_id text REFERENCES codeops.provider_effect_receipts(effect_id),
  effect_receipt_digest text CHECK (effect_receipt_digest IS NULL OR effect_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  transient_failure_code text CHECK (transient_failure_code IS NULL OR transient_failure_code IN (
    'rate_limited', 'provider_timeout', 'provider_unavailable', 'transport_error', 'server_error'
  )),
  pre_effect_proof_digest text CHECK (pre_effect_proof_digest IS NULL OR pre_effect_proof_digest ~ '^sha256:[0-9a-f]{64}$'),
  terminal_event_id text NOT NULL REFERENCES codeops.session_events(event_id),
  successor_admission_id uuid UNIQUE,
  successor_session_id text UNIQUE REFERENCES codeops.sessions(session_id)
    DEFERRABLE INITIALLY DEFERRED,
  successor_dispatch_id uuid UNIQUE,
  successor_launch_id text UNIQUE,
  attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  authority_expires_at timestamptz NOT NULL,
  input_digest text CHECK (input_digest IS NULL OR input_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_digest text CHECK (candidate_digest IS NULL OR candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
  runtime_capability_digest text CHECK (runtime_capability_digest IS NULL OR runtime_capability_digest ~ '^sha256:[0-9a-f]{64}$'),
  runtime_release text CHECK (runtime_release IS NULL OR runtime_release ~ '^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$'),
  provider_requests_consumed bigint NOT NULL CHECK (provider_requests_consumed >= 0),
  output_tokens_consumed bigint NOT NULL CHECK (output_tokens_consumed >= 0),
  authority_digest text NOT NULL UNIQUE CHECK (authority_digest ~ '^sha256:[0-9a-f]{64}$'),
  authority_json jsonb NOT NULL,
  lifecycle_event_id text NOT NULL REFERENCES codeops.work_item_lifecycle_events(event_id),
  supervision_event_id text NOT NULL UNIQUE REFERENCES codeops.session_events(event_id),
  created_at timestamptz NOT NULL,
  UNIQUE (root_admission_id, lineage_revision),
  UNIQUE (predecessor_admission_id, successor_admission_id),
  CONSTRAINT work_item_retry_disposition_successor_key
    UNIQUE (disposition_id, successor_admission_id, root_admission_id, attempt),
  CONSTRAINT work_item_retry_outbox_key
    UNIQUE (disposition_id, successor_admission_id, successor_dispatch_id, successor_session_id),
  CONSTRAINT work_item_retry_launch_key
    UNIQUE (disposition_id, successor_launch_id, runtime_release),
  CHECK ((authority_json->>'dispositionId')::uuid = disposition_id),
  CHECK ((authority_json->>'rootAdmissionId')::uuid = root_admission_id),
  CHECK ((authority_json->>'lineageRevision')::bigint = lineage_revision),
  CHECK (authority_json->>'predecessorSessionId' = predecessor_session_id),
  CHECK (authority_json->>'kind' = kind),
  CHECK ((authority_json#>>'{authority,predecessorGeneration}')::bigint = predecessor_generation),
  CHECK ((authority_json#>>'{authority,predecessorLeaseId}')::uuid = predecessor_lease_id),
  CHECK ((authority_json#>>'{authority,expiresAt}')::timestamptz = authority_expires_at),
  CHECK ((authority_json->>'createdAt')::timestamptz = created_at),
  CHECK ((successor_admission_id IS NULL) = (successor_session_id IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (successor_dispatch_id IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (successor_launch_id IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (input_digest IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (candidate_digest IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (runtime_capability_digest IS NULL)),
  CHECK ((successor_admission_id IS NULL) = (runtime_release IS NULL)),
  CHECK ((effect_state = 'none') = (pre_effect_proof_digest IS NOT NULL)),
  CHECK ((effect_state = 'none') = (effect_id IS NULL)),
  CHECK ((effect_state = 'failed') = (transient_failure_code IS NOT NULL))
);

CREATE UNIQUE INDEX work_item_retry_successor_per_predecessor_idx
  ON codeops.work_item_retry_dispositions(predecessor_admission_id)
  WHERE successor_admission_id IS NOT NULL;

ALTER TABLE codeops.work_item_retry_dispositions
  ADD CONSTRAINT work_item_retry_successor_admission_fk
    FOREIGN KEY (successor_admission_id, root_admission_id, attempt)
    REFERENCES codeops.work_item_admissions(admission_id, root_admission_id, attempt)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE codeops.work_item_admissions
  ADD CONSTRAINT work_item_admissions_retry_disposition_fk
    FOREIGN KEY (retry_disposition_id, admission_id, root_admission_id, attempt)
    REFERENCES codeops.work_item_retry_dispositions
      (disposition_id, successor_admission_id, root_admission_id, attempt)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE codeops.session_runtime_outbox
  ADD COLUMN retry_disposition_id uuid,
  ADD CONSTRAINT session_runtime_outbox_retry_disposition_fk
    FOREIGN KEY (retry_disposition_id, admission_id, dispatch_id, session_id)
    REFERENCES codeops.work_item_retry_dispositions
      (disposition_id, successor_admission_id, successor_dispatch_id, successor_session_id),
  ADD CONSTRAINT session_runtime_outbox_retry_shape_check CHECK (
    retry_disposition_id IS NULL OR admission_id IS NOT NULL
  );

ALTER TABLE codeops.session_runtime_outbox
  DROP CONSTRAINT session_runtime_outbox_initial_dispatch_marker,
  ADD CONSTRAINT session_runtime_outbox_initial_dispatch_marker CHECK (
    is_admitted_initial_dispatch =
      (admission_id IS NOT NULL AND retry_disposition_id IS NULL)
  );

ALTER TABLE codeops.workspace_launches
  ADD COLUMN retry_disposition_id uuid UNIQUE,
  ADD COLUMN retry_runtime_release text CHECK (
    retry_runtime_release IS NULL OR
    retry_runtime_release ~ '^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT workspace_launch_retry_shape_check CHECK (
    (retry_disposition_id IS NULL) = (retry_runtime_release IS NULL) AND
    (retry_disposition_id IS NULL OR
     ((launch_json#>>'{retryRuntime,dispositionId}')::uuid = retry_disposition_id AND
      launch_json#>>'{retryRuntime,runtimeWorkerImage}' = retry_runtime_release))
  );

ALTER TABLE codeops.work_item_retry_dispositions
  ADD CONSTRAINT work_item_retry_successor_launch_fk
    FOREIGN KEY (successor_launch_id)
    REFERENCES codeops.workspace_launches(launch_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE codeops.workspace_launches
  ADD CONSTRAINT workspace_launch_retry_disposition_fk
    FOREIGN KEY (retry_disposition_id, launch_id, retry_runtime_release)
    REFERENCES codeops.work_item_retry_dispositions
      (disposition_id, successor_launch_id, runtime_release)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION codeops.require_admitted_child_materialization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM codeops.admitted_child_materializations
                  WHERE admission_id=NEW.admission_id) AND
     NOT EXISTS (SELECT 1 FROM codeops.workspace_launches launch
                  WHERE launch.retry_disposition_id=NEW.retry_disposition_id
                    AND launch.launch_json#>>'{retryRuntime,sessionId}'=NEW.child_session_id) THEN
    RAISE EXCEPTION 'work-item admission requires a materialization owner';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION codeops.revalidate_work_item_retry_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retry_disposition_id IS NULL OR OLD.status <> 'claimed' OR
     NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;
  IF OLD.claimed_at IS NULL OR OLD.claim_expires_at IS NULL OR
     NEW.completed_at IS NULL OR OLD.claimed_at >= (
       SELECT authority_expires_at
         FROM codeops.work_item_retry_dispositions
        WHERE disposition_id = OLD.retry_disposition_id
     ) OR OLD.claim_expires_at <= NEW.completed_at OR NOT EXISTS (
       SELECT 1
         FROM codeops.work_item_retry_dispositions retry
         JOIN codeops.work_item_admissions admission
           ON admission.admission_id = OLD.admission_id
         JOIN codeops.work_item_admissions root
           ON root.admission_id = retry.root_admission_id
        WHERE retry.disposition_id = OLD.retry_disposition_id
          AND retry.successor_admission_id = OLD.admission_id
          AND retry.successor_session_id = OLD.session_id
          AND retry.successor_dispatch_id = OLD.dispatch_id
          AND retry.attempt = admission.attempt
          AND retry.root_admission_id = admission.root_admission_id
          AND admission.root_admission_id = root.admission_id
          AND admission.repository = root.repository
          AND admission.provider = root.provider
          AND admission.workspace_id = root.workspace_id
          AND admission.project_id = root.project_id
          AND admission.work_item_id = root.work_item_id
          AND admission.workflow_id = root.workflow_id
          AND admission.run_id = root.run_id
          AND admission.source_sha = root.source_sha
          AND retry.authority_expires_at = root.admitted_at + interval '24 hours'
          AND retry.runtime_capability_digest =
                OLD.dispatch_json#>>'{retryAuthority,runtimeCapabilityDigest}'
          AND retry.runtime_release =
                OLD.dispatch_json#>>'{retryAuthority,runtimeRelease}'
          AND retry.input_digest = OLD.dispatch_json#>>'{retryAuthority,inputDigest}'
          AND retry.candidate_digest = OLD.dispatch_json#>>'{retryAuthority,candidateDigest}'
          AND retry.disposition_id::text =
                OLD.dispatch_json#>>'{retryAuthority,dispositionId}'
          AND retry.root_admission_id::text =
                OLD.dispatch_json#>>'{retryAuthority,rootAdmissionId}'
          AND retry.attempt::text = OLD.dispatch_json#>>'{retryAuthority,attempt}'
          AND retry.authority_expires_at =
                (OLD.dispatch_json#>>'{retryAuthority,expiresAt}')::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM codeops.work_item_retry_dispositions newer
             WHERE newer.root_admission_id = retry.root_admission_id
               AND newer.lineage_revision > retry.lineage_revision
          )
          AND NOT EXISTS (
            SELECT 1 FROM codeops.work_item_admissions newer_attempt
             WHERE newer_attempt.root_admission_id = retry.root_admission_id
               AND newer_attempt.attempt > retry.attempt
          )
          AND (
            (retry.effect_state = 'none' AND NOT EXISTS (
              SELECT 1 FROM codeops.provider_effect_receipts effect
               WHERE effect.admission_id = retry.predecessor_admission_id
            )) OR
            (retry.effect_state = 'failed' AND EXISTS (
              SELECT 1 FROM codeops.provider_effect_receipts effect
               WHERE effect.effect_id = retry.effect_id
                 AND effect.admission_id = retry.predecessor_admission_id
                 AND effect.state = 'failed'
                 AND effect.failure_code = retry.transient_failure_code
            ))
          )
          AND retry.provider_requests_consumed = (
            SELECT COALESCE(sum(b.committed_provider_requests),0)
              FROM codeops.work_item_admissions a
              JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
             WHERE a.root_admission_id=retry.root_admission_id
               AND a.attempt < retry.attempt
          )
          AND retry.output_tokens_consumed = (
            SELECT COALESCE(sum(b.settled_output_tokens+b.reserved_output_tokens),0)
              FROM codeops.work_item_admissions a
              JOIN codeops.session_model_budgets b ON b.session_id=a.child_session_id
             WHERE a.root_admission_id=retry.root_admission_id
               AND a.attempt < retry.attempt
          )
     ) THEN
    RAISE EXCEPTION 'work item retry completion authority drifted';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_runtime_outbox_retry_completion_fence
BEFORE UPDATE ON codeops.session_runtime_outbox
FOR EACH ROW EXECUTE FUNCTION codeops.revalidate_work_item_retry_completion();

CREATE FUNCTION codeops.reject_work_item_retry_disposition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work item retry dispositions are immutable'; END;
$$;
CREATE TRIGGER work_item_retry_dispositions_immutable
BEFORE UPDATE OR DELETE ON codeops.work_item_retry_dispositions
FOR EACH ROW EXECUTE FUNCTION codeops.reject_work_item_retry_disposition_mutation();

COMMIT;
