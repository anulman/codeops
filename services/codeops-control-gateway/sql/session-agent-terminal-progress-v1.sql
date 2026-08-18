BEGIN;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_command_or_runtime_progress_check;

ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_runtime_progress_check
  CHECK (
    command_id IS NOT NULL OR
    event_type IN (
      'session_created',
      'permission_requested',
      'acp_update',
      'state_changed'
    )
  );

COMMIT;
