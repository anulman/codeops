BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.workspace_retention_decisions LIMIT 1) THEN
    RAISE EXCEPTION 'cannot revert workspace retention while durable evidence exists';
  END IF;
END;
$$;
DROP TABLE codeops.workspace_cleanup_receipts;
DROP TABLE codeops.workspace_retention_decisions;
DELETE FROM codeops.schema_migrations WHERE migration_name = 'workspace-retention-v1';
COMMIT;
