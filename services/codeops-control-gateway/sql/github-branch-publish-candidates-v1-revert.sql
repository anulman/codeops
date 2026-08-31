BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM codeops.github_branch_publish_candidate_manifests
  ) THEN
    RAISE EXCEPTION 'cannot remove GitHub branch candidates while immutable manifests exist';
  END IF;
END;
$$;

DROP TRIGGER github_branch_publish_candidate_chunks_immutable
  ON codeops.github_branch_publish_candidate_chunks;
DROP TRIGGER github_branch_publish_candidate_manifests_immutable
  ON codeops.github_branch_publish_candidate_manifests;
DROP FUNCTION codeops.reject_github_branch_publish_candidate_mutation();
DROP TABLE codeops.github_branch_publish_candidate_chunks;
DROP TABLE codeops.github_branch_publish_candidate_manifests;
DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'github-branch-publish-candidates-v1';

COMMIT;
