BEGIN;

CREATE TABLE codeops.work_item_lifecycle (
  repository text NOT NULL,
  provider text NOT NULL
    CHECK (provider IN ('plane', 'github_issues', 'github_projects', 'custom')),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  work_item_id text NOT NULL,
  workflow_id text NOT NULL,
  run_id text NOT NULL,
  phase text NOT NULL
    CHECK (phase IN ('backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled')),
  attention text NOT NULL CHECK (attention IN ('clear', 'needed')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (repository, provider, workspace_id, project_id, work_item_id),
  UNIQUE (workflow_id, run_id),
  CHECK (attention = 'clear' OR phase NOT IN ('done', 'cancelled'))
);

CREATE TABLE codeops.work_item_lifecycle_events (
  event_id text PRIMARY KEY,
  transition_id text NOT NULL,
  transition_key text NOT NULL,
  repository text NOT NULL,
  provider text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  work_item_id text NOT NULL,
  workflow_id text NOT NULL,
  run_id text NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (repository, provider, workspace_id, project_id, work_item_id, sequence),
  UNIQUE (transition_id),
  FOREIGN KEY (repository, provider, workspace_id, project_id, work_item_id)
    REFERENCES codeops.work_item_lifecycle
      (repository, provider, workspace_id, project_id, work_item_id),
  CHECK (event_json->>'version' = 'codeops.work-item-lifecycle-event/v1'),
  CHECK (event_json->>'eventId' = event_id),
  CHECK (event_json->>'transitionId' = transition_id),
  CHECK (event_json->>'transitionKey' = transition_key),
  CHECK (
    concat(event_json#>>'{repository,owner}', '/', event_json#>>'{repository,name}')
      = repository
  ),
  CHECK (event_json#>>'{provider,kind}' = provider),
  CHECK (event_json#>>'{provider,workspaceId}' = workspace_id),
  CHECK (event_json#>>'{provider,projectId}' = project_id),
  CHECK (event_json->>'workItemId' = work_item_id),
  CHECK (event_json->>'workflowId' = workflow_id),
  CHECK (event_json->>'runId' = run_id),
  CHECK (event_json->>'sourceSha' = source_sha),
  CHECK ((event_json->>'sequence')::bigint = sequence),
  CHECK ((event_json->>'occurredAt')::timestamptz = created_at)
);

CREATE FUNCTION codeops.reject_work_item_lifecycle_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'work item lifecycle events are immutable';
END;
$$;

CREATE TRIGGER work_item_lifecycle_events_immutable
BEFORE UPDATE OR DELETE ON codeops.work_item_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION codeops.reject_work_item_lifecycle_event_mutation();

CREATE TABLE codeops.work_item_lifecycle_publications (
  event_id text PRIMARY KEY
    REFERENCES codeops.work_item_lifecycle_events(event_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'published')),
  available_at timestamptz NOT NULL,
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  jetstream_stream text,
  jetstream_sequence bigint,
  published_at timestamptz,
  CHECK (
    (status = 'pending' AND claim_token IS NULL AND claimed_by IS NULL
      AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND jetstream_stream IS NULL AND jetstream_sequence IS NULL
      AND published_at IS NULL)
    OR
    (status = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL AND claim_expires_at > claimed_at
      AND jetstream_stream IS NULL AND jetstream_sequence IS NULL
      AND published_at IS NULL)
    OR
    (status = 'published' AND claim_token IS NULL AND claimed_by IS NULL
      AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND jetstream_stream IS NOT NULL AND jetstream_sequence > 0
      AND published_at IS NOT NULL)
  )
);

CREATE INDEX work_item_lifecycle_publication_claim_idx
  ON codeops.work_item_lifecycle_publications (available_at, event_id)
  WHERE status IN ('pending', 'claimed');

COMMIT;
