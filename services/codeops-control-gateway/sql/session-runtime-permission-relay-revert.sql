BEGIN;

DROP TABLE IF EXISTS codeops.session_runtime_permission_requests;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT IF EXISTS session_events_command_or_runtime_progress_check;

ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_initialization_check
  CHECK (command_id IS NOT NULL OR event_type = 'session_created');

COMMIT;
