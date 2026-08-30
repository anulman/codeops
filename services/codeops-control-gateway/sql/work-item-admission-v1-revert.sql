BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.work_item_admissions) THEN
    RAISE EXCEPTION 'cannot revert work-item admission while admitted work exists';
  END IF;
  IF EXISTS (SELECT 1 FROM codeops.project_plan_approvals) THEN
    RAISE EXCEPTION 'cannot revert work-item admission while project-plan approval authority exists';
  END IF;
END;
$$;

ALTER TABLE codeops.session_runtime_outbox DROP COLUMN admission_id;
DROP TRIGGER work_item_admissions_immutable ON codeops.work_item_admissions;
DROP FUNCTION codeops.reject_work_item_admission_mutation();
DROP TABLE codeops.work_item_admissions;
DROP TRIGGER project_plan_approvals_immutable ON codeops.project_plan_approvals;
DROP FUNCTION codeops.reject_project_plan_approval_mutation();
DROP TABLE codeops.project_plan_approvals;
ALTER TABLE codeops.session_commands
  DROP CONSTRAINT session_commands_admission_authority_key;
ALTER TABLE codeops.work_item_lifecycle_events
  DROP CONSTRAINT work_item_lifecycle_events_admission_owner_key;
ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_admission_authority_key;
ALTER TABLE codeops.session_runtime_permission_requests
  DROP CONSTRAINT session_runtime_permission_requests_admission_authority_key;
ALTER TABLE codeops.session_runtime_outbox
  DROP CONSTRAINT session_runtime_outbox_admission_authority_key;
DELETE FROM codeops.schema_migrations WHERE migration_name = 'work-item-admission-v1';

COMMIT;
