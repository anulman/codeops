BEGIN;
DROP TABLE IF EXISTS codeops.session_runtime_outbox;
DROP TABLE codeops.session_events;
DROP TABLE codeops.session_commands;
DROP TABLE codeops.sessions;
DROP SCHEMA codeops;
COMMIT;
