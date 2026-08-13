BEGIN;

CREATE TABLE codeops.workspace_checkpoint_artifacts (
  artifact_id text PRIMARY KEY
    CHECK (artifact_id ~ '^artifact:[0-9a-f-]{36}:(scratch|source:[a-z0-9][a-z0-9-]{0,62})$'),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  checkpoint_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('source-patch', 'scratch-bundle')),
  catalog_key text,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  artifact_bytes bigint NOT NULL CHECK (artifact_bytes >= 0 AND artifact_bytes <= 16000000),
  artifact_content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, generation, checkpoint_id, artifact_kind, catalog_key),
  CHECK (octet_length(artifact_content) = artifact_bytes),
  CHECK (
    (artifact_kind = 'source-patch' AND catalog_key ~ '^[a-z0-9][a-z0-9-]{0,62}$')
    OR (artifact_kind = 'scratch-bundle' AND catalog_key IS NULL)
  )
);

COMMIT;
