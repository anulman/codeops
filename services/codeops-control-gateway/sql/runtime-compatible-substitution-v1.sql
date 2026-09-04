BEGIN;

ALTER TABLE codeops.workspace_launches
  ADD COLUMN legacy_runtime_compatible boolean NOT NULL DEFAULT false,
  ADD COLUMN runtime_requirements_json jsonb,
  ADD COLUMN runtime_requirement_digest text
    CHECK (runtime_requirement_digest IS NULL OR runtime_requirement_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_launch_binding_json jsonb,
  ADD CONSTRAINT workspace_launch_runtime_requirements_complete CHECK (
    (runtime_requirements_json IS NULL AND runtime_requirement_digest IS NULL)
    OR (runtime_requirements_json IS NOT NULL AND runtime_requirement_digest IS NOT NULL
      AND launch_json ? 'runtimeRequirements'
      AND jsonb_typeof(launch_json->'runtimeRequirements') = 'object'
      AND launch_json->'runtimeRequirements' IS NOT DISTINCT FROM runtime_requirements_json
      AND launch_json->>'runtimeRequirementDigest' = runtime_requirement_digest)
  ),
  ADD CONSTRAINT workspace_launch_runtime_binding_complete CHECK (
    (runtime_launch_binding_json IS NULL AND NOT (launch_json ? 'runtimeLaunchBinding'))
    OR (runtime_launch_binding_json IS NOT NULL
      AND launch_json ? 'runtimeLaunchBinding'
      AND jsonb_typeof(launch_json->'runtimeLaunchBinding') = 'object'
      AND launch_json->'runtimeLaunchBinding' IS NOT DISTINCT FROM runtime_launch_binding_json
      AND runtime_launch_binding_json->>'version' = 'codeops.runtime-launch-binding/v1'
      AND runtime_launch_binding_json->>'requirementDigest' = runtime_requirement_digest)
  );

-- Preserve only launches which were already eligible to provision when this
-- migration took its bounded compatibility snapshot. Later inserts default
-- to unmarked and cannot acquire this exception.
UPDATE codeops.workspace_launches
   SET legacy_runtime_compatible = true,
       launch_json = jsonb_set(
         launch_json,
         '{legacyRuntimeCompatible}',
         'true'::jsonb,
         true
       )
 WHERE state IN ('queued', 'provisioning');
ALTER TABLE codeops.workspace_launches
  ADD CONSTRAINT workspace_launch_legacy_runtime_marker CHECK (
    (legacy_runtime_compatible = true AND launch_json->>'legacyRuntimeCompatible' = 'true')
    OR (legacy_runtime_compatible = false AND
      COALESCE(launch_json->>'legacyRuntimeCompatible', 'false') = 'false')
  );

CREATE FUNCTION codeops.reject_new_workspace_legacy_runtime_compatibility()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_runtime_compatible = true OR
     NEW.launch_json->>'legacyRuntimeCompatible' = 'true' THEN
    RAISE EXCEPTION 'new workspace launches cannot use legacy runtime compatibility';
  END IF;
  IF NEW.runtime_requirements_json IS NULL OR
     NEW.runtime_requirement_digest IS NULL THEN
    RAISE EXCEPTION 'new workspace launches require complete runtime admission';
  END IF;
  IF NEW.state IN ('provisioning', 'ready') AND
     NEW.runtime_launch_binding_json IS NULL THEN
    RAISE EXCEPTION 'workspace provisioning requires a complete runtime launch binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_legacy_runtime_migration_only
  BEFORE INSERT ON codeops.workspace_launches
  FOR EACH ROW EXECUTE FUNCTION codeops.reject_new_workspace_legacy_runtime_compatibility();

CREATE FUNCTION codeops.reject_workspace_runtime_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_runtime_compatible IS DISTINCT FROM OLD.legacy_runtime_compatible THEN
    RAISE EXCEPTION 'workspace legacy runtime compatibility is migration-owned';
  END IF;
  IF NEW.state IN ('provisioning', 'ready') AND
     NEW.runtime_launch_binding_json IS NULL THEN
    RAISE EXCEPTION 'workspace provisioning requires a complete runtime launch binding';
  END IF;
  IF (OLD.runtime_requirements_json IS NOT NULL AND (
       NEW.runtime_requirements_json IS DISTINCT FROM OLD.runtime_requirements_json OR
       NEW.runtime_requirement_digest IS DISTINCT FROM OLD.runtime_requirement_digest)) OR
     (OLD.runtime_launch_binding_json IS NOT NULL AND
       (NEW.runtime_launch_binding_json IS DISTINCT FROM OLD.runtime_launch_binding_json OR
        NEW.launch_json->'runtimeLaunchBinding' IS DISTINCT FROM
          OLD.launch_json->'runtimeLaunchBinding')) THEN
    RAISE EXCEPTION 'workspace runtime requirements and launch binding are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_runtime_identity_immutable
  BEFORE UPDATE ON codeops.workspace_launches
  FOR EACH ROW EXECUTE FUNCTION codeops.reject_workspace_runtime_identity_update();

ALTER TABLE codeops.sessions
  ADD COLUMN runtime_requirements_json jsonb,
  ADD COLUMN runtime_requirement_digest text
    CHECK (runtime_requirement_digest IS NULL OR runtime_requirement_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_launch_binding_json jsonb,
  ADD COLUMN legacy_runtime_worker_compatible boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT session_runtime_owner_binding_complete CHECK (
    (runtime_requirements_json IS NULL AND runtime_requirement_digest IS NULL
      AND runtime_launch_binding_json IS NULL)
    OR (runtime_requirements_json IS NOT NULL AND runtime_requirement_digest IS NOT NULL
      AND runtime_launch_binding_json IS NOT NULL
      AND runtime_launch_binding_json->>'version' = 'codeops.runtime-launch-binding/v1'
      AND runtime_launch_binding_json->>'requirementDigest' = runtime_requirement_digest)
  );

-- Only sessions which were already active when this migration was applied may
-- use the bounded legacy-worker claim path. New sessions default fail closed.
UPDATE codeops.sessions
   SET legacy_runtime_worker_compatible = true
 WHERE snapshot_json->>'state' IN ('running', 'waiting_permission', 'checkpointing');

CREATE FUNCTION codeops.reject_new_legacy_runtime_session()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_runtime_worker_compatible = true THEN
    RAISE EXCEPTION 'new sessions cannot use legacy runtime worker compatibility';
  END IF;
  IF NEW.snapshot_json#>>'{identity,parentSessionId}' IS NULL AND
     NEW.runtime_launch_binding_json IS NULL AND
     NOT EXISTS (
       SELECT 1 FROM codeops.workspace_launches
        WHERE launch_id = NEW.snapshot_json#>>'{identity,runId}'
          AND runtime_launch_binding_json IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'new root sessions require a complete runtime launch binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_legacy_runtime_migration_only
  BEFORE INSERT ON codeops.sessions
  FOR EACH ROW EXECUTE FUNCTION codeops.reject_new_legacy_runtime_session();

CREATE FUNCTION codeops.reject_session_runtime_owner_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR
     NEW.snapshot_json->'identity' IS DISTINCT FROM OLD.snapshot_json->'identity' THEN
    RAISE EXCEPTION 'session lineage identity is immutable';
  END IF;
  IF OLD.runtime_launch_binding_json IS NOT NULL AND (
       NEW.runtime_requirements_json IS DISTINCT FROM OLD.runtime_requirements_json OR
       NEW.runtime_requirement_digest IS DISTINCT FROM OLD.runtime_requirement_digest OR
       NEW.runtime_launch_binding_json IS DISTINCT FROM OLD.runtime_launch_binding_json) THEN
    RAISE EXCEPTION 'session runtime owner binding is immutable';
  END IF;
  IF OLD.legacy_runtime_worker_compatible = false AND
     NEW.legacy_runtime_worker_compatible = true THEN
    RAISE EXCEPTION 'legacy runtime worker compatibility cannot be enabled after migration';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_runtime_owner_immutable
  BEFORE UPDATE ON codeops.sessions
  FOR EACH ROW EXECUTE FUNCTION codeops.reject_session_runtime_owner_update();

ALTER TABLE codeops.session_runtime_outbox
  ADD COLUMN runtime_binding_json jsonb,
  ADD COLUMN runtime_binding_revision bigint NOT NULL DEFAULT 0 CHECK (runtime_binding_revision >= 0),
  ADD COLUMN runtime_claim_protocol text
    CHECK (runtime_claim_protocol IS NULL OR runtime_claim_protocol IN ('legacy-unproven-v1', 'bound-v2')),
  ADD COLUMN runtime_requirement_digest text
    CHECK (runtime_requirement_digest IS NULL OR runtime_requirement_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_profile_id text,
  ADD COLUMN runtime_release_digest text
    CHECK (runtime_release_digest IS NULL OR runtime_release_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_capability_digest text
    CHECK (runtime_capability_digest IS NULL OR runtime_capability_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT session_runtime_outbox_binding_complete CHECK (
    (runtime_binding_json IS NULL AND runtime_binding_revision = 0 AND runtime_requirement_digest IS NULL AND runtime_profile_id IS NULL
      AND runtime_release_digest IS NULL AND runtime_capability_digest IS NULL
      AND (runtime_claim_protocol IS NULL OR runtime_claim_protocol = 'legacy-unproven-v1'))
    OR (runtime_binding_json IS NOT NULL AND runtime_binding_revision > 0 AND runtime_requirement_digest IS NOT NULL AND runtime_profile_id IS NOT NULL
      AND runtime_release_digest IS NOT NULL AND runtime_capability_digest IS NOT NULL
      AND runtime_claim_protocol = 'bound-v2'
      AND runtime_binding_json->>'version' = 'codeops.runtime-binding/v1'
      AND runtime_binding_json->>'requirementDigest' = runtime_requirement_digest
      AND runtime_binding_json->>'selectedProfileId' = runtime_profile_id
      AND runtime_binding_json->>'selectedReleaseDigest' = runtime_release_digest
      AND runtime_binding_json->>'selectedCapabilityDigest' = runtime_capability_digest
      AND runtime_binding_json#>>'{selectedProfile,profileId}' = runtime_profile_id
      AND runtime_binding_json#>>'{selectedProfile,releaseDigest}' = runtime_release_digest
      AND runtime_binding_json#>>'{selectedProfile,capabilityDigest}' = runtime_capability_digest)
  );

CREATE FUNCTION codeops.session_runtime_owner_binding(requested_session_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  WITH RECURSIVE lineage(session_id, parent_session_id, path, depth) AS (
    SELECT session_id, snapshot_json#>>'{identity,parentSessionId}',
           ARRAY[session_id], 0
      FROM codeops.sessions
     WHERE session_id = requested_session_id
    UNION ALL
    SELECT parent.session_id,
           parent.snapshot_json#>>'{identity,parentSessionId}',
           child.path || parent.session_id, child.depth + 1
      FROM codeops.sessions AS parent
      JOIN lineage AS child ON parent.session_id = child.parent_session_id
     WHERE child.depth < 64
       AND NOT parent.session_id = ANY(child.path)
  ), owner AS (
    SELECT root.runtime_requirements_json AS session_requirements,
           root.runtime_launch_binding_json AS session_binding,
           launch.runtime_requirements_json AS workspace_requirements,
           launch.runtime_launch_binding_json AS workspace_binding
      FROM lineage AS resolved
      JOIN codeops.sessions AS root ON root.session_id = resolved.session_id
      LEFT JOIN codeops.workspace_launches AS launch
        ON launch.launch_id = root.snapshot_json#>>'{identity,runId}'
     WHERE resolved.parent_session_id IS NULL
  ), selected AS (
    SELECT CASE
             WHEN workspace_binding IS NOT NULL AND session_binding IS NULL
               THEN workspace_binding
             WHEN workspace_binding IS NULL AND session_binding IS NOT NULL
               THEN session_binding
             ELSE NULL
           END AS launch_binding,
           CASE
             WHEN workspace_binding IS NOT NULL AND session_binding IS NULL
               THEN workspace_requirements
             WHEN workspace_binding IS NULL AND session_binding IS NOT NULL
               THEN session_requirements
             ELSE NULL
           END AS requirements
      FROM owner
  )
  SELECT CASE
           WHEN launch_binding IS NULL OR requirements IS NULL THEN NULL
           ELSE jsonb_build_object(
             'version', 'codeops.runtime-binding/v1',
             'requirementDigest', launch_binding->>'requirementDigest',
             'compatibilityPolicyRevision', requirements->>'compatibilityPolicyRevision',
             'selectedProfileId', launch_binding#>>'{profile,profileId}',
             'selectedReleaseDigest', launch_binding#>>'{profile,releaseDigest}',
             'selectedCapabilityDigest', launch_binding#>>'{profile,capabilityDigest}',
             'selectedProfile', launch_binding->'profile',
             'selectedAt', launch_binding->>'selectedAt'
           )
         END
    FROM selected
$$;

CREATE FUNCTION codeops.require_runtime_bound_claim_protocol()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An old gateway does not know this column. During the bounded upgrade
  -- window, convert only its exact claim transition for a migration-marked
  -- active session into explicit legacy proof.
  IF TG_OP = 'UPDATE' AND
     OLD.status IS DISTINCT FROM 'claimed' AND NEW.status = 'claimed' AND
     NEW.runtime_claim_protocol IS NULL AND NEW.runtime_binding_json IS NULL AND
     EXISTS (
       SELECT 1 FROM codeops.sessions
        WHERE session_id = NEW.session_id
          AND legacy_runtime_worker_compatible = true
     ) THEN
    NEW.runtime_claim_protocol := 'legacy-unproven-v1';
  END IF;
  IF NEW.runtime_claim_protocol = 'legacy-unproven-v1' AND
     NOT EXISTS (
       SELECT 1 FROM codeops.sessions
        WHERE session_id = NEW.session_id
          AND legacy_runtime_worker_compatible = true
     ) THEN
    RAISE EXCEPTION 'legacy v1 claim requires migration-retained session compatibility';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.runtime_binding_json IS NOT NULL AND (
       NEW.runtime_binding_json IS DISTINCT FROM OLD.runtime_binding_json OR
       NEW.runtime_requirement_digest IS DISTINCT FROM OLD.runtime_requirement_digest OR
       NEW.runtime_profile_id IS DISTINCT FROM OLD.runtime_profile_id OR
       NEW.runtime_release_digest IS DISTINCT FROM OLD.runtime_release_digest OR
       NEW.runtime_capability_digest IS DISTINCT FROM OLD.runtime_capability_digest OR
       NEW.runtime_claim_protocol IS DISTINCT FROM OLD.runtime_claim_protocol
     ) THEN
    RAISE EXCEPTION 'admitted runtime binding evidence is immutable';
  END IF;
  IF NEW.status = 'claimed' AND NOT (
       (NEW.runtime_claim_protocol = 'bound-v2' AND
        NEW.runtime_binding_json IS NOT NULL) OR
       (NEW.runtime_claim_protocol = 'legacy-unproven-v1' AND
        NEW.runtime_binding_json IS NULL AND
        EXISTS (
          SELECT 1 FROM codeops.sessions
           WHERE session_id = NEW.session_id
             AND legacy_runtime_worker_compatible = true
        ))) THEN
    RAISE EXCEPTION 'claimed runtime dispatch requires bound-v2 or migration-owned legacy proof';
  END IF;
  IF NEW.status = 'claimed' AND NEW.runtime_claim_protocol = 'bound-v2' AND
     NEW.runtime_binding_json IS DISTINCT FROM
       codeops.session_runtime_owner_binding(NEW.session_id) THEN
    RAISE EXCEPTION 'bound-v2 runtime claim does not match immutable root owner';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM 'claimed' AND NEW.status = 'claimed' AND
     NEW.claim_count <> OLD.claim_count + 1 THEN
    RAISE EXCEPTION 'claimed runtime dispatch requires one complete bound claim transition';
  END IF;
  IF NEW.claim_count = OLD.claim_count + 1 AND NOT (
       (NEW.runtime_claim_protocol = 'legacy-unproven-v1' AND
        NEW.runtime_binding_json IS NULL AND
        NEW.runtime_binding_revision = OLD.runtime_binding_revision) OR
       (NEW.runtime_claim_protocol = 'bound-v2' AND
        NEW.runtime_binding_json IS NOT NULL AND
        NEW.runtime_binding_revision = OLD.runtime_binding_revision + 1)) THEN
    RAISE EXCEPTION 'runtime claim downgrade cannot preserve immutable binding evidence';
  END IF;
  IF NEW.claim_count IS DISTINCT FROM OLD.claim_count AND
     NEW.claim_count <> OLD.claim_count + 1 THEN
    RAISE EXCEPTION 'runtime claim count must advance exactly once';
  END IF;
  IF NEW.claim_count = OLD.claim_count AND
     (NEW.runtime_binding_revision IS DISTINCT FROM OLD.runtime_binding_revision OR
      NEW.runtime_claim_protocol IS DISTINCT FROM OLD.runtime_claim_protocol) THEN
    RAISE EXCEPTION 'runtime binding revision requires one claim increment';
  END IF;
  IF OLD.runtime_binding_json IS NULL AND
     NEW.runtime_binding_json IS NOT NULL AND
     NEW.claim_count <> OLD.claim_count + 1 THEN
    RAISE EXCEPTION 'runtime binding admission requires one claim increment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_runtime_outbox_bound_claim_protocol
  BEFORE INSERT OR UPDATE ON codeops.session_runtime_outbox
  FOR EACH ROW EXECUTE FUNCTION codeops.require_runtime_bound_claim_protocol();

-- Existing claims were issued by the old v1 gateway before this migration.
-- Convert only claims owned by the bounded active-session snapshot; fail if
-- any other claimed row cannot be given explicit migration-owned proof.
UPDATE codeops.session_runtime_outbox AS outbox
   SET runtime_claim_protocol = 'legacy-unproven-v1'
 WHERE outbox.status = 'claimed'
   AND EXISTS (
     SELECT 1 FROM codeops.sessions AS session
      WHERE session.session_id = outbox.session_id
        AND session.legacy_runtime_worker_compatible = true
   );
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM codeops.session_runtime_outbox
     WHERE status = 'claimed'
       AND runtime_claim_protocol IS NULL
  ) THEN
    RAISE EXCEPTION 'pre-upgrade claimed dispatch lacks active-session migration proof';
  END IF;
END;
$$;

COMMIT;
