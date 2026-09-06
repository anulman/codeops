BEGIN;

ALTER TABLE codeops.session_runtime_job_progress
  ADD COLUMN resource_configuration_digest text
  CHECK (resource_configuration_digest IS NULL OR
    resource_configuration_digest ~ '^sha256:[0-9a-f]{64}$');

CREATE TABLE codeops.workspace_checkpoint_descriptors (
  checkpoint_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  workspace_job_uid uuid NOT NULL REFERENCES codeops.session_runtime_job_progress(job_uid),
  resource_configuration_digest text NOT NULL CHECK (resource_configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  workspace_configuration_digest text NOT NULL CHECK (workspace_configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  workspace_manifest_digest text NOT NULL CHECK (workspace_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  descriptor_digest text NOT NULL UNIQUE CHECK (descriptor_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  descriptor_json jsonb NOT NULL CHECK (descriptor_json->>'version' = 'codeops.checkpoint-descriptor/v1'),
  checkpoint_receipt_json jsonb NOT NULL CHECK (checkpoint_receipt_json->>'version' = 'codeops.checkpoint-receipt/v1'),
  checkpoint_receipt_digest text NOT NULL CHECK (checkpoint_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  finalized_at timestamptz NOT NULL,
  UNIQUE (checkpoint_id, session_id, generation),
  CHECK (descriptor_json#>>'{manifest,checkpointId}' = checkpoint_id::text),
  CHECK (descriptor_json#>>'{manifest,binding,sessionId}' = session_id),
  CHECK ((descriptor_json#>>'{manifest,binding,generation}')::bigint = generation),
  CHECK (descriptor_json#>>'{manifest,binding,workspaceJobUid}' = workspace_job_uid::text),
  CHECK (descriptor_json#>>'{manifest,binding,resourceConfigurationDigest}' = resource_configuration_digest),
  CHECK (descriptor_json#>>'{manifest,binding,workspaceConfigurationDigest}' = workspace_configuration_digest),
  CHECK (descriptor_json#>>'{manifest,binding,workspaceManifestDigest}' = workspace_manifest_digest),
  CHECK (descriptor_json->>'manifestDigest' = manifest_digest),
  CHECK (octet_length(descriptor_json::text) < 900000),
  CHECK (checkpoint_receipt_json->>'checkpointId' = checkpoint_id::text),
  CHECK (checkpoint_receipt_json->>'descriptorDigest' = descriptor_digest),
  CHECK (checkpoint_receipt_json->>'manifestDigest' = manifest_digest),
  CHECK (checkpoint_receipt_json->'binding' = descriptor_json#>'{manifest,binding}'),
  CHECK ((checkpoint_receipt_json->>'issuedAt')::timestamptz = finalized_at)
);

CREATE TABLE codeops.workspace_checkpoint_restore_receipts (
  checkpoint_id uuid NOT NULL REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id),
  session_id text NOT NULL,
  generation bigint NOT NULL,
  restore_operation_id uuid PRIMARY KEY,
  restored_workspace_job_uid uuid NOT NULL REFERENCES codeops.session_runtime_job_progress(job_uid),
  restored_resource_configuration_digest text NOT NULL CHECK (restored_resource_configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  restored_generation bigint NOT NULL CHECK (restored_generation > generation),
  restore_receipt_digest text NOT NULL UNIQUE CHECK (restore_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  restore_receipt_json jsonb NOT NULL CHECK (restore_receipt_json->>'version' = 'codeops.restore-receipt/v1'),
  restored_at timestamptz NOT NULL,
  FOREIGN KEY (checkpoint_id, session_id, generation)
    REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id, session_id, generation),
  CHECK (restore_receipt_json->>'checkpointId' = checkpoint_id::text),
  CHECK (restore_receipt_json#>>'{binding,sessionId}' = session_id),
  CHECK ((restore_receipt_json#>>'{binding,generation}')::bigint = generation),
  CHECK (restore_receipt_json->>'restoreOperationId' = restore_operation_id::text),
  CHECK (restore_receipt_json->>'restoredWorkspaceJobUid' = restored_workspace_job_uid::text),
  CHECK (restore_receipt_json->>'restoredResourceConfigurationDigest' = restored_resource_configuration_digest),
  CHECK ((restore_receipt_json->>'restoredGeneration')::bigint = restored_generation)
);

CREATE TABLE codeops.workspace_checkpoint_restore_operations (
  restore_operation_id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id),
  dispatch_id uuid NOT NULL UNIQUE REFERENCES codeops.session_runtime_outbox(dispatch_id),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  workspace_job_uid uuid NOT NULL REFERENCES codeops.session_runtime_job_progress(job_uid),
  resource_configuration_digest text NOT NULL CHECK (resource_configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  workspace_configuration_digest text NOT NULL CHECK (workspace_configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  restored_path_set_digest text NOT NULL CHECK (restored_path_set_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE codeops.workspace_checkpoint_restore_receipts
  ADD CONSTRAINT workspace_checkpoint_restore_operation_fk
  FOREIGN KEY (restore_operation_id)
  REFERENCES codeops.workspace_checkpoint_restore_operations(restore_operation_id);

CREATE TABLE codeops.workspace_checkpoint_hold_events (
  event_id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id),
  revision bigint NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('placed', 'released')),
  operator_principal_id text NOT NULL CHECK (operator_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  event_json jsonb NOT NULL CHECK (event_json->>'version' = 'codeops.checkpoint-hold-event/v1'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (checkpoint_id, revision),
  CHECK (event_json->>'eventId' = event_id::text),
  CHECK (event_json->>'checkpointId' = checkpoint_id::text),
  CHECK ((event_json->>'revision')::bigint = revision),
  CHECK (event_json->>'action' = action),
  CHECK (event_json->>'operatorPrincipalId' = operator_principal_id)
);

CREATE TABLE codeops.workspace_checkpoint_retention_decisions (
  decision_id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  decision_json jsonb NOT NULL CHECK (decision_json->>'version' = 'codeops.checkpoint-retention-decision/v1'),
  retain_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz NOT NULL,
  UNIQUE (checkpoint_id, policy_revision),
  CHECK (decided_at < retain_until AND retain_until < expires_at),
  CHECK (decision_json->>'decisionId' = decision_id::text),
  CHECK (decision_json->>'checkpointId' = checkpoint_id::text),
  CHECK ((decision_json->>'policyRevision')::bigint = policy_revision),
  CHECK ((decision_json->>'retainUntil')::timestamptz = retain_until),
  CHECK ((decision_json->>'expiresAt')::timestamptz = expires_at),
  CHECK ((decision_json->>'decidedAt')::timestamptz = decided_at)
);

CREATE TABLE codeops.workspace_checkpoint_cleanup_decisions (
  decision_id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES codeops.workspace_checkpoint_descriptors(checkpoint_id),
  authorized boolean NOT NULL,
  hold_revision bigint,
  retention_revision bigint,
  live_generation bigint,
  decision_json jsonb NOT NULL CHECK (decision_json->>'version' = 'codeops.checkpoint-cleanup-decision/v1'),
  decision_digest text NOT NULL UNIQUE CHECK (decision_digest ~ '^sha256:[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((decision_json->>'authorized')::boolean = authorized),
  CHECK (decision_json->>'checkpointId' = checkpoint_id::text),
  CHECK (decision_json->>'decisionId' = decision_id::text),
  CHECK ((decision_json->>'decidedAt')::timestamptz = decided_at),
  CHECK (NOT authorized OR (
    (decision_json->>'holdRevision')::bigint = hold_revision AND
    (decision_json->>'retentionRevision')::bigint = retention_revision AND
    (decision_json->>'liveGeneration')::bigint = live_generation AND
    (decision_json->>'consumedAt')::timestamptz = consumed_at)),
  CHECK ((authorized AND hold_revision IS NOT NULL AND retention_revision IS NOT NULL
      AND live_generation IS NOT NULL AND consumed_at IS NOT NULL)
      OR (NOT authorized AND hold_revision IS NULL AND retention_revision IS NULL
      AND live_generation IS NULL AND consumed_at IS NULL))
);

CREATE UNIQUE INDEX workspace_checkpoint_cleanup_consumption_once
  ON codeops.workspace_checkpoint_cleanup_decisions (checkpoint_id)
  WHERE authorized;

CREATE FUNCTION codeops.reject_verified_checkpoint_evidence_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verified checkpoint evidence is append-only';
END;
$$;

CREATE TRIGGER workspace_checkpoint_descriptors_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_descriptors
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_restore_receipts_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_restore_receipts
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_restore_operations_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_restore_operations
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_hold_events_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_hold_events
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_retention_decisions_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_retention_decisions
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_cleanup_decisions_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_cleanup_decisions
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();
CREATE TRIGGER workspace_checkpoint_artifacts_append_only
BEFORE UPDATE OR DELETE ON codeops.workspace_checkpoint_artifacts
FOR EACH ROW EXECUTE FUNCTION codeops.reject_verified_checkpoint_evidence_update();

COMMIT;
