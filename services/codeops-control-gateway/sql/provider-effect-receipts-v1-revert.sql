BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM codeops.provider_effect_receipts
     WHERE state NOT IN ('authorized', 'attempting', 'unknown', 'succeeded')
        OR (state = 'succeeded' AND evidence_json IS NULL)
  ) THEN
    RAISE EXCEPTION 'provider effect receipts contain states that the legacy schema cannot represent';
  END IF;
END;
$$;

CREATE TABLE codeops.session_runtime_github_mutations (
  operation_id text PRIMARY KEY
    CHECK (operation_id ~ '^githubmutation-[0-9a-f]{64}$'),
  dispatch_id uuid NOT NULL
    REFERENCES codeops.session_runtime_outbox(dispatch_id),
  payload_digest text NOT NULL
    CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_digest text NOT NULL
    CHECK (permission_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed')),
  result_json jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (
    (status = 'started' AND result_json IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND result_json IS NOT NULL
      AND completed_at IS NOT NULL AND completed_at >= started_at)
  )
);

INSERT INTO codeops.session_runtime_github_mutations (
  operation_id,
  dispatch_id,
  payload_digest,
  permission_digest,
  status,
  result_json,
  started_at,
  completed_at
)
SELECT
  effect_id,
  dispatch_id,
  payload_digest,
  permission_digest,
  CASE state WHEN 'succeeded' THEN 'completed' ELSE 'started' END,
  CASE state WHEN 'succeeded' THEN evidence_json ELSE NULL END,
  COALESCE(attempted_at, authorized_at),
  CASE state WHEN 'succeeded' THEN resolved_at ELSE NULL END
FROM codeops.provider_effect_receipts;

DROP TABLE codeops.provider_effect_receipts;

CREATE INDEX session_runtime_github_mutations_dispatch_started_idx
  ON codeops.session_runtime_github_mutations (dispatch_id, started_at);

COMMIT;
