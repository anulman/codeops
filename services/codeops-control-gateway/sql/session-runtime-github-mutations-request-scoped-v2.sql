BEGIN;

ALTER TABLE codeops.session_runtime_github_mutations
  DROP CONSTRAINT session_runtime_github_mutations_dispatch_id_key;

CREATE INDEX session_runtime_github_mutations_dispatch_started_idx
  ON codeops.session_runtime_github_mutations (dispatch_id, started_at);

COMMIT;
