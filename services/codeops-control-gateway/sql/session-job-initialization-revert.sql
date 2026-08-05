BEGIN;

ALTER TABLE codeops.session_events
  DROP CONSTRAINT session_events_command_or_initialization_check;

ALTER TABLE codeops.session_events
  ALTER COLUMN command_id SET NOT NULL;

COMMIT;
