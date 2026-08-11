\set ON_ERROR_STOP on

-- Run against the session-broker database after creating the NOLOGIN/LOGIN
-- role represented by :worker_role. The externally provisioned Secret must
-- contain a DSN for only this role.
BEGIN;

ALTER ROLE :"worker_role"
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

REVOKE ALL ON SCHEMA codeops FROM :"worker_role";
REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM :"worker_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM :"worker_role";

GRANT USAGE ON SCHEMA codeops TO :"worker_role";
GRANT SELECT (dispatch_id, dispatch_digest, status, result_json)
  ON codeops.session_runtime_execution_receipts TO :"worker_role";
GRANT INSERT (dispatch_id, dispatch_digest, status)
  ON codeops.session_runtime_execution_receipts TO :"worker_role";
GRANT UPDATE (status, result_json, completed_at)
  ON codeops.session_runtime_execution_receipts TO :"worker_role";

COMMIT;
