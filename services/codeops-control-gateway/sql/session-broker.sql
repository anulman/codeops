BEGIN;

CREATE SCHEMA IF NOT EXISTS codeops;

CREATE TABLE codeops.sessions (
  session_id text PRIMARY KEY
    CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  lease_id uuid NOT NULL,
  snapshot_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (snapshot_json ?& ARRAY['version', 'sessionId', 'generation', 'state', 'lease', 'pendingPermission', 'updatedAt']),
  CHECK (snapshot_json->>'version' = 'codeops.session-snapshot/v1'),
  CHECK (snapshot_json->>'sessionId' = session_id),
  CHECK ((snapshot_json->>'generation')::bigint = generation),
  CHECK (snapshot_json->>'state' IN (
    'queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated',
    'completed', 'failed', 'cancelled', 'archived'
  )),
  CHECK ((snapshot_json->>'updatedAt')::timestamptz = updated_at),
  CHECK (snapshot_json->'lease' <> 'null'::jsonb),
  CHECK ((snapshot_json#>>'{lease,leaseId}')::uuid = lease_id),
  CHECK ((snapshot_json#>>'{lease,generation}')::bigint = generation),
  CHECK (
    (snapshot_json->>'state' IN ('running', 'waiting_permission', 'checkpointing')) =
    (snapshot_json#>>'{lease,status}' = 'active')
  ),
  CHECK (
    (snapshot_json->>'state' = 'waiting_permission') =
    (snapshot_json->'pendingPermission' <> 'null'::jsonb)
  )
);

CREATE TABLE codeops.session_commands (
  command_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  idempotency_key uuid NOT NULL,
  command_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  principal_id text NOT NULL
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  committed_at timestamptz NOT NULL,
  UNIQUE (session_id, idempotency_key),
  CHECK (command_json ?& ARRAY['version', 'sessionId', 'idempotencyKey']),
  CHECK (result_json ?& ARRAY['version', 'commandId', 'sessionId', 'idempotencyKey', 'committedAt']),
  CHECK (command_json->>'version' = 'codeops.session-command/v1'),
  CHECK (command_json->>'sessionId' = session_id),
  CHECK ((command_json->>'idempotencyKey')::uuid = idempotency_key),
  CHECK (result_json->>'version' = 'codeops.session-command-result/v1'),
  CHECK ((result_json->>'commandId')::uuid = command_id),
  CHECK (result_json->>'sessionId' = session_id),
  CHECK ((result_json->>'idempotencyKey')::uuid = idempotency_key),
  CHECK ((result_json->>'committedAt')::timestamptz = committed_at)
);

CREATE TABLE codeops.session_events (
  event_id text PRIMARY KEY
    CHECK (event_id ~ '^sha256:[0-9a-f]{64}$'),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  cursor bigint NOT NULL CHECK (cursor > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'session_created',
    'state_changed',
    'acp_update',
    'permission_requested',
    'command_committed',
    'checkpoint_committed',
    'lease_changed',
    'session_archived'
  )),
  event_json jsonb NOT NULL,
  command_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (session_id, cursor),
  CONSTRAINT session_events_command_fk
    FOREIGN KEY (command_id)
    REFERENCES codeops.session_commands(command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (event_json ?& ARRAY['version', 'eventId', 'sessionId', 'generation', 'cursor', 'type', 'occurredAt']),
  CHECK (event_json->>'version' = 'codeops.session-event/v1'),
  CHECK (event_json->>'eventId' = event_id),
  CHECK (event_json->>'sessionId' = session_id),
  CHECK ((event_json->>'generation')::bigint = generation),
  CHECK ((event_json->>'cursor')::bigint = cursor),
  CHECK (event_json->>'type' = event_type),
  CHECK ((event_json->>'occurredAt')::timestamptz = occurred_at)
);

CREATE INDEX session_events_session_generation_cursor_idx
  ON codeops.session_events (session_id, generation, cursor);
CREATE INDEX session_commands_principal_committed_idx
  ON codeops.session_commands (principal_id, committed_at DESC);

COMMIT;
