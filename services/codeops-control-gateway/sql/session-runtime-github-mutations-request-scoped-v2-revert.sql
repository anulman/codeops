BEGIN;

DROP INDEX codeops.session_runtime_github_mutations_dispatch_started_idx;

ALTER TABLE codeops.session_runtime_github_mutations
  ADD CONSTRAINT session_runtime_github_mutations_dispatch_id_key
  UNIQUE (dispatch_id);

COMMIT;
