# Exact publication qualification

This fixture uses the installation repository, with temporary refs under
`bb-qualification/publication/<repository-workflow-run digest>/`. It never changes
main, ordinary branches, tags, releases or repository settings. Identity includes
the repository, fixed workflow path and GitHub run ID, not the attempt number.
The run's immutable head SHA is the pinned source base. Synthetic base/head commits
contain only fixture data and no workflows. They do not execute repository content.

The candidate job copies only the reviewed preparation scripts and bound input into
a fresh nonroot, network-none, read-only-root container with no mounts or credentials.
The publisher job checks out a literal reviewed source SHA. It regenerates candidate
identity with fixed code, checks the artifact, and invokes the real `Publisher` and
`GithubPublication`. It never executes artifact code. Its short-lived repository
`GITHUB_TOKEN` has contents/pull-requests write and actions read only. Preparation
and dependency installation occur before the token is exposed to the entrypoint.
No PAT, worker auth, other account, model credential or production BB database is used.

The owner ref stores a manifest before base/head effects and a SQLite journal before
publisher effects. Manifest fields bind the run, workflow SHA, source SHA, base/head,
exact candidate/bundle digests, expiry and PR number. A restart reads this record;
unknown effects are reconciled, never interpreted as failure/absence. Colliding or
drifted refs/PRs stop cleanup and retain evidence. PR create/update response loss is
injected only AFTER actual effects. The publisher journal is reopened for recovery.

Cleanup runs in `finally` and a CI `always()` step. It closes only the exact owned PR,
checks every ref against its expected SHA, and uses Git's expected-old-SHA lease for
atomic compare-and-delete (not a history rewrite). REST ref DELETE is not used because
it lacks an expected-SHA precondition. No wildcard deletion is permitted. Completed
owner manifests remain as tombstones until expiry. The six-hour expiry path examines
at most100 owner manifests/300 namespace refs, requires a completed matching workflow
run and a24-hour expiry, and then removes exact owned refs/owner checkpoints. Unknown
or changed ownership blocks deletion. Concurrency serializes all qualification jobs.

CI and prevention ignore PRs only when their BASE is the reserved fixture namespace.
Ordinary PRs, including feature branches with similar HEAD names, keep their checks.
Release triggers require main/tags/manual dispatch; synthetic fixture trees contain
no workflows. Never rely solely on GITHUB_TOKEN event-recursion suppression: GitHub
can create approval-required PR workflow runs. No PR-target workflow is used.

## Reviewed bootstrap before merge

The source workflow initially has an all-zero trusted-source sentinel. It fails closed.
It is not evidence of a trusted source or permission grant. Bootstrap is two commits:

1. Independently qualify and review the fixture source commit on Draft PR157.
2. Replace the workflow sentinel with that exact reviewed commit SHA, review the
   workflow delta and publish it. Do not pin an unreviewed PR head dynamically.
3. Using authorized operator publication, create ONLY
   `bb-qualification/bootstrap-publication-<reviewed source SHA first12>` at the
   exact reviewed workflow commit. No overwrite if it exists with another SHA.
   The push trigger can run this new workflow without merging it onto main.
4. Read the workflow's exact head/attempt and sanitized receipts. Ordinary
   `workflow_dispatch` and scheduled expiry require the workflow on the default
   branch; no merge is performed for bootstrap. Before merge, crash cleanup uses a
   separately published exact reviewed workflow ref named
   `bb-qualification/bootstrap-publication-recover-<unique operator case>` to invoke
   the same bounded expiry path. Keep its exact ref/SHA receipt; delete bootstrap
   refs only by exact compare-and-delete after their workflow is terminal.

The operator must retain bootstrap ref/SHA creation receipts; these control-plane
refs are distinct from test base/head and may not be glob-deleted. Parent supervision
owns invoking pre-merge crash recovery if the first run is interrupted. This is the
concrete pre-default-branch recovery path, not a claim that schedules already run.

On initial readback, repository workflow permissions were read-default and Actions
PR creation/approval disabled (`can_approve_pull_request_reviews:false`). Do not
change this setting here. A CI create denial must be retained with cleanup evidence;
only the repository operator can resolve that setting. No alternate credentials or
worker-auth fallback is allowed. A denied run is not integration qualification.

## Independent local qualification

Use the existing parent credential-free isolated runner and unchanged V6 dependency
closure. New tests require only Node24 and Git:

```
node --test infra/ci/publication/ownership.test.mjs
nub run verify
```

No GitHub token is needed for these regressions. They cover deterministic real Git
candidate construction, identity/attempt stability, unknown create/close/delete,
idempotency, ownership/ref collisions, duplicate PRs, cleanup failure, expiry fences
and event recursion. These tests do not prove real GitHub behavior. Retain earlier
unchanged BB types/build/probe receipts; no unrelated proof rerun is requested.
