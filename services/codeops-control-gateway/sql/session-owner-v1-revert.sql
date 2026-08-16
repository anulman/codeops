BEGIN;

DROP TRIGGER sessions_owner_immutable ON codeops.sessions;
DROP FUNCTION codeops.reject_session_owner_update();
DROP INDEX codeops.sessions_owner_updated_idx;

ALTER TABLE codeops.sessions
  DROP CONSTRAINT sessions_owner_principal_id_check,
  DROP COLUMN owner_principal_id;

DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'session-owner-v1';

COMMIT;
