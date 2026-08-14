BEGIN;

CREATE TABLE codeops.session_runtime_github_mutations (
  operation_id text PRIMARY KEY
    CHECK (operation_id ~ '^githubmutation-[0-9a-f]{64}$'),
  dispatch_id uuid NOT NULL UNIQUE
    REFERENCES codeops.session_runtime_outbox(dispatch_id),
  payload_digest text NOT NULL
    CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_digest text NOT NULL
    CHECK (permission_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed')),
  result_json jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (
    (status = 'started' AND result_json IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND result_json IS NOT NULL
      AND completed_at IS NOT NULL AND completed_at >= started_at)
  )
);

COMMIT;
