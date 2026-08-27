BEGIN;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_event_type_check;
ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    'session_created', 'state_changed', 'acp_update', 'permission_requested',
    'command_committed', 'checkpoint_committed', 'lease_changed',
    'session_archived', 'runtime_terminal'
  ));

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_command_or_runtime_progress_check;
ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_runtime_progress_check CHECK (
    command_id IS NOT NULL OR event_type IN (
      'session_created', 'permission_requested', 'acp_update', 'state_changed',
      'runtime_terminal'
    )
  );

CREATE TABLE codeops.session_runtime_job_progress (
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  lease_id uuid NOT NULL,
  run_id text NOT NULL,
  job_name text NOT NULL,
  job_uid uuid NOT NULL UNIQUE,
  job_resource_version numeric(40, 0) NOT NULL CHECK (job_resource_version > 0),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, generation)
);

CREATE TABLE codeops.session_runtime_legacy_job_allowlist (
  job_uid uuid PRIMARY KEY
);

INSERT INTO codeops.session_runtime_legacy_job_allowlist (job_uid)
SELECT value::uuid
  FROM jsonb_array_elements_text(
    current_setting('codeops.retained_runtime_job_uids')::jsonb
  );

CREATE TABLE codeops.session_runtime_terminal_observations (
  job_uid uuid PRIMARY KEY REFERENCES codeops.session_runtime_job_progress(job_uid),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  lease_id uuid NOT NULL,
  run_id text NOT NULL,
  job_resource_version numeric(40, 0) NOT NULL CHECK (job_resource_version > 0),
  observation_json jsonb NOT NULL,
  event_id text NOT NULL UNIQUE REFERENCES codeops.session_events(event_id),
  observed_at timestamptz NOT NULL,
  UNIQUE (session_id, generation),
  FOREIGN KEY (session_id, generation)
    REFERENCES codeops.session_runtime_job_progress(session_id, generation),
  CHECK (observation_json->>'version' =
    'codeops.session-runtime-terminal-observation/v1'),
  CHECK (observation_json->>'sessionId' = session_id),
  CHECK ((observation_json->>'generation')::bigint = generation),
  CHECK ((observation_json->>'leaseId')::uuid = lease_id),
  CHECK (observation_json->>'runId' = run_id),
  CHECK ((observation_json#>>'{job,uid}')::uuid = job_uid),
  CHECK ((observation_json#>>'{job,resourceVersion}')::numeric =
    job_resource_version),
  CHECK ((observation_json->>'observedAt')::timestamptz = observed_at)
);

CREATE TABLE codeops.session_runtime_reconciliation_scan (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_session_id text NOT NULL
);

INSERT INTO codeops.session_runtime_reconciliation_scan
  (singleton, last_session_id) VALUES (true, '');

COMMIT;
