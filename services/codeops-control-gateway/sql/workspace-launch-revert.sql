BEGIN;
DROP TABLE IF EXISTS codeops.workspace_launches;
DROP FUNCTION IF EXISTS codeops.reject_workspace_launch_identity_update();
COMMIT;
