BEGIN;

UPDATE codeops.sessions
SET snapshot_json = jsonb_set(
  snapshot_json,
  '{budget}',
  jsonb_build_object(
    'version', 'codeops.session-budget/v1',
    'startedAt', snapshot_json#>>'{budget,startedAt}',
    'observedAt', snapshot_json#>>'{budget,observedAt}',
    'limits', jsonb_build_object(
      'elapsedSeconds', (snapshot_json#>>'{budget,limits,elapsedSeconds}')::bigint,
      'totalTokens', (snapshot_json#>>'{budget,limits,outputTokens}')::bigint,
      'modelRequests', (snapshot_json#>>'{budget,limits,providerRequests}')::bigint,
      'activeChildren', (snapshot_json#>>'{budget,limits,activeChildren}')::bigint
    ),
    'usage', jsonb_build_object(
      'elapsedSeconds', (snapshot_json#>>'{budget,usage,elapsedSeconds}')::bigint,
      'totalTokens', LEAST(
        (snapshot_json#>>'{budget,limits,outputTokens}')::bigint,
        (snapshot_json#>>'{budget,usage,outputTokens}')::bigint +
          (snapshot_json#>>'{budget,reserved,outputTokens}')::bigint
      ),
      'modelRequests', (snapshot_json#>>'{budget,usage,providerRequests}')::bigint,
      'activeChildren', (snapshot_json#>>'{budget,usage,activeChildren}')::bigint
    ),
    'remaining', jsonb_build_object(
      'elapsedSeconds', (snapshot_json#>>'{budget,remaining,elapsedSeconds}')::bigint,
      'totalTokens', (snapshot_json#>>'{budget,remaining,outputTokens}')::bigint,
      'modelRequests', (snapshot_json#>>'{budget,remaining,providerRequests}')::bigint,
      'activeChildren', (snapshot_json#>>'{budget,remaining,activeChildren}')::bigint
    ),
    'exhaustedLimit', CASE snapshot_json#>>'{budget,exhaustedLimit}'
      WHEN 'provider_requests' THEN 'model_requests'
      WHEN 'output_tokens' THEN 'total_tokens'
      ELSE snapshot_json#>>'{budget,exhaustedLimit}'
    END
  )
)
WHERE snapshot_json#>>'{budget,version}' = 'codeops.session-budget/v2';

DROP TABLE IF EXISTS codeops.session_model_budget_reservations;
DROP TABLE IF EXISTS codeops.session_model_budgets;

COMMIT;
