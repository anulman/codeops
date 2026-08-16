BEGIN;

ALTER TABLE codeops.sessions
  ADD COLUMN owner_principal_id text;

DO $$
DECLARE
  legacy_owner text := NULLIF(
    current_setting('codeops.legacy_session_owner_principal_id', true),
    ''
  );
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.sessions) THEN
    IF legacy_owner IS NULL THEN
      RAISE EXCEPTION 'existing sessions require an explicit legacy owner principal';
    END IF;
    IF legacy_owner !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$' THEN
      RAISE EXCEPTION 'legacy session owner principal is invalid';
    END IF;
    UPDATE codeops.sessions
       SET owner_principal_id = legacy_owner;
  END IF;
END;
$$;

ALTER TABLE codeops.sessions
  ALTER COLUMN owner_principal_id SET NOT NULL,
  ADD CONSTRAINT sessions_owner_principal_id_check CHECK (
    owner_principal_id = btrim(owner_principal_id)
    AND
    owner_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
  );

CREATE INDEX sessions_owner_updated_idx
  ON codeops.sessions (owner_principal_id, updated_at DESC, session_id ASC);

CREATE FUNCTION codeops.reject_session_owner_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
    RAISE EXCEPTION 'session owner principal is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_owner_immutable
BEFORE UPDATE OF owner_principal_id ON codeops.sessions
FOR EACH ROW
EXECUTE FUNCTION codeops.reject_session_owner_update();

COMMIT;
