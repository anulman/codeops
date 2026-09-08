BEGIN;

CREATE TABLE codeops.workspace_retention_decisions (
  decision_id uuid PRIMARY KEY REFERENCES codeops.workspace_checkpoint_cleanup_decisions(decision_id),
  pvc_uid uuid NOT NULL UNIQUE,
  decision_json jsonb NOT NULL,
  decision_digest text NOT NULL UNIQUE CHECK (decision_digest ~ '^sha256:[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  CHECK (decision_json->>'version' = 'codeops.workspace-retention-decision/v1'),
  CHECK (decision_json->>'decisionId' = decision_id::text),
  CHECK (decision_json#>>'{target,pvc,uid}' = pvc_uid::text)
);

CREATE UNIQUE INDEX workspace_retention_job_once
  ON codeops.workspace_retention_decisions ((decision_json#>>'{target,job,uid}'));
CREATE UNIQUE INDEX workspace_retention_volume_once
  ON codeops.workspace_retention_decisions
  ((decision_json#>>'{target,pv,driver}'), (decision_json#>>'{target,pv,volumeHandle}'));

CREATE TABLE codeops.workspace_cleanup_receipts (
  receipt_id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES codeops.workspace_retention_decisions(decision_id),
  receipt_json jsonb NOT NULL,
  receipt_digest text NOT NULL UNIQUE CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  completed boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  CHECK (receipt_json->>'version' = 'codeops.workspace-cleanup-receipt/v1'),
  CHECK (receipt_json->>'receiptId' = receipt_id::text),
  CHECK (receipt_json->>'decisionId' = decision_id::text),
  CHECK ((receipt_json->>'completed')::boolean = completed)
);
CREATE UNIQUE INDEX workspace_cleanup_once ON codeops.workspace_cleanup_receipts(decision_id) WHERE completed;
CREATE INDEX workspace_cleanup_progress ON codeops.workspace_cleanup_receipts(decision_id, observed_at);
CREATE TRIGGER workspace_retention_decisions_append_only BEFORE UPDATE OR DELETE
  ON codeops.workspace_retention_decisions FOR EACH ROW
  EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_cleanup_receipts_append_only BEFORE UPDATE OR DELETE
  ON codeops.workspace_cleanup_receipts FOR EACH ROW
  EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();

COMMIT;
