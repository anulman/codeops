BEGIN;

DROP FUNCTION IF EXISTS codeops.settle_session_model_budget(
  uuid, text, text, bigint, bigint, bigint, text
);
DROP FUNCTION IF EXISTS codeops.reserve_session_model_budget(
  uuid, text, text, text, bigint, text, text, text, bigint, bigint
);

COMMIT;
