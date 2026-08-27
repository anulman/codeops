BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codeops.session_runtime_terminal_observations) THEN
    RAISE EXCEPTION
      'cannot remove runtime terminal reconciliation while observations exist';
  END IF;
  IF EXISTS (SELECT 1 FROM codeops.session_runtime_job_progress) THEN
    RAISE EXCEPTION
      'cannot remove runtime terminal reconciliation while Job progress exists';
  END IF;
END
$$;

DROP TABLE codeops.session_runtime_terminal_observations;
DROP TABLE codeops.session_runtime_job_progress;
DROP TABLE codeops.session_runtime_legacy_job_allowlist;
DROP TABLE codeops.session_runtime_reconciliation_scan;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_command_or_runtime_progress_check;
ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_runtime_progress_check CHECK (
    command_id IS NOT NULL OR event_type IN (
      'session_created', 'permission_requested', 'acp_update', 'state_changed'
    )
  );

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_event_type_check;
ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    'session_created', 'state_changed', 'acp_update', 'permission_requested',
    'command_committed', 'checkpoint_committed', 'lease_changed',
    'session_archived'
  ));

COMMIT;
