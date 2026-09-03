BEGIN;

ALTER TABLE codeops.work_item_admissions
  ADD CONSTRAINT work_item_admissions_materialization_owner_key UNIQUE
    (admission_id, approval_id, parent_session_id, child_session_id,
     child_dispatch_id, repository, provider, workspace_id, project_id,
     work_item_id, workflow_id, run_id, source_sha, authority_digest);
ALTER TABLE codeops.project_plan_approvals
  ADD CONSTRAINT project_plan_approvals_materialization_owner_key UNIQUE
    (approval_id, authority_digest);
ALTER TABLE codeops.session_runtime_outbox
  ADD COLUMN dispatch_digest text
    CHECK (dispatch_digest IS NULL OR dispatch_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE codeops.session_runtime_outbox
  ADD COLUMN is_admitted_initial_dispatch boolean NOT NULL DEFAULT false;
UPDATE codeops.session_runtime_outbox
   SET is_admitted_initial_dispatch=true
 WHERE admission_id IS NOT NULL;
ALTER TABLE codeops.session_runtime_outbox
  ADD CONSTRAINT session_runtime_outbox_initial_dispatch_marker
  CHECK (is_admitted_initial_dispatch = (admission_id IS NOT NULL));
ALTER TABLE codeops.session_runtime_outbox
  ADD CONSTRAINT session_runtime_outbox_materialization_dispatch_key UNIQUE
    (dispatch_id, session_id, principal_id, dispatch_digest);

CREATE TABLE codeops.admitted_child_materializations (
  admission_id uuid PRIMARY KEY,
  admission_digest text NOT NULL CHECK (admission_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_id uuid NOT NULL,
  approval_digest text NOT NULL CHECK (approval_digest ~ '^sha256:[0-9a-f]{64}$'),
  parent_session_id text NOT NULL,
  child_session_id text NOT NULL UNIQUE,
  child_dispatch_id uuid NOT NULL UNIQUE,
  initial_dispatch_digest text NOT NULL
    CHECK (initial_dispatch_digest ~ '^sha256:[0-9a-f]{64}$'),
  principal_id text NOT NULL
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  repository text NOT NULL,
  provider text NOT NULL CHECK (provider = 'plane'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  work_item_id text NOT NULL,
  workflow_id text NOT NULL,
  run_id text NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  lease_id uuid NOT NULL,
  input_digest text NOT NULL UNIQUE CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  initial_dispatch_json jsonb GENERATED ALWAYS AS
    (input_json->'initialDispatch') STORED,
  state text NOT NULL CHECK (state IN
    ('queued','provisioning','runtime-authorized','success-finalizing',
     'cleanup-pending','ready','failed')),
  state_json jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100000),
  reconciliation_owner text,
  reconciliation_token uuid,
  reconciliation_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT admitted_child_materializations_admission_fk FOREIGN KEY
    (admission_id, approval_id, parent_session_id, child_session_id,
     child_dispatch_id, repository, provider, workspace_id, project_id,
     work_item_id, workflow_id, run_id, source_sha, admission_digest)
    REFERENCES codeops.work_item_admissions
    (admission_id, approval_id, parent_session_id, child_session_id,
     child_dispatch_id, repository, provider, workspace_id, project_id,
     work_item_id, workflow_id, run_id, source_sha, authority_digest),
  CONSTRAINT admitted_child_materializations_approval_fk FOREIGN KEY
    (approval_id, approval_digest)
    REFERENCES codeops.project_plan_approvals(approval_id, authority_digest),
  CONSTRAINT admitted_child_materializations_dispatch_fk FOREIGN KEY
    (child_dispatch_id, child_session_id, principal_id, initial_dispatch_digest)
    REFERENCES codeops.session_runtime_outbox
      (dispatch_id, session_id, principal_id, dispatch_digest)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (input_json->>'version' = 'codeops.admitted-child-materialization-input/v1'),
  CHECK ((input_json->>'admissionId')::uuid = admission_id),
  CHECK (input_json->>'admissionDigest' = admission_digest),
  CHECK ((input_json->>'approvalId')::uuid = approval_id),
  CHECK (input_json->>'approvalDigest' = approval_digest),
  CHECK (input_json->>'parentSessionId' = parent_session_id),
  CHECK (input_json->>'childSessionId' = child_session_id),
  CHECK ((input_json->>'childDispatchId')::uuid = child_dispatch_id),
  CHECK (input_json->>'principalId' = principal_id),
  CHECK (input_json#>>'{workItem,repository}' = repository),
  CHECK (input_json#>>'{workItem,provider,kind}' = provider),
  CHECK (input_json#>>'{workItem,provider,workspaceId}' = workspace_id),
  CHECK (input_json#>>'{workItem,provider,projectId}' = project_id),
  CHECK (input_json#>>'{workItem,workItemId}' = work_item_id),
  CHECK (input_json->>'workflowId' = workflow_id),
  CHECK (input_json->>'runId' = run_id),
  CHECK (input_json#>>'{workItem,sourceSha}' = source_sha),
  CHECK ((input_json->>'generation')::bigint = generation),
  CHECK ((input_json#>>'{lease,leaseId}')::uuid = lease_id),
  CHECK (jsonb_typeof(input_json->'contextAttachments') = 'array'),
  CHECK (COALESCE((input_json->'images') ?& ARRAY['agent','runtimeWorker'], false)),
  CHECK (COALESCE((input_json->'initialDispatch') ?& ARRAY['dispatchId','principalId','command','snapshot'], false)),
  CHECK (state_json->>'version' = 'codeops.admitted-child-materialization-state/v1'),
  CHECK ((state_json->>'admissionId')::uuid = admission_id),
  CHECK (state_json->>'inputDigest' = input_digest),
  CHECK (state_json->>'state' = state),
  CHECK ((state_json->>'attemptCount')::integer = attempt_count),
  CHECK ((state_json->>'createdAt')::timestamptz = created_at),
  CHECK ((state_json->>'updatedAt')::timestamptz = updated_at),
  CHECK (updated_at >= created_at),
  CHECK ((reconciliation_owner IS NULL AND reconciliation_token IS NULL AND
          reconciliation_expires_at IS NULL) OR
         (reconciliation_owner IS NOT NULL AND reconciliation_token IS NOT NULL AND
          reconciliation_expires_at IS NOT NULL))
);

CREATE FUNCTION codeops.guard_admitted_child_materialization_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admitted child materializations cannot be deleted';
  END IF;
  IF (NEW.admission_id, NEW.admission_digest, NEW.approval_id, NEW.approval_digest, NEW.parent_session_id,
      NEW.child_session_id, NEW.child_dispatch_id, NEW.initial_dispatch_digest, NEW.principal_id,
      NEW.repository, NEW.provider, NEW.workspace_id, NEW.project_id,
      NEW.work_item_id, NEW.workflow_id, NEW.run_id, NEW.source_sha,
      NEW.generation, NEW.lease_id, NEW.input_digest, NEW.input_json,
      NEW.created_at) IS DISTINCT FROM
     (OLD.admission_id, OLD.admission_digest, OLD.approval_id, OLD.approval_digest, OLD.parent_session_id,
      OLD.child_session_id, OLD.child_dispatch_id, OLD.initial_dispatch_digest, OLD.principal_id,
      OLD.repository, OLD.provider, OLD.workspace_id, OLD.project_id,
      OLD.work_item_id, OLD.workflow_id, OLD.run_id, OLD.source_sha,
      OLD.generation, OLD.lease_id, OLD.input_digest, OLD.input_json,
      OLD.created_at) THEN
    RAISE EXCEPTION 'admitted child materialization input is immutable';
  END IF;
  IF OLD.state IN ('ready','failed') THEN
    RAISE EXCEPTION 'terminal admitted child materialization is immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR
     (OLD.state = 'queued' AND NEW.state NOT IN ('queued','provisioning','cleanup-pending')) OR
     (OLD.state = 'provisioning' AND NEW.state NOT IN
       ('provisioning','runtime-authorized','cleanup-pending')) OR
     (OLD.state = 'runtime-authorized' AND NEW.state NOT IN
       ('runtime-authorized','success-finalizing','cleanup-pending')) OR
     (OLD.state = 'success-finalizing' AND NEW.state NOT IN
       ('success-finalizing','cleanup-pending','ready')) OR
     (OLD.state = 'cleanup-pending' AND NEW.state NOT IN ('cleanup-pending','failed')) THEN
    RAISE EXCEPTION 'admitted child materialization state cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admitted_child_materializations_guard
BEFORE UPDATE OR DELETE ON codeops.admitted_child_materializations
FOR EACH ROW EXECUTE FUNCTION codeops.guard_admitted_child_materialization_update();

CREATE FUNCTION codeops.require_admitted_child_materialization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM codeops.admitted_child_materializations
                  WHERE admission_id=NEW.admission_id) THEN
    RAISE EXCEPTION 'work-item admission requires a materialization owner';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER work_item_admissions_require_materialization_owner
AFTER INSERT ON codeops.work_item_admissions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION codeops.require_admitted_child_materialization_owner();

COMMIT;
