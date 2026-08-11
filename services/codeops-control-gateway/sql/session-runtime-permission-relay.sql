BEGIN;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_command_or_initialization_check;

ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_runtime_progress_check
  CHECK (
    command_id IS NOT NULL OR
    event_type IN ('session_created', 'permission_requested')
  );

CREATE TABLE codeops.session_runtime_permission_requests (
  dispatch_id uuid NOT NULL
    REFERENCES codeops.session_runtime_outbox(dispatch_id),
  request_id text NOT NULL
    CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  request_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (dispatch_id, request_id),
  UNIQUE (session_id, request_id),
  CHECK (request_json ?& ARRAY[
    'version', 'claimToken', 'request', 'acpSessionId', 'toolCallId', 'options'
  ]),
  CHECK (
    request_json->>'version' =
      'codeops.session-runtime-permission-submission/v1'
  ),
  CHECK (request_json#>>'{request,requestId}' = request_id),
  CHECK ((request_json#>>'{request,requestedAt}')::timestamptz = created_at)
);

CREATE INDEX session_runtime_permission_requests_session_created_idx
  ON codeops.session_runtime_permission_requests (session_id, created_at);

COMMIT;
