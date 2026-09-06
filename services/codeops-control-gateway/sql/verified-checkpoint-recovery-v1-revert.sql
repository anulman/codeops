BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.workspace_checkpoint_descriptors LIMIT 1) THEN
    RAISE EXCEPTION 'cannot revert verified checkpoint recovery while durable evidence exists';
  END IF;
END;
$$;

DROP TABLE codeops.workspace_checkpoint_cleanup_decisions;
DROP TABLE codeops.workspace_checkpoint_retention_decisions;
DROP TABLE codeops.workspace_checkpoint_hold_events;
DROP TABLE codeops.workspace_checkpoint_restore_receipts;
DROP TABLE codeops.workspace_checkpoint_restore_operations;
DROP TABLE codeops.workspace_checkpoint_descriptors;
ALTER TABLE codeops.session_runtime_job_progress
  DROP COLUMN resource_configuration_digest;
DROP TRIGGER workspace_checkpoint_artifacts_append_only
  ON codeops.workspace_checkpoint_artifacts;
DROP FUNCTION codeops.reject_verified_checkpoint_evidence_update();
DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'verified-checkpoint-recovery-v1';

COMMIT;
