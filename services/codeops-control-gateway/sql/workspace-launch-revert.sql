BEGIN;
-- Stop launch writers before checking for evidence that this rollback cannot
-- represent. The guard is re-evaluated only after the write-blocking lock is
-- held, so a concurrent binding either commits first and blocks rollback or
-- waits until the table no longer exists.
LOCK TABLE codeops.workspace_launches IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM codeops.workspace_launches WHERE launch_json ? 'runtimeLaunchBinding') THEN
    RAISE EXCEPTION 'cannot revert workspace launch while runtime-binding evidence exists';
  END IF;
END $$;
DROP TABLE IF EXISTS codeops.workspace_launches;
DROP FUNCTION IF EXISTS codeops.reject_workspace_launch_identity_update();
COMMIT;
