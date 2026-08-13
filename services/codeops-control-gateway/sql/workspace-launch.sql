BEGIN;

CREATE TABLE codeops.workspace_launches (
  launch_id text PRIMARY KEY,
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 3 AND 320),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_json jsonb NOT NULL,
  launch_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'provisioning', 'ready', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (principal_id, idempotency_key),
  CHECK (launch_json->>'launchId' = launch_id),
  CHECK (launch_json->>'principalId' = principal_id),
  CHECK (launch_json->>'idempotencyKey' = idempotency_key::text),
  CHECK (launch_json->>'requestDigest' = request_digest),
  CHECK (launch_json->>'state' = state),
  CHECK (request_json->>'idempotencyKey' = idempotency_key::text),
  CHECK (updated_at >= created_at)
);

CREATE INDEX workspace_launch_active_principal_idx
  ON codeops.workspace_launches (principal_id, created_at)
  WHERE state IN ('queued', 'provisioning');

CREATE INDEX workspace_launch_active_global_idx
  ON codeops.workspace_launches (created_at)
  WHERE state IN ('queued', 'provisioning');

CREATE OR REPLACE FUNCTION codeops.reject_workspace_launch_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.launch_id <> OLD.launch_id OR
     NEW.principal_id <> OLD.principal_id OR
     NEW.idempotency_key <> OLD.idempotency_key OR
     NEW.request_digest <> OLD.request_digest OR
     NEW.request_json <> OLD.request_json OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'workspace launch identity is immutable';
  END IF;
  IF OLD.state IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'terminal workspace launch is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_launch_identity_immutable
  BEFORE UPDATE ON codeops.workspace_launches
  FOR EACH ROW EXECUTE FUNCTION codeops.reject_workspace_launch_identity_update();

COMMIT;
