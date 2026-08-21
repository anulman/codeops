BEGIN;

ALTER TABLE codeops.provider_effect_receipts
  DROP CONSTRAINT provider_effect_receipts_operation_check;
ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_operation_check CHECK (operation IN (
    'branch_publish',
    'pull_request_create',
    'pull_request_update_branch',
    'pull_request_update',
    'review_thread_reply',
    'check_rerun'
  ));

ALTER TABLE codeops.provider_effect_receipts
  DROP CONSTRAINT provider_effect_receipts_reconciliation_action_check;
ALTER TABLE codeops.provider_effect_receipts
  ADD CONSTRAINT provider_effect_receipts_reconciliation_action_check CHECK (
    reconciliation_action IN (
      'none',
      'inspect_branch_commit',
      'search_pull_request_marker',
      'inspect_pull_request',
      'search_review_thread_marker',
      'compare_pull_request_head',
      'inspect_check_attempts',
      'operator_review'
    )
  );

COMMIT;
