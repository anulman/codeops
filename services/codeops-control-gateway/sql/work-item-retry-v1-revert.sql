BEGIN;

CREATE OR REPLACE FUNCTION codeops.require_admitted_child_materialization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM codeops.admitted_child_materializations
                  WHERE admission_id=NEW.admission_id) THEN
    RAISE EXCEPTION 'work-item admission requires a materialization owner';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE codeops.workspace_launches
  DROP CONSTRAINT workspace_launch_retry_disposition_fk,
  DROP CONSTRAINT workspace_launch_retry_shape_check,
  DROP COLUMN retry_disposition_id,
  DROP COLUMN retry_runtime_release;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.work_item_admissions WHERE attempt > 1) OR
     EXISTS (SELECT 1 FROM codeops.work_item_retry_dispositions) THEN
    RAISE EXCEPTION 'cannot revert work-item retry while retry authority exists';
  END IF;
END;
$$;

DROP TRIGGER session_runtime_outbox_retry_completion_fence
  ON codeops.session_runtime_outbox;
DROP FUNCTION codeops.revalidate_work_item_retry_completion();
ALTER TABLE codeops.session_runtime_outbox
  DROP CONSTRAINT IF EXISTS session_runtime_outbox_initial_dispatch_marker,
  DROP COLUMN retry_disposition_id;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='codeops'
       AND table_name='session_runtime_outbox'
       AND column_name='is_admitted_initial_dispatch'
  ) THEN
    ALTER TABLE codeops.session_runtime_outbox
      ADD CONSTRAINT session_runtime_outbox_initial_dispatch_marker
        CHECK (is_admitted_initial_dispatch = (admission_id IS NOT NULL));
  END IF;
END;
$$;
ALTER TABLE codeops.work_item_admissions
  DROP CONSTRAINT work_item_admissions_retry_disposition_fk;
DROP TRIGGER work_item_retry_dispositions_immutable ON codeops.work_item_retry_dispositions;
DROP FUNCTION codeops.reject_work_item_retry_disposition_mutation();
DROP TABLE codeops.work_item_retry_dispositions;
DROP TRIGGER work_item_admissions_default_root ON codeops.work_item_admissions;
DROP FUNCTION codeops.default_work_item_root_admission();
ALTER TABLE codeops.provider_effect_receipts
  DROP CONSTRAINT provider_effect_receipts_failure_shape_check,
  DROP CONSTRAINT provider_effect_receipts_failure_code_check,
  DROP COLUMN failure_code;
DROP INDEX codeops.work_item_admissions_initial_approval_work_item_idx;
DROP INDEX codeops.work_item_admissions_initial_work_item_idx;
DROP INDEX codeops.work_item_admissions_initial_workflow_run_idx;
ALTER TABLE codeops.work_item_admissions
  DROP CONSTRAINT work_item_admissions_retry_shape_check,
  DROP CONSTRAINT work_item_admissions_root_fk,
  DROP CONSTRAINT work_item_admissions_retry_owner_key,
  DROP CONSTRAINT work_item_admissions_root_attempt_key,
  DROP CONSTRAINT work_item_admissions_attempt_check,
  DROP COLUMN retry_disposition_id,
  DROP COLUMN attempt,
  DROP COLUMN root_admission_id,
  ADD UNIQUE (approval_id, repository, provider, workspace_id, project_id, work_item_id),
  ADD UNIQUE (repository, provider, workspace_id, project_id, work_item_id),
  ADD UNIQUE (workflow_id, run_id);
DELETE FROM codeops.schema_migrations WHERE migration_name = 'work-item-retry-v1';

COMMIT;
