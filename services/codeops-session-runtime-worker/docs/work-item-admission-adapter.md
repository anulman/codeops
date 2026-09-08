# Ordinary work-item admission

This source repair adds `work_items.admit` to the installed work-items MCP
server. It completes the caller on base
`dcea1c22bfa5752d96008b218d61ba91233b4f96`. Qualification and deployment have
not run. The independent qualified integration tree and its evidence are not
changed by this repair.

## Scope and authority review

The existing work-items loopback broker, Plane repository registry, controller
provider client, runtime permission relay, admission guards, and materializer
already own the necessary authority. Reuse those components. The missing
operation was a durable plan append during an active prompt. ACP notifications
were only buffered for prompt completion, which is too late for admission.

The public ACP `plan_update` is content-compatible after normalization:
`{plan: {type: "markdown", planId, content: text}}` becomes
`{kind: "plan_update", planId, content: {type: "markdown", markdown: text}}`.
The older `plan` event lacks the required ID and content envelope. The new
operation generates exact canonical markdown; it does not accept arbitrary
agent event JSON.

No new tables or migration are needed. Existing session event constraints
already permit gateway-owned `acp_update` rows with a null command ID. The
session row lock serializes cursor assignment against permissions, completion,
and admission. Existing execution receipts supply restart fail-closed behavior.

## Supported caller

An active workspace coordinator calls the installed `work_items.admit` tool:

```json
{
  "repository": "example-org/example-repository",
  "workItemId": "11111111-1111-4111-8111-111111111111",
  "title": "Publish qualified candidate",
  "prompt": "Publish the exact authenticated candidate attachment through the existing GitHub tools and their permissions. Do not edit or test the qualified integration."
}
```

The item must already exist in the repository's configured Plane project. The
coordinator must have active first-claim prompt authority, an unexpired lease,
its exact selected source, and sufficient existing child budget. The tool does
not create a work item or grant GitHub authority to the coordinator.

1. The existing loopback broker accepts only these four bounded fields at
   `POST /v1/work-items/admit` on its existing port. Title is limited to 200
   characters; prompt to 20,000; the HTTP body to 64 KiB. It coalesces identical
   calls and limits a dispatch to 16 proposals.
2. The worker sends the bounded proposal to
   `POST /v1/session-runtime/dispatches/{dispatchId}/work-item-admission-plans`.
   Only the transport injects the worker claim token. The gateway selects the
   exact claimed source and asks the existing authenticated Plane controller
   for `/v1/work-items/membership`. That controller selects workspace/project
   from its trusted repository registry and verifies the returned item ID, project and workspace against both item
   and project snapshots using its existing project-scoped client.
3. The gateway locks session then outbox, rechecks worker/claim, generation,
   lease, source and context, and appends the exact plan with its next cursor.
   Plan and child IDs derive from dispatch/repository/work-item identity.
   Changed prompt, title, source, project, or attachment descriptors conflict
   with the same immutable plan. Reposting returns the stored event and the
   same prepared request after a lost response.
4. After that durable receipt, the worker submits the existing `project_plan`
   permission with the gateway-compatible operation digest and request ID.
   The permission timestamp comes from the stored event. The gateway checks
   the exact plan before recording permission, and the worker waits for the
   actual allow-once decision. A timeout or lost permission response can be
   retried with exactly the same arguments and durable request identity.
5. The worker invokes existing work-item admission. The gateway revalidates
   membership and the prepared request, then applies all existing admission,
   decision, source, budget, duplicate, and materialization guards. The tool
   returns the existing admission-result contract with exact child/session,
   dispatch, lifecycle and supervision identities. It does not claim that child
   materialization or publication has finished.

Permission/completion lineage now accepts only verified durable admission-plan
and admission-owned supervision projections, preserving contiguous cursors and
all other snapshot authority. Completion suppresses only an exact buffered copy
of a persisted admission plan. It rejects changed, removed, or fabricated plans
in the reserved namespace.

The coordinator's authenticated context attachment bytes pass through existing
admission and child materialization, with exact source and child identity. The
publication candidate must fit existing limits: four attachments, 256 KiB each,
512 KiB total. The child uses existing GitHub MCP operations and separate
per-operation permissions. Publication and metadata guards remain in force.

## Unknown outcomes and restart

Append/admission transport retries repeat the same request at most twice for
connection failures or HTTP 502/503/504. Further tool retries use the same plan,
permission and child identities. A changed proposal never allocates a replacement
for the same work item in the same dispatch. Existing gateway duplicate guards
also prevent another dispatch from silently allocating a second admission for
that work item.

A replacement worker does not resume incomplete agent execution. Existing
lifecycle receipt reservation rejects it, and the new plan route independently
rejects claim counts other than one. This is the supported fail-closed branch,
not an automated recovery path. Retain the durable plan/permission/admission
history for operator reconciliation. Never manufacture a decision or mint a
new child to resolve an unknown result.

## Independent qualification commands

None of these commands ran during source preparation. Use the trusted isolated
qualification environment with dependencies available:

```sh
nub run --filter @codeops/codeops-contracts build
nub run --filter @codeops/codeops-control-gateway build
nub run --filter @codeops/codeops-plane-controller build
nub run --filter @codeops/codeops-session-runtime-worker build
node --test services/codeops-session-runtime-worker/test/work-item-admissions.test.mjs services/codeops-session-runtime-worker/test/transport.test.mjs services/codeops-session-runtime-worker/test/lifecycle.test.mjs
node --test services/codeops-agent/test/work-item-admission-mcp.test.mjs
node --test services/codeops-plane-controller/test/work-item-provider.test.mjs
node --test services/codeops-control-gateway/test/session-broker-runtime-http.test.mjs services/codeops-control-gateway/test/session-runtime-permissions.test.mjs
```

With `CODEOPS_TEST_POSTGRES_URL` pointing to a disposable dedicated `codeops*test`
database, the existing disposable-database guard protects the DB suite:

```sh
node --test services/codeops-control-gateway/test/work-item-admission-postgres.test.mjs
nub run check:chart
nub run verify
```

The new DB sources cover real plan-before-permission/admission sequencing,
attachment/source identity, missing/wrong approval, stale claim and lease,
source/project/item drift, immutable append replay, concurrent cursor assignment,
permission/completion races, duplicate result replay, and replacement-worker
rejection. Mock sources cover lost HTTP/permission responses, exact result
mapping, bounded input, active loopback fencing, controller membership, installed
MCP inventory and its fixed route. These are unexecuted regression sources;
static review does not establish qualification.

## Images, configuration, and rollback

Affected images: `codeops-agent`, `codeops-session-runtime-worker`,
`codeops-control-gateway`, `codeops-session-control-gateway`, and
`codeops-plane-controller`. The existing Docker COPY and ACP MCP registration
already install `work-items-mcp.mjs`; no new MCP process, port or package dependency
is required. Both gateway entrypoints wire the new handler.

When the existing `plane.adapter.enabled` value is true, the control-gateway API
Deployment now receives `CODEOPS_WORK_ITEM_PROVIDER_ORIGIN` and
`CODEOPS_WORK_ITEM_PROVIDER_TOKEN_FILE`, with a read-only mount of the existing
controller `work-item-mutation-token` key. The session-control gateway already
has this configuration. NetworkPolicy adds control-gateway -> controller TCP
8080 access. No new secret, registry schema, or user-facing Helm value is added.
The controller's existing repository-to-Plane configuration must be present.

Qualification, merge, release and controlled deployment remain separate gates.
There is no implementable dependency deliberately left unwired in this patch.
No live configuration, retained workspace, holds, supervisor, queue priority,
provider data or deployment was changed.

Rollback restores the affected images and the two chart template changes.
Before rollback, stop new admissions and reconcile active coordinator prompts:
old gateways do not recognize the new live plan cursor projections. Retain all
existing events, decisions, admissions and children. There is no migration or
permitted authority-history deletion in this rollback surface.

## Exact changed paths

All paths are relative to the repository root. This includes the prior partial
checkpoint and its completed implementation:

```text
infra/charts/codeops/templates/control-gateway.yaml
infra/charts/codeops/templates/networkpolicies.yaml
packages/codeops-contracts/src/index.ts
packages/codeops-contracts/src/work-item-admission-plan.ts
services/codeops-agent/work-items-mcp.mjs
services/codeops-agent/test/work-item-admission-mcp.test.mjs
services/codeops-control-gateway/src/admission-plan-events.ts
services/codeops-control-gateway/src/runtime-main.ts
services/codeops-control-gateway/src/session-broker-runtime-http.ts
services/codeops-control-gateway/src/session-broker-runtime-outbox.ts
services/codeops-control-gateway/src/session-control-main.ts
services/codeops-control-gateway/src/session-runtime-permissions.ts
services/codeops-control-gateway/src/session-runtime-work-items.ts
services/codeops-control-gateway/src/work-item-admission-plan.ts
services/codeops-control-gateway/src/work-item-admission.ts
services/codeops-control-gateway/test/session-broker-runtime-http.test.mjs
services/codeops-control-gateway/test/session-runtime-permissions.test.mjs
services/codeops-control-gateway/test/work-item-admission-postgres.test.mjs
services/codeops-plane-controller/src/index.ts
services/codeops-plane-controller/src/runtime-main.ts
services/codeops-plane-controller/src/runtime.ts
services/codeops-plane-controller/src/work-item-provider.ts
services/codeops-plane-controller/test/work-item-provider.test.mjs
services/codeops-session-runtime-worker/src/transport.ts
services/codeops-session-runtime-worker/src/work-item-admissions.ts
services/codeops-session-runtime-worker/src/work-items-broker.ts
services/codeops-session-runtime-worker/test/transport.test.mjs
services/codeops-session-runtime-worker/test/work-item-admissions.test.mjs
services/codeops-session-runtime-worker/docs/work-item-admission-adapter.md
```
