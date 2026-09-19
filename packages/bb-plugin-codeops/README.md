# CodeOps for bb

One plugin owns durable run decisions. bb owns threads, environments and
conversation history. This package does not use the CodeOps dispatcher,
PostgreSQL, Temporal or JetStream.

## Compatibility and installation

The package pins `@get-bb/plugin-sdk` to **0.4.87**, verified with installed
**bb 0.43.1**. Run `nub install --frozen-lockfile` at the repository root, then
`bb plugin build packages/bb-plugin-codeops`. From this monorepo, install with
`bb plugin install path:. --plugin codeops`. No release is published by this
change. The SDK's source license and artifact review are recorded in
`THIRD_PARTY_NOTICES.md`.

`bb plugin types --check` confirms the SDK pin but recommends adding every
host UI shim package. This package imports none of those optional shims; it
uses React and the public app SDK directly. Do not add unused UI dependencies
solely to silence that broad recommendation.

## Admit a run

Admission uses bb's existing shared trust model. There is no per-project
allowlist or read-only reviewer permission requirement. Known native project,
parent, environment, repository and candidate identities are still checked.
The admitted brief freezes implementation/check/review scope; it does not
claim human-authenticated approval provenance. Users authorize the outcome
in the controlling thread. Fine-grained project and read/write restrictions
belong to a future external boundary, not this package.

Use `bb codeops command '<JSON>'`, the `codeops_command` tool, or panel actions.
All surfaces call the same handler. A start command has this shape:

```json
{
  "op": "start",
  "brief": {
    "key": "parser-fix-1",
    "projectId": "<bb-project-id>",
    "parentThreadId": "<current-thread-id>",
    "environmentId": "<current-managed-worktree-id>",
    "repository": "https://github.com/example/repository",
    "base": "<exact-40-character-base-SHA>",
    "outcome": "Reject malformed input",
    "scope": ["Parser only"],
    "acceptance": ["Malformed tokens fail"],
    "checks": [{"name": "unit", "argv": ["node", "--test"]}],
    "correctionLimit": 1,
    "intent": {"provider": "local", "item": "parser-fix", "revision": "1"}
  }
}
```

Use `{"op":"list"}`, `{"op":"get","id":"<run>"}`, or
`{"op":"reconcile","id":"<run>"}` for inspection/readback. Pause, resume
and cancel also require the current `revision`. An idempotency key cannot be
reused with a changed brief. Scope changes require a new admission after the
old run stops. No command accepts an actor, human approval, check result or
review report from its caller.

## Implemented behavior and boundaries

- SQLite atomically saves the frozen brief/policy, decisions and action intent.
  One unfinished run reserves its implementation environment. Native workers are claimed before spawn. Correlated children are read back
  after an unknown result; zero or multiple matches block retries.
- A worker must leave a clean commit. Host RPC verifies repository/base/head,
  changed paths and tree. It executes checks from a `git archive` snapshot in
  Bubblewrap with no network, inherited credentials or home mount. Checks use
  committed inputs/system tools only; dependency caches are not mounted.
  Unsupported isolation blocks. Check records bind argv and output digests,
  exact head/tree, exit status and launcher identity. Raw output is not stored.
- Native reviewers use a new managed worktree at the candidate. Their report
  binds scope, candidate, tree and check evidence. Required findings trigger
  bounded corrections. A model turn alone never passes a gate.
- Native review uses bb's shared trust model. A fresh reviewer thread and
  worktree give independent context, not security isolation. An accepting
  candidate-bound report passes G4; the reviewer does not issue authority.
- G5 publication is manual: no separated publisher exists in this package.
  G6 merge and G7 release/deploy always require separate human authority and
  live provider facts. G8 cannot mark Done or admit dependents without the
  terminal milestone. No merge, release, deploy or infrastructure executor is
  registered. No review-ready PR is claimed until external publication readback exists.
- G0/G1 enforce native project and repository identities, required fields,
  duplicate keys and frozen scope. G2 captures a candidate; G3 verifies exact
  check evidence; G4 processes bounded advisory review. Exceptions preserve
  the interrupted phase. Stopping persists until readback confirms termination. Resume replaces an
  interrupted child only after that confirmation. Failed or unknown stops
  never become cancellation success. Uncertain check effects need manual inspection.
- Reconciliation wakes on native idle/failure events and each minute for
  running/waiting runs. A NeedsAttention run requires explicit reconciliation
  or resume. Native metadata is correlation, not a security credential. All
  plugins and unrestricted local shell users remain in the trusted base.
- Jev has a typed shadow/unavailable/uncertain contract. No transport, invented
  response or credential is present. Deterministic work does not call Jev.

The panel displays stage, condition, candidate and evidence. A changed
attention reason marks the parent thread unread; bb owns notification delivery.
This is an attention signal, not a claim that a push was delivered. Export a
run with `get` before uninstall; preserve the plugin SQLite database until all
unfinished work and evidence have an explicit retention decision. No automatic
uninstall cleanup or artifact deletion is implemented.

## Qualification

Run focused tests, `nub run check:licenses`, `nub run verify`,
`nub run acceptance:agents-ui`, and `bb plugin build packages/bb-plugin-codeops`.
Tests use SQLite and the published SDK harness without production credentials.
A live Bubblewrap success path and native worker/reviewer end-to-end proof must
also pass on a capable host before claiming the vertical slice qualified.

See [work-management proposal](../../docs/design/bb-plugin-work-management.md)
and [Kubernetes machine proposal](../../docs/design/bb-plugin-kubernetes-machines.md).
Both are proposals only; no external integrations or resources are provisioned.
