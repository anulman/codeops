BEGIN;

-- Every producer of runtime-binding evidence must stop before the guard reads
-- any of them. Keep this order identical in every rollback path so concurrent
-- claims, session initialization, and workspace launch binding cannot deadlock
-- each other or commit between the guard and the destructive ALTER statements.
LOCK TABLE codeops.workspace_launches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE codeops.sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE codeops.session_runtime_outbox IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.session_runtime_outbox WHERE runtime_binding_json IS NOT NULL) OR
     EXISTS (SELECT 1 FROM codeops.workspace_launches WHERE runtime_launch_binding_json IS NOT NULL) OR
     EXISTS (SELECT 1 FROM codeops.sessions WHERE runtime_launch_binding_json IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot revert runtime compatible substitution while runtime-binding evidence exists';
  END IF;
END;
$$;

ALTER TABLE codeops.session_runtime_outbox
  DROP CONSTRAINT session_runtime_outbox_binding_complete;
DROP TRIGGER session_runtime_outbox_bound_claim_protocol ON codeops.session_runtime_outbox;
DROP FUNCTION codeops.require_runtime_bound_claim_protocol();
DROP FUNCTION codeops.session_runtime_owner_binding(text);
ALTER TABLE codeops.session_runtime_outbox
  DROP COLUMN runtime_capability_digest,
  DROP COLUMN runtime_release_digest,
  DROP COLUMN runtime_profile_id,
  DROP COLUMN runtime_requirement_digest,
  DROP COLUMN runtime_claim_protocol,
  DROP COLUMN runtime_binding_revision,
  DROP COLUMN runtime_binding_json;
DROP TRIGGER session_runtime_owner_immutable ON codeops.sessions;
DROP FUNCTION codeops.reject_session_runtime_owner_update();
DROP TRIGGER session_legacy_runtime_migration_only ON codeops.sessions;
DROP FUNCTION codeops.reject_new_legacy_runtime_session();
ALTER TABLE codeops.sessions
  DROP CONSTRAINT session_runtime_owner_binding_complete,
  DROP COLUMN legacy_runtime_worker_compatible,
  DROP COLUMN runtime_launch_binding_json,
  DROP COLUMN runtime_requirement_digest,
  DROP COLUMN runtime_requirements_json;
DROP TRIGGER workspace_runtime_identity_immutable ON codeops.workspace_launches;
DROP FUNCTION codeops.reject_workspace_runtime_identity_update();
DROP TRIGGER workspace_legacy_runtime_migration_only ON codeops.workspace_launches;
DROP FUNCTION codeops.reject_new_workspace_legacy_runtime_compatibility();
-- Remove every document field unknown to the old strict parser together with
-- its mirrored columns. The opening guard proves no selected launch binding
-- can be discarded. ACCESS EXCLUSIVE locking from ALTER TABLE prevents any
-- concurrent launch update while the terminal immutability trigger is off;
-- the trigger is restored before the transaction can release that lock.
ALTER TABLE codeops.workspace_launches
  DISABLE TRIGGER workspace_launch_identity_immutable;
UPDATE codeops.workspace_launches
   SET launch_json = launch_json
         - 'legacyRuntimeCompatible'
         - 'runtimeRequirements'
         - 'runtimeRequirementDigest'
         - 'runtimeLaunchBinding',
       legacy_runtime_compatible = false,
       runtime_requirements_json = NULL,
       runtime_requirement_digest = NULL,
       runtime_launch_binding_json = NULL
 WHERE launch_json ?| ARRAY[
   'legacyRuntimeCompatible',
   'runtimeRequirements',
   'runtimeRequirementDigest',
   'runtimeLaunchBinding'
 ];
ALTER TABLE codeops.workspace_launches
  ENABLE TRIGGER workspace_launch_identity_immutable;
ALTER TABLE codeops.workspace_launches
  DROP CONSTRAINT workspace_launch_legacy_runtime_marker,
  DROP CONSTRAINT workspace_launch_runtime_binding_complete,
  DROP CONSTRAINT workspace_launch_runtime_requirements_complete,
  DROP COLUMN legacy_runtime_compatible,
  DROP COLUMN runtime_launch_binding_json,
  DROP COLUMN runtime_requirement_digest,
  DROP COLUMN runtime_requirements_json;
DELETE FROM codeops.schema_migrations WHERE migration_name = 'runtime-compatible-substitution-v1';

COMMIT;
