BEGIN;

CREATE TABLE codeops.github_branch_publish_candidate_manifests (
  manifest_id text PRIMARY KEY
    CHECK (manifest_id ~ '^githubcandidate-[0-9a-f]{64}$'),
  candidate_digest text NOT NULL
    CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_bytes integer NOT NULL CHECK (candidate_bytes BETWEEN 1 AND 4194304),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 64),
  dispatch_id uuid NOT NULL REFERENCES codeops.session_runtime_outbox(dispatch_id),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  owner_principal_id text NOT NULL
    CHECK (owner_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  repository text NOT NULL
    CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  operation text NOT NULL CHECK (operation = 'branch_publish'),
  operation_id text NOT NULL
    CHECK (operation_id ~ '^githubmutation-[0-9a-f]{64}$'),
  effect_digest text NOT NULL
    CHECK (effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  chunk_identities_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (manifest_id, dispatch_id, operation_id),
  UNIQUE (dispatch_id, operation_id),
  CHECK (jsonb_typeof(chunk_identities_json) = 'array'),
  CHECK (jsonb_array_length(chunk_identities_json) = chunk_count)
);

CREATE TABLE codeops.github_branch_publish_candidate_chunks (
  manifest_id text NOT NULL,
  dispatch_id uuid NOT NULL,
  operation_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  chunk_digest text NOT NULL CHECK (chunk_digest ~ '^sha256:[0-9a-f]{64}$'),
  chunk_bytes integer NOT NULL CHECK (chunk_bytes BETWEEN 1 AND 65536),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (manifest_id, ordinal),
  FOREIGN KEY (manifest_id, dispatch_id, operation_id)
    REFERENCES codeops.github_branch_publish_candidate_manifests
      (manifest_id, dispatch_id, operation_id)
    ON DELETE CASCADE,
  CHECK (octet_length(content) = chunk_bytes)
);

CREATE INDEX github_branch_publish_chunks_dispatch_operation_ordinal_idx
  ON codeops.github_branch_publish_candidate_chunks
    (dispatch_id, operation_id, ordinal);

CREATE FUNCTION codeops.reject_github_branch_publish_candidate_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GitHub branch candidate identity is immutable';
END;
$$;

CREATE TRIGGER github_branch_publish_candidate_manifests_immutable
BEFORE UPDATE ON codeops.github_branch_publish_candidate_manifests
FOR EACH ROW EXECUTE FUNCTION codeops.reject_github_branch_publish_candidate_mutation();

CREATE TRIGGER github_branch_publish_candidate_chunks_immutable
BEFORE UPDATE ON codeops.github_branch_publish_candidate_chunks
FOR EACH ROW EXECUTE FUNCTION codeops.reject_github_branch_publish_candidate_mutation();

COMMIT;
