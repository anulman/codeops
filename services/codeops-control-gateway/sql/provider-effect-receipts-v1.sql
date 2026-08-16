BEGIN;

CREATE TABLE codeops.provider_effect_receipts (
  effect_id text PRIMARY KEY
    CHECK (effect_id ~ '^githubmutation-[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('github')),
  repository text NOT NULL
    CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  operation text NOT NULL CHECK (operation IN (
    'pull_request_update_branch',
    'pull_request_update',
    'review_thread_reply',
    'check_rerun'
  )),
  pull_request_number integer CHECK (pull_request_number > 0),
  target_id text CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 256),
  expected_head_sha text NOT NULL CHECK (expected_head_sha ~ '^[0-9a-f]{40}$'),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  dispatch_id uuid NOT NULL REFERENCES codeops.session_runtime_outbox(dispatch_id),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_digest text NOT NULL CHECK (permission_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'authorized',
    'attempting',
    'succeeded',
    'failed',
    'unknown',
    'reconciled_satisfied',
    'reconciled_not_observed',
    'operator_resolved'
  )),
  evidence_json jsonb,
  resolution_summary text CHECK (
    resolution_summary IS NULL OR length(resolution_summary) BETWEEN 1 AND 1000
  ),
  resolved_by text CHECK (
    resolved_by IS NULL OR (length(resolved_by) BETWEEN 1 AND 256
      AND resolved_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$')
  ),
  reconciliation_action text NOT NULL CHECK (reconciliation_action IN (
    'none',
    'inspect_pull_request',
    'search_review_thread_marker',
    'compare_pull_request_head',
    'inspect_check_attempts',
    'operator_review'
  )),
  authorized_at timestamptz NOT NULL,
  attempted_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (attempted_at IS NULL OR attempted_at >= authorized_at),
  CHECK (resolved_at IS NULL OR (attempted_at IS NOT NULL AND resolved_at >= attempted_at)),
  CHECK (
    (state = 'authorized' AND attempted_at IS NULL AND resolved_at IS NULL)
    OR
    (state IN ('attempting', 'unknown') AND attempted_at IS NOT NULL AND resolved_at IS NULL)
    OR
    (state IN (
      'succeeded', 'failed', 'reconciled_satisfied',
      'reconciled_not_observed', 'operator_resolved'
    ) AND attempted_at IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_summary IS NOT NULL)
  ),
  CHECK (state <> 'succeeded' OR evidence_json IS NOT NULL)
);

INSERT INTO codeops.provider_effect_receipts (
  effect_id,
  provider,
  repository,
  operation,
  pull_request_number,
  target_id,
  expected_head_sha,
  session_id,
  dispatch_id,
  payload_digest,
  permission_digest,
  state,
  evidence_json,
  resolution_summary,
  reconciliation_action,
  authorized_at,
  attempted_at,
  resolved_at,
  updated_at
)
SELECT
  legacy.operation_id,
  'github',
  permission.request_json #>> '{request,operation,repository}',
  permission.request_json #>> '{request,operation,operation}',
  (permission.request_json #>> '{request,operation,pullRequestNumber}')::integer,
  permission.request_json #>> '{request,operation,targetId}',
  permission.request_json #>> '{request,operation,expectedHeadSha}',
  permission.session_id,
  legacy.dispatch_id,
  legacy.payload_digest,
  legacy.permission_digest,
  CASE legacy.status WHEN 'completed' THEN 'succeeded' ELSE 'unknown' END,
  legacy.result_json,
  CASE legacy.status
    WHEN 'completed' THEN 'Validated legacy GitHub mutation result.'
    ELSE NULL
  END,
  CASE
    WHEN legacy.status = 'completed' THEN 'none'
    WHEN permission.request_json #>> '{request,operation,operation}' = 'pull_request_update' THEN 'inspect_pull_request'
    WHEN permission.request_json #>> '{request,operation,operation}' = 'review_thread_reply' THEN 'search_review_thread_marker'
    WHEN permission.request_json #>> '{request,operation,operation}' = 'pull_request_update_branch' THEN 'compare_pull_request_head'
    WHEN permission.request_json #>> '{request,operation,operation}' = 'check_rerun' THEN 'inspect_check_attempts'
    ELSE 'operator_review'
  END,
  legacy.started_at,
  legacy.started_at,
  legacy.completed_at,
  COALESCE(legacy.completed_at, legacy.started_at)
FROM codeops.session_runtime_github_mutations AS legacy
JOIN codeops.session_runtime_permission_requests AS permission
  ON permission.dispatch_id = legacy.dispatch_id
 AND permission.request_json->>'toolCallId' = legacy.operation_id;

DO $$
BEGIN
  IF (SELECT count(*) FROM codeops.provider_effect_receipts) <>
     (SELECT count(*) FROM codeops.session_runtime_github_mutations) THEN
    RAISE EXCEPTION 'provider effect migration could not recover every authorization identity';
  END IF;
END;
$$;

DROP TABLE codeops.session_runtime_github_mutations;

CREATE INDEX provider_effect_receipts_dispatch_authorized_idx
  ON codeops.provider_effect_receipts (dispatch_id, authorized_at);

CREATE INDEX provider_effect_receipts_attention_idx
  ON codeops.provider_effect_receipts (state, updated_at)
  WHERE state IN ('unknown', 'attempting');

COMMIT;
