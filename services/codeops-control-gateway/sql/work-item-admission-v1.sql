BEGIN;

ALTER TABLE codeops.session_runtime_outbox
  ADD CONSTRAINT session_runtime_outbox_admission_authority_key
  UNIQUE (dispatch_id, session_id, principal_id);
ALTER TABLE codeops.session_runtime_permission_requests
  ADD CONSTRAINT session_runtime_permission_requests_admission_authority_key
  UNIQUE (dispatch_id, request_id, session_id);
ALTER TABLE codeops.session_events
  ADD CONSTRAINT session_events_admission_authority_key
  UNIQUE (event_id, session_id);
ALTER TABLE codeops.session_commands
  ADD CONSTRAINT session_commands_admission_authority_key
  UNIQUE (command_id, session_id, principal_id);
ALTER TABLE codeops.work_item_lifecycle_events
  ADD CONSTRAINT work_item_lifecycle_events_admission_owner_key
  UNIQUE (event_id, repository, provider, workspace_id, project_id, work_item_id);

CREATE TABLE codeops.project_plan_approvals (
  approval_id uuid PRIMARY KEY,
  parent_session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  dispatch_id uuid NOT NULL,
  permission_request_id text NOT NULL,
  plan_event_id text NOT NULL,
  plan_id text NOT NULL CHECK (length(plan_id) BETWEEN 1 AND 500),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision_command_id uuid NOT NULL,
  approved_by_principal_id text NOT NULL
    CHECK (approved_by_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  authority_digest text NOT NULL UNIQUE CHECK (authority_digest ~ '^sha256:[0-9a-f]{64}$'),
  authority_json jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  UNIQUE (dispatch_id, permission_request_id),
  CONSTRAINT project_plan_approvals_admission_owner_key
    UNIQUE (approval_id, parent_session_id),
  FOREIGN KEY (dispatch_id, parent_session_id, approved_by_principal_id)
    REFERENCES codeops.session_runtime_outbox(dispatch_id, session_id, principal_id),
  FOREIGN KEY (dispatch_id, permission_request_id, parent_session_id)
    REFERENCES codeops.session_runtime_permission_requests(dispatch_id, request_id, session_id),
  FOREIGN KEY (plan_event_id, parent_session_id)
    REFERENCES codeops.session_events(event_id, session_id),
  FOREIGN KEY (decision_command_id, parent_session_id, approved_by_principal_id)
    REFERENCES codeops.session_commands(command_id, session_id, principal_id),
  CHECK (authority_json->>'version' IS NOT NULL AND
    authority_json->>'version' = 'codeops.project-plan-approval-authority/v1'),
  CHECK ((authority_json->>'approvalId')::uuid = approval_id),
  CHECK (authority_json->>'parentSessionId' = parent_session_id),
  CHECK ((authority_json->>'dispatchId')::uuid = dispatch_id),
  CHECK (authority_json->>'permissionRequestId' = permission_request_id),
  CHECK (authority_json->>'planEventId' = plan_event_id),
  CHECK (authority_json->>'planId' = plan_id),
  CHECK (authority_json->>'planDigest' = plan_digest),
  CHECK ((authority_json->>'decisionCommandId')::uuid = decision_command_id),
  CHECK (authority_json->>'approvedByPrincipalId' = approved_by_principal_id),
  CHECK (jsonb_typeof(authority_json->'workItems') = 'array'),
  CHECK (COALESCE((authority_json->'parentDispatch') ?&
    ARRAY['dispatchId','principalId','command'], false)),
  CHECK (COALESCE((authority_json->'permissionRequest'->'request') ?&
    ARRAY['requestId','operation'], false)),
  CHECK (COALESCE((authority_json->'permissionRequest'->'request'->'operation') ?&
    ARRAY['kind','planId','planDigest','workItems'], false)),
  CHECK (COALESCE((authority_json->'planEvent') ?&
    ARRAY['eventId','sessionId','update'], false)),
  CHECK (COALESCE((authority_json->'decisionCommand') ?&
    ARRAY['sessionId','generation','leaseId','idempotencyKey','type','permissionRequestId'], false)),
  CHECK (COALESCE((authority_json->'decisionResult') ?&
    ARRAY['commandId','sessionId','generation','leaseId','idempotencyKey','type','disposition','eventCursor','snapshot'], false)),
  CHECK (COALESCE((authority_json->'decisionResult'->'snapshot') ?&
    ARRAY['sessionId','generation','lease','eventCursor'], false)),
  CHECK ((authority_json#>>'{parentDispatch,dispatchId}')::uuid IS NOT DISTINCT FROM dispatch_id),
  CHECK (authority_json#>>'{parentDispatch,command,sessionId}' IS NOT DISTINCT FROM parent_session_id),
  CHECK (authority_json#>>'{parentDispatch,principalId}' IS NOT DISTINCT FROM approved_by_principal_id),
  CHECK (authority_json#>>'{permissionRequest,request,requestId}' IS NOT DISTINCT FROM permission_request_id),
  CHECK (authority_json#>>'{permissionRequest,request,operation,kind}' IS NOT DISTINCT FROM 'project_plan'),
  CHECK (authority_json#>>'{permissionRequest,request,operation,planId}' IS NOT DISTINCT FROM plan_id),
  CHECK (authority_json#>>'{permissionRequest,request,operation,planDigest}' IS NOT DISTINCT FROM plan_digest),
  CHECK (authority_json#>'{permissionRequest,request,operation,workItems}' = authority_json->'workItems'),
  CHECK (authority_json#>>'{planEvent,eventId}' IS NOT DISTINCT FROM plan_event_id),
  CHECK (authority_json#>>'{planEvent,sessionId}' IS NOT DISTINCT FROM parent_session_id),
  CHECK (authority_json#>>'{planEvent,update,kind}' IS NOT DISTINCT FROM 'plan_update'),
  CHECK (authority_json#>>'{planEvent,update,planId}' IS NOT DISTINCT FROM plan_id),
  CHECK (authority_json#>>'{decisionCommand,sessionId}' IS NOT DISTINCT FROM parent_session_id),
  CHECK (authority_json#>>'{decisionCommand,type}' IS NOT DISTINCT FROM 'respond_permission'),
  CHECK (authority_json#>>'{decisionCommand,permissionRequestId}' IS NOT DISTINCT FROM permission_request_id),
  CHECK ((authority_json#>>'{decisionResult,commandId}')::uuid IS NOT DISTINCT FROM decision_command_id),
  CHECK (authority_json#>>'{decisionResult,sessionId}' IS NOT DISTINCT FROM parent_session_id),
  CHECK (authority_json#>>'{decisionResult,disposition}' IS NOT DISTINCT FROM 'committed'),
  CHECK (authority_json#>>'{decisionResult,generation}' = authority_json#>>'{decisionCommand,generation}'),
  CHECK (authority_json#>>'{decisionResult,leaseId}' = authority_json#>>'{decisionCommand,leaseId}'),
  CHECK (authority_json#>>'{decisionResult,type}' = authority_json#>>'{decisionCommand,type}'),
  CHECK (authority_json#>>'{decisionResult,idempotencyKey}' = authority_json#>>'{decisionCommand,idempotencyKey}'),
  CHECK (authority_json#>>'{decisionResult,eventCursor}' = authority_json#>>'{decisionResult,snapshot,eventCursor}'),
  CHECK (authority_json#>>'{decisionResult,snapshot,sessionId}' IS NOT DISTINCT FROM parent_session_id),
  CHECK (authority_json#>>'{decisionResult,snapshot,generation}' = authority_json#>>'{decisionResult,generation}'),
  CHECK (authority_json#>>'{decisionResult,snapshot,lease,leaseId}' = authority_json#>>'{decisionResult,leaseId}'),
  CHECK ((authority_json->>'approvedAt')::timestamptz = approved_at)
);

CREATE FUNCTION codeops.reject_project_plan_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'project plan approvals are immutable'; END;
$$;
CREATE TRIGGER project_plan_approvals_immutable
BEFORE UPDATE OR DELETE ON codeops.project_plan_approvals
FOR EACH ROW EXECUTE FUNCTION codeops.reject_project_plan_approval_mutation();

CREATE TABLE codeops.work_item_admissions (
  admission_id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES codeops.project_plan_approvals(approval_id),
  parent_session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  child_session_id text NOT NULL UNIQUE REFERENCES codeops.sessions(session_id),
  child_dispatch_id uuid NOT NULL UNIQUE,
  child_event_id text NOT NULL UNIQUE REFERENCES codeops.session_events(event_id),
  repository text NOT NULL,
  provider text NOT NULL CHECK (provider = 'plane'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  work_item_id text NOT NULL,
  workflow_id text NOT NULL,
  run_id text NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  lifecycle_event_id text NOT NULL UNIQUE REFERENCES codeops.work_item_lifecycle_events(event_id),
  supervision_event_id text NOT NULL UNIQUE REFERENCES codeops.session_events(event_id),
  authority_digest text NOT NULL UNIQUE CHECK (authority_digest ~ '^sha256:[0-9a-f]{64}$'),
  authority_json jsonb NOT NULL,
  admitted_at timestamptz NOT NULL,
  UNIQUE (approval_id, repository, provider, workspace_id, project_id, work_item_id),
  UNIQUE (admission_id, child_dispatch_id),
  CONSTRAINT work_item_admissions_child_outbox_key
    UNIQUE (admission_id, child_dispatch_id, child_session_id),
  UNIQUE (repository, provider, workspace_id, project_id, work_item_id),
  CONSTRAINT work_item_admissions_approval_parent_fk
    FOREIGN KEY (approval_id, parent_session_id)
    REFERENCES codeops.project_plan_approvals(approval_id, parent_session_id),
  CONSTRAINT work_item_admissions_child_event_fk
    FOREIGN KEY (child_event_id, child_session_id)
    REFERENCES codeops.session_events(event_id, session_id),
  CONSTRAINT work_item_admissions_supervision_event_fk
    FOREIGN KEY (supervision_event_id, parent_session_id)
    REFERENCES codeops.session_events(event_id, session_id),
  CONSTRAINT work_item_admissions_lifecycle_event_fk
    FOREIGN KEY (lifecycle_event_id, repository, provider, workspace_id, project_id, work_item_id)
    REFERENCES codeops.work_item_lifecycle_events
      (event_id, repository, provider, workspace_id, project_id, work_item_id),
  FOREIGN KEY (repository, provider, workspace_id, project_id, work_item_id)
    REFERENCES codeops.work_item_lifecycle(repository, provider, workspace_id, project_id, work_item_id),
  CHECK (authority_json->>'version' IS NOT NULL AND
    authority_json->>'version' = 'codeops.work-item-admission-authority/v1'),
  CHECK ((authority_json->>'admissionId')::uuid = admission_id),
  CHECK ((authority_json->>'approvalId')::uuid = approval_id),
  CHECK (authority_json->>'parentSessionId' = parent_session_id),
  CHECK (authority_json->>'childSessionId' = child_session_id),
  CHECK ((authority_json->>'dispatchId')::uuid = child_dispatch_id),
  CHECK (authority_json->>'childEventId' = child_event_id),
  CHECK (authority_json->>'repository' = repository),
  CHECK (authority_json#>>'{provider,kind}' = provider),
  CHECK (authority_json#>>'{provider,workspaceId}' = workspace_id),
  CHECK (authority_json#>>'{provider,projectId}' = project_id),
  CHECK (authority_json->>'workItemId' = work_item_id),
  CHECK (authority_json->>'workflowId' = workflow_id),
  CHECK (authority_json->>'runId' = run_id),
  CHECK (authority_json->>'sourceSha' = source_sha),
  CHECK (authority_json->>'lifecycleEventId' = lifecycle_event_id),
  CHECK (authority_json->>'supervisionEventId' = supervision_event_id),
  CHECK (COALESCE((authority_json->'request') ?& ARRAY['admissionId','workItem','child'], false)),
  CHECK (COALESCE((authority_json->'request'->'workItem') ?&
    ARRAY['repository','provider','workItemId','workflowId','runId','sourceSha'], false)),
  CHECK (COALESCE((authority_json->'request'->'child') ?& ARRAY['sessionId','dispatchId'], false)),
  CHECK (COALESCE((authority_json->'childSnapshot') ? 'sessionId', false)),
  CHECK (COALESCE((authority_json->'childEvent') ? 'eventId', false)),
  CHECK (COALESCE((authority_json->'dispatch') ? 'dispatchId', false)),
  CHECK (COALESCE((authority_json->'lifecycleEvent') ? 'eventId', false)),
  CHECK (COALESCE((authority_json->'supervisionEvent') ? 'eventId', false)),
  CHECK ((authority_json#>>'{request,admissionId}')::uuid IS NOT DISTINCT FROM admission_id),
  CHECK (authority_json#>>'{request,workItem,repository}' IS NOT DISTINCT FROM repository),
  CHECK (authority_json#>>'{request,workItem,provider,kind}' IS NOT DISTINCT FROM provider),
  CHECK (authority_json#>>'{request,workItem,provider,workspaceId}' IS NOT DISTINCT FROM workspace_id),
  CHECK (authority_json#>>'{request,workItem,provider,projectId}' IS NOT DISTINCT FROM project_id),
  CHECK (authority_json#>>'{request,workItem,workItemId}' IS NOT DISTINCT FROM work_item_id),
  CHECK (authority_json#>>'{request,workItem,workflowId}' IS NOT DISTINCT FROM workflow_id),
  CHECK (authority_json#>>'{request,workItem,runId}' IS NOT DISTINCT FROM run_id),
  CHECK (authority_json#>>'{request,workItem,sourceSha}' IS NOT DISTINCT FROM source_sha),
  CHECK (authority_json#>>'{request,child,sessionId}' IS NOT DISTINCT FROM child_session_id),
  CHECK ((authority_json#>>'{request,child,dispatchId}')::uuid IS NOT DISTINCT FROM child_dispatch_id),
  CHECK (authority_json#>>'{childSnapshot,sessionId}' IS NOT DISTINCT FROM child_session_id),
  CHECK (authority_json#>>'{childEvent,eventId}' IS NOT DISTINCT FROM child_event_id),
  CHECK ((authority_json#>>'{dispatch,dispatchId}')::uuid IS NOT DISTINCT FROM child_dispatch_id),
  CHECK (authority_json#>>'{lifecycleEvent,eventId}' IS NOT DISTINCT FROM lifecycle_event_id),
  CHECK (authority_json#>>'{supervisionEvent,eventId}' IS NOT DISTINCT FROM supervision_event_id),
  CHECK ((authority_json->>'admittedAt')::timestamptz = admitted_at)
);

CREATE FUNCTION codeops.reject_work_item_admission_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work item admissions are immutable'; END;
$$;
CREATE TRIGGER work_item_admissions_immutable
BEFORE UPDATE OR DELETE ON codeops.work_item_admissions
FOR EACH ROW EXECUTE FUNCTION codeops.reject_work_item_admission_mutation();

ALTER TABLE codeops.session_runtime_outbox
  ADD COLUMN admission_id uuid UNIQUE REFERENCES codeops.work_item_admissions(admission_id);
ALTER TABLE codeops.session_runtime_outbox
  ADD CONSTRAINT session_runtime_outbox_admission_child_fk
  FOREIGN KEY (admission_id, dispatch_id, session_id)
  REFERENCES codeops.work_item_admissions(admission_id, child_dispatch_id, child_session_id);

COMMIT;
