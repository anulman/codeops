BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM codeops.admitted_child_materializations) THEN
    RAISE EXCEPTION 'cannot revert admitted child materializations with durable rows';
  END IF;
END $$;
DROP TABLE codeops.admitted_child_materializations;
DROP TRIGGER work_item_admissions_require_materialization_owner
  ON codeops.work_item_admissions;
DROP FUNCTION codeops.require_admitted_child_materialization_owner();
DROP FUNCTION codeops.guard_admitted_child_materialization_update();
ALTER TABLE codeops.work_item_admissions
  DROP CONSTRAINT work_item_admissions_materialization_owner_key;
ALTER TABLE codeops.project_plan_approvals
  DROP CONSTRAINT project_plan_approvals_materialization_owner_key;
ALTER TABLE codeops.session_runtime_outbox
  DROP CONSTRAINT session_runtime_outbox_materialization_dispatch_key;
ALTER TABLE codeops.session_runtime_outbox DROP COLUMN dispatch_digest;
ALTER TABLE codeops.session_runtime_outbox DROP COLUMN is_admitted_initial_dispatch;
DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'admitted-child-materializations-v1';
COMMIT;
