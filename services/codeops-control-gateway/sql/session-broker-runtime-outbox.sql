BEGIN;

CREATE TABLE codeops.session_runtime_outbox (
  dispatch_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  idempotency_key uuid NOT NULL,
  principal_id text NOT NULL
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  dispatch_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed')),
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  claim_token uuid,
  claimed_by text
    CHECK (claimed_by IS NULL OR claimed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  completion_json jsonb,
  result_json jsonb,
  completed_by text
    CHECK (completed_by IS NULL OR completed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  completed_at timestamptz,
  UNIQUE (session_id, idempotency_key),
  CHECK (dispatch_json ?& ARRAY['version', 'dispatchId', 'principalId', 'command', 'snapshot', 'dispatchedAt']),
  CHECK (dispatch_json->>'version' = 'codeops.session-runtime-dispatch/v1'),
  CHECK ((dispatch_json->>'dispatchId')::uuid = dispatch_id),
  CHECK (dispatch_json->>'principalId' = principal_id),
  CHECK (dispatch_json#>>'{command,sessionId}' = session_id),
  CHECK ((dispatch_json#>>'{command,idempotencyKey}')::uuid = idempotency_key),
  CHECK ((dispatch_json->>'dispatchedAt')::timestamptz = created_at),
  CHECK (available_at >= created_at),
  CHECK (
    (status = 'pending' AND claim_token IS NULL AND claimed_by IS NULL
      AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND completion_json IS NULL AND result_json IS NULL
      AND completed_by IS NULL AND completed_at IS NULL)
    OR
    (status = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL AND claim_expires_at > claimed_at
      AND completion_json IS NULL AND result_json IS NULL
      AND completed_by IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND claim_token IS NULL AND claimed_by IS NULL
      AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND completion_json IS NOT NULL AND result_json IS NOT NULL
      AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (
    completion_json IS NULL OR (
      completion_json->>'version' = 'codeops.session-runtime-completion/v1'
      AND (completion_json->>'dispatchId')::uuid = dispatch_id
    )
  ),
  CHECK (
    result_json IS NULL OR (
      result_json->>'version' = 'codeops.session-command-result/v1'
      AND result_json->>'sessionId' = session_id
      AND (result_json->>'idempotencyKey')::uuid = idempotency_key
    )
  )
);

CREATE INDEX session_runtime_outbox_claim_idx
  ON codeops.session_runtime_outbox (available_at, created_at, dispatch_id)
  WHERE status IN ('pending', 'claimed');

COMMIT;
