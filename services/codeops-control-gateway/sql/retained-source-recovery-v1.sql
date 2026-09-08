BEGIN;

-- Recovery is independent evidence, never an outbox claim or checkpoint receipt.
CREATE TABLE codeops.retained_source_recoveries (
  recovery_id uuid PRIMARY KEY,
  evidence_digest text NOT NULL UNIQUE CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_json jsonb NOT NULL CHECK (octet_length(evidence_json::text) <= 4500000),
  principal_id text NOT NULL,
  origin text NOT NULL CHECK (origin = 'retained-source'),
  retained_source_id text NOT NULL UNIQUE,
  source_key text NOT NULL UNIQUE CHECK (source_key ~ '^sha256:[0-9a-f]{64}$'),
  publication_key text NOT NULL UNIQUE CHECK (publication_key ~ '^sha256:[0-9a-f]{64}$'),
  finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (evidence_json->>'recoveryId' = recovery_id::text),
  CHECK (evidence_json->>'origin' = origin),
  CHECK (evidence_json->>'retainedSourceId' = retained_source_id),
  CHECK (evidence_json#>>'{authority,principalId}' = principal_id)
);

CREATE TABLE codeops.retained_source_effects (
  recovery_id uuid NOT NULL REFERENCES codeops.retained_source_recoveries(recovery_id),
  step text NOT NULL CHECK (step IN ('branch','pull-request')),
  effect_id text NOT NULL UNIQUE CHECK (effect_id ~ '^githubmutation-[0-9a-f]{64}$'),
  request_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('attempting','unknown','succeeded',
    'reconciled_satisfied','reconciled_not_observed')),
  attempted_at timestamptz NOT NULL,
  result_json jsonb,
  PRIMARY KEY(recovery_id,step),
  CHECK (request_json->>'operationId' = effect_id),
  CHECK (request_json#>>'{provenance,sourceRecoveryId}' = recovery_id::text),
  CHECK ((state IN ('succeeded','reconciled_satisfied')) = (result_json IS NOT NULL))
);

CREATE FUNCTION codeops.fence_retained_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'retained_source_recoveries' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retained source provenance is immutable';
  END IF;
  IF (NEW.recovery_id,NEW.step,NEW.effect_id,NEW.request_json,NEW.attempted_at)
       IS DISTINCT FROM (OLD.recovery_id,OLD.step,OLD.effect_id,OLD.request_json,OLD.attempted_at)
     OR OLD.state NOT IN ('attempting','unknown') THEN
    RAISE EXCEPTION 'retained source effect identity or terminal outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retained_source_recoveries_immutable BEFORE UPDATE OR DELETE
  ON codeops.retained_source_recoveries FOR EACH ROW
  EXECUTE FUNCTION codeops.fence_retained_source_mutation();
CREATE TRIGGER retained_source_effects_fenced BEFORE UPDATE OR DELETE
  ON codeops.retained_source_effects FOR EACH ROW
  EXECUTE FUNCTION codeops.fence_retained_source_mutation();

COMMIT;
