BEGIN;

ALTER TABLE codeops.session_events
  ALTER COLUMN command_id DROP NOT NULL;

ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_command_or_initialization_check
  CHECK (command_id IS NOT NULL OR event_type = 'session_created');

COMMIT;
