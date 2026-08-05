BEGIN;

CREATE TABLE codeops.session_runtime_execution_receipts (
  dispatch_id uuid PRIMARY KEY
    REFERENCES codeops.session_runtime_outbox(dispatch_id),
  dispatch_digest text NOT NULL
    CHECK (dispatch_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(result_json) = 'object'),
  CHECK (result_json ? 'type'),
  CHECK (result_json->>'type' IN
    ('prompt', 'checkpoint', 'hibernate', 'resume', 'fork'))
);

COMMIT;
