# Work-management interoperability proposal

Status: proposal. Research date: 2026-09-18. No tracker credentials were used.
No external tracker writes or interoperability acceptance tests were run.
The implementation admits local intent and displays CodeOps state. It does
not install, synchronize with, or delegate to another workflow supervisor.

## Recommendation

Start with local canonical intent and the CodeOps panel. Add a small, opt-in
Tasks projection next: read an existing task, save its immutable ID and scope
revision, and write one linked execution summary. Do not invoke Tasks
delegation. For a new shared team, prefer Linear as the canonical intent
source. Keep Plane canonical for an existing Plane project. Do not migrate an
incumbent backlog just to pilot this plugin.

Choose exactly one intent owner per project: local, Tasks, Linear, Plane, or
GitHub Issues. CodeOps owns admitted scope, decisions and execution evidence.
GitHub owns PR/check/merge facts. A board is a projection, not authority.

## Inspected candidates

| Candidate | Actual inspected surface | Practical use and limits |
| --- | --- | --- |
| bb Tasks | `getTask({taskId})`, `listTasks({projectId, statuses, limit, cursor})`, `updateTask({taskId, status?, description?, authorName?})` in the [pinned contract](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/plugins/tasks/shared/contract.ts) | Best small local bridge. Call via public `bb.sdk.plugins.callRpc`, validate replies, never open its database. `authorName` is presentation, not authenticated human provenance. `updateTask` has no expected-revision field: avoid overwriting shared descriptions; compare/read back and flag conflicts. |
| Current Tasks | [Maintained source](https://github.com/get-bb/bb/tree/e865697f56bea89f3413dd4cc7fae964850d20a0/plugins/tasks), version 0.1.2, requires SDK >=0.4.102 | Current source is maintained, but this host has SDK 0.4.87. Do not install current source on this host as a compatibility test. Pinned and current signatures were inspected separately. |
| Taskboard | [v0.3.3 contract](https://github.com/MateoCerquetella/bb-plugins/blob/taskboard/v0.3.3/plugins/taskboard/contract.ts): `getItem({projectId,source,locator})`, `statusOptions`, `updateItemStatus({... ,statusId})`; sources GitHub, Linear, Jira | Useful existing list/kanban UI. The catalog reported 293 installs during inspection, versus 84 for Linear; these are a snapshot, not a quality ranking. Status updates do not include a revision fence. Do not infer GitHub Projects support from GitHub issue support. |
| bb Linear | [v0.5.0 RPC](https://github.com/vburojevic/bb-plugin-linear/blob/v0.5.0/src/rpc.ts): `threadIssue`, `threadIssues`, `bindThread`, `issue`, `updateIssue`, `comment`, `editComment`, `attachLink` | Useful issue/browser/thread links. `bindThread` records a manual binding in this implementation; CodeOps must not invoke it to pretend an automated association was human. Prefer a provenance-aware extension or explicit user binding. Its mirror is not fresh provider readback. |
| Linear API | [GraphQL API](https://linear.app/developers/graphql): `issue`, `workflowStates`, `issueUpdate` with `stateId` | Good hosted team backend. Resolve team state IDs explicitly. Inspect errors even for HTTP 200. Keep agent-session APIs optional; ordinary issue operations suffice initially. |
| Plane API | [Work-item update](https://developers.plane.so/api-reference/issue/update-issue-detail): PATCH `/api/v1/workspaces/{workspace_slug}/projects/{project_id}/work-items/{work_item_id}/` | Keep existing Plane projects. Read the item, map `state` to a configured project state UUID, write only owned fields and read back. Verify the deployed version and its dependency/link capabilities before enabling them. No cluster or deployed Plane endpoint was accessed. |
| GitHub Projects | [Official API guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects): `addProjectV2ItemById`, then `updateProjectV2ItemFieldValue` | Good when GitHub Issues already owns intent. Resolve project/item/field/single-select option IDs. Adding an item and setting fields are separate effects. Project status cannot substitute for PR merge evidence. |

Command Center and other boards with built-in supervisors are not initial
candidates: installing another work owner would conflict with this design.
No third-party implementation was copied or installed.

## Stable links and projection contract

Store `{provider, accountOrWorkspaceId, projectId, itemId}` and the provider's
canonical item URL. A title or issue label is not an identity. A CodeOps run
has an immutable UUID. Use the configured bb application origin plus the
CodeOps panel route `/plugins/codeops/runs`; a run-specific route must be
implemented and verified before emitting it. Until then include the UUID
and native thread link with the panel link. Never derive public URLs from
loopback addresses. Record repository URL, base SHA, candidate SHA and PR
node ID/URL separately.

The proposed bridge record contains source revision/content hash, last read
time, run ID, projection revision, write digest, effect key, provider receipt,
readback digest and last synchronized time. A bridge only claims success when
readback matches its owned fields. A timeout becomes `unknown`; read before
retry. This bridge record is not implemented in the initial package.

| CodeOps stage/condition | Work-item lifecycle | Projection card |
| --- | --- | --- |
| Not admitted | Backlog | Missing brief or authority |
| Plan / Waiting | Ready | Scope accepted; next action |
| Implement or Validate / Running | InProgress | Stage, native thread, exact candidate, checks passed/required |
| Critic / Running | InProgress | Independent advisory review in progress |
| Publish / NeedsAttention | InProgress | Manual publication capability gap; do not claim a PR |
| Verified non-draft PR / Waiting | InReview | PR URL, exact tested head, evidence links, human merge decision |
| Any phase / Paused or NeedsAttention | Retain previous lifecycle | One attention card with interrupted stage, concrete reason, next action |
| Stop requested | Retain previous lifecycle | Cancellation pending readback |
| Stops reconciled / Cancelled | Cancelled | Known effects and remaining cleanup |
| Terminal milestone independently verified | Done | Evidence for the configured milestone; merged is not deployed |

State IDs are explicit installation configuration, not name matching. Missing
provider statuses become a visible unsupported mapping. Keep projection lag
separate from run condition. Progress cards show actual runtime status, not
inferences from the last assistant sentence. Notifications occur on a new
attention reason or verified handoff; routine tool activity does not create
new comments.

## Provenance, conflicts and echoes

Read the canonical item before admission. Freeze outcome, scope, acceptance,
priority/dependency snapshot and authority policy. Relevant edits propose a
new admission; cosmetic title changes need not invalidate candidate evidence.
Incoming status changes are observations, not commands. A user dragging Done
cannot create merge evidence. Preserve the mismatch and ask for resolution;
do not repeatedly drag it back.

For webhooks, authenticate signatures, deduplicate provider delivery IDs,
check timestamp/replay bounds, and retrieve current facts before interpreting
an out-of-order event. [Linear documents these delivery and signature
fields](https://linear.app/developers/webhooks). Maintain bounded periodic
readback for missed deliveries. Suppress a projection echo only when provider
identity, owned-field digest and recorded effect agree. A coincident human
edit must survive. Do not use display names as actor authentication.

Without provider CAS, prefer one bot-owned summary/comment or attachment over
a shared description. Persist its ID before updates. On ambiguous creation,
search/read back that exact correlation before retry. If the API cannot locate
it unambiguously, block the write. Do not allow status-sync failure to erase
valid test evidence. Require fresh intent and publication facts before a
consequential effect. Acceptance tests must cover duplicate delivery, stale
scope, revocation, conflict, echo, uncertain writes and readback mismatch.
