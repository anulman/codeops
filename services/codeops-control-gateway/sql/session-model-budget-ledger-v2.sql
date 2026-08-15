BEGIN;

CREATE TABLE codeops.session_model_budgets (
  session_id text PRIMARY KEY REFERENCES codeops.sessions(session_id) ON DELETE CASCADE,
  budget_id text NOT NULL UNIQUE
    CHECK (budget_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  started_at timestamptz NOT NULL,
  provider_requests_limit bigint NOT NULL CHECK (provider_requests_limit > 0),
  output_tokens_limit bigint NOT NULL CHECK (output_tokens_limit > 0),
  committed_provider_requests bigint NOT NULL DEFAULT 0
    CHECK (committed_provider_requests >= 0),
  settled_output_tokens bigint NOT NULL DEFAULT 0
    CHECK (settled_output_tokens >= 0),
  reserved_output_tokens bigint NOT NULL DEFAULT 0
    CHECK (reserved_output_tokens >= 0),
  observed_input_tokens bigint NOT NULL DEFAULT 0
    CHECK (observed_input_tokens >= 0),
  observed_total_tokens bigint NOT NULL DEFAULT 0
    CHECK (observed_total_tokens >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  UNIQUE (session_id, budget_id),
  CHECK (committed_provider_requests <= provider_requests_limit),
  CHECK (settled_output_tokens + reserved_output_tokens <= output_tokens_limit)
);

CREATE TABLE codeops.session_model_budget_reservations (
  reservation_id uuid PRIMARY KEY,
  model_token_id text NOT NULL
    CHECK (model_token_id ~ '^sha256:[0-9a-f]{64}$'),
  session_id text NOT NULL,
  budget_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  provider text NOT NULL CHECK (provider = 'openai'),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  reasoning_effort text NOT NULL
    CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh')),
  requested_output_tokens bigint NOT NULL CHECK (requested_output_tokens > 0),
  reserved_output_tokens bigint NOT NULL CHECK (reserved_output_tokens > 0),
  state text NOT NULL
    CHECK (state IN ('reserved', 'settled', 'provider_rejected', 'charged_unknown')),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR
    provider_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  proved_input_tokens bigint CHECK (proved_input_tokens >= 0),
  proved_output_tokens bigint CHECK (proved_output_tokens >= 0),
  proved_total_tokens bigint CHECK (proved_total_tokens >= 0),
  failure_class text CHECK (
    failure_class IS NULL OR
    failure_class IN (
      'provider_rejected', 'transport', 'timeout', 'truncated_stream',
      'missing_terminal_usage', 'invalid_terminal_usage', 'proxy_stopped'
    )
  ),
  reserved_at timestamptz NOT NULL,
  settled_at timestamptz,
  FOREIGN KEY (session_id, budget_id)
    REFERENCES codeops.session_model_budgets(session_id, budget_id)
    ON DELETE CASCADE,
  CHECK (reserved_output_tokens <= requested_output_tokens),
  CHECK (
    (state = 'reserved' AND settled_at IS NULL AND
      proved_input_tokens IS NULL AND proved_output_tokens IS NULL AND
      proved_total_tokens IS NULL AND failure_class IS NULL) OR
    (state = 'settled' AND settled_at IS NOT NULL AND
      proved_input_tokens IS NOT NULL AND proved_output_tokens IS NOT NULL AND
      proved_total_tokens IS NOT NULL AND failure_class IS NULL) OR
    (state = 'provider_rejected' AND settled_at IS NOT NULL AND
      proved_input_tokens IS NULL AND proved_output_tokens IS NULL AND
      proved_total_tokens IS NULL AND failure_class = 'provider_rejected') OR
    (state = 'charged_unknown' AND settled_at IS NOT NULL AND
      proved_input_tokens IS NULL AND proved_output_tokens IS NULL AND
      proved_total_tokens IS NULL AND failure_class IS NOT NULL AND
      failure_class <> 'provider_rejected')
  )
);

CREATE INDEX session_model_budget_reservations_session_idx
  ON codeops.session_model_budget_reservations
  (session_id, reserved_at, reservation_id);

INSERT INTO codeops.session_model_budgets (
  session_id,
  budget_id,
  started_at,
  provider_requests_limit,
  output_tokens_limit,
  committed_provider_requests,
  settled_output_tokens,
  reserved_output_tokens,
  observed_input_tokens,
  observed_total_tokens,
  revision,
  updated_at
)
SELECT
  session_id,
  session_id,
  (snapshot_json#>>'{budget,startedAt}')::timestamptz,
  (snapshot_json#>>'{budget,limits,modelRequests}')::bigint,
  (snapshot_json#>>'{budget,limits,totalTokens}')::bigint,
  LEAST(
    (snapshot_json#>>'{budget,usage,modelRequests}')::bigint,
    (snapshot_json#>>'{budget,limits,modelRequests}')::bigint
  ),
  LEAST(
    (snapshot_json#>>'{budget,usage,totalTokens}')::bigint,
    (snapshot_json#>>'{budget,limits,totalTokens}')::bigint
  ),
  0,
  0,
  (snapshot_json#>>'{budget,usage,totalTokens}')::bigint,
  1,
  updated_at
FROM codeops.sessions
WHERE snapshot_json#>>'{budget,version}' = 'codeops.session-budget/v1'
ON CONFLICT (session_id) DO NOTHING;

COMMIT;
