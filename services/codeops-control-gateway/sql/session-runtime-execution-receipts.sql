BEGIN;

CREATE TABLE codeops.session_runtime_execution_receipts (
  dispatch_id uuid PRIMARY KEY
    REFERENCES codeops.session_runtime_outbox(dispatch_id),
  dispatch_digest text NOT NULL
    CHECK (dispatch_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (
    (status = 'started' AND result_json IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND result_json IS NOT NULL
      AND completed_at IS NOT NULL AND completed_at >= created_at)
  ),
  CHECK (
    result_json IS NULL OR (
      jsonb_typeof(result_json) = 'object'
      AND result_json ? 'type'
      AND result_json->>'type' IN
        ('prompt', 'checkpoint', 'hibernate', 'resume', 'fork')
    )
  )
);

COMMIT;
