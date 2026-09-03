BEGIN;

DROP FUNCTION IF EXISTS codeops.reserve_session_dispatch_model_budget(
  uuid, text, text, text, bigint, uuid, uuid, text, text, text, bigint, bigint
);
DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'session-dispatch-model-authority-v1';

COMMIT;
