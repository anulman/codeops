\set ON_ERROR_STOP on

-- Run against the session-broker database after creating the LOGIN role
-- represented by :proxy_role. The externally provisioned Secret must contain
-- a DSN for only this role.
BEGIN;

ALTER ROLE :"proxy_role"
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

REVOKE ALL ON SCHEMA codeops FROM :"proxy_role";
REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM :"proxy_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM :"proxy_role";

GRANT USAGE ON SCHEMA codeops TO :"proxy_role";
GRANT EXECUTE ON FUNCTION codeops.reserve_session_model_budget(
  uuid, text, text, text, bigint, text, text, text, bigint, bigint
) TO :"proxy_role";
GRANT EXECUTE ON FUNCTION codeops.settle_session_model_budget(
  uuid, text, text, bigint, bigint, bigint, text
) TO :"proxy_role";
GRANT EXECUTE ON FUNCTION
  codeops.charge_stale_session_model_budget_reservations()
  TO :"proxy_role";

COMMIT;
