# CodeOps Plane controller

This service owns the privileged Plane integration boundary. It implements:

- verify the HMAC over the exact raw Plane v2 webhook body;
- require matching delivery and event headers;
- accept only `workitem.comment.created`;
- require an explicitly admitted human actor and at least one registered
  `@ai-*` persona mention;
- bind the ordered, deduplicated persona set and the bounded comment/ticket
  fallback brief into research-request v2;
- reload the current project and work item through a trusted reader;
- bind the request to the exact control-plane SHA, resolve and pin the current
  protected `main` SHA as the coding target, and digest the Plane revision;
- compile `codeops.project-context/v1` from the exact Plane project name and
  description plus the six required, image-baked repository context documents;
- retain each document path, purpose, SHA-256, and trusted content so the Agent
  Job can use the control-plane context even when the target `main` checkout
  predates the control-plane branch;
- deduplicate retries with Plane's stable `event_id`, not its per-attempt
  `delivery_id`.
- parse Plane CE's signed `issue`/`update` activity envelope for lifecycle
  admission, but accept only a `state` field transition into the configured
  Ready UUID by an explicitly allowlisted human;
- reload the exact ticket after a Ready event, require its state and
  `updated_at` revision to match the signed payload, bind the configured
  repository and exact source SHA, and derive a delivery-independent Ready
  event identity for durable replay handling;
- admit an unassigned Ready ticket or a ticket assigned only to registered AI
  persona identities; reject a known human assignment and fail closed on an
  unknown assignee identity;
- compile the admitted Ready revision into a strict coding request and
  work-item contract with deterministic workflow/run/branch identities,
  bounded acceptance criteria, the same project-context digest, the immutable
  current ticket plus comments/relations/bounded same-project task index, an
  explicit `required | optional | skipped` research disposition, any
  compatible immutable research packet, and no inline credentials;
- persist event and request deduplication on a private durable volume with
  payload-digest collision checks, bounded processing leases, crash recovery,
  attempt counts, and explicit terminal outcomes;
- claim both stable identities before enqueue, use the research request ID as
  the deterministic workflow ID, reconcile an already-enqueued request after a
  crash, and persist `request-enqueued` before acknowledging a retry;
- accept only raw JSON `POST /webhooks/plane/{owner}/{repository}` requests
  using Plane's documented
  delivery, event, and signature headers, with a 1 MiB body limit and a
  separate credential-free `/healthz` liveness route;
- consume Plane CE's live issue-update shape (`action: updated`,
  `activity.field: state_id`, and an object-valued `data.state`) for Ready
  admission; the configured Plane webhook must enable both Issue and Issue
  comment events;
- start the exact `workItemWorkflow` on the configured Temporal task queue with
  duplicate reuse rejected, running-workflow conflicts rejected, a one-hour
  bound for research or a 24-hour bound for coding, and the complete bound
  request;
- after Temporal accepts the Ready request, compare and set Plane from Ready to
  In Progress and publish one idempotent acknowledgement; publish idempotent
  terminal completion/failure/cancellation comments through the authenticated
  internal transition route;
- preflight an entire proposed mutation batch before the first write;
- apply only comments, logical-label operations, project/ticket content edits,
  and same-project ticket creation;
- turn cancellation into a comment plus `Cancellation proposed` label without
  changing lifecycle state;
- preserve evidence references in controller-authored comments and reject
  active or malformed HTML.
- call Plane's current `/work-items/` external API through a fixed,
  credential-free HTTPS origin and workspace slug;
- send the API key only in `X-API-Key`, reject redirects, validate returned
  identities, bound label pagination, and reject any lifecycle-shaped write
  before network I/O.

The QA Contract Researcher never receives the Plane webhook secret or API
credential. The controller reads both credentials from mounted files; only
their paths are configured through environment variables. The file ledger is a
controller-owned primitive and must be mounted on a single-writer durable
volume. Temporal `already started` maps to `already-enqueued`; every other
Temporal error fails both held claims for a bounded retry. Immutable image and
Kubernetes packaging plus deployment remain separate fail-closed slices. Until
those exist, persona mentions must not be advertised as live.

Ready admission starts the coding workflow only after durable event/request
claims. A trusted human Ready transition authorizes routine planning and Agent
Job execution; merge and production deployment remain separate human gates.

## GitHub review and stack reconciliation

The controller also accepts exact GitHub pull-request, submitted-review,
top-level PR comment, and inline review-comment events through the separately
authenticated GitHub webhook route. A review
request is admitted only when the reviewer is allowlisted, the review names the
current bound repository, pull request, branch, and head SHA, and the delivery
has not already been claimed. The review body and inline comments are retained
as one immutable coding request, so one submitted review starts one revision
workflow rather than one workflow per comment.

Requesting changes immediately removes qualification from that exact head and
causes scheduler re-evaluation. The revision workflow works on the same branch,
publishes only by exact-head fast-forward, reruns the isolated critic loop, and
returns the ticket to Needs attention. An exact-head approval may restore
qualification only after the required GitHub checks are successful. Bot,
edited, stale-head, duplicate, and foreign-repository review events fail
closed.

Allowlisted top-level and inline PR comments are normalized as bounded GitHub
session-steering requests. The controller binds each request to the current
durable ticket↔PR record and claims a deterministic event identity before it
contacts the internal session gateway. Inline comments must name the exact
current head, branch, and base. Edited comments use their exact update time as
a new immutable steering event. If the independent Agent Sessions deployment
is not configured, review/merge reconciliation remains available but comment
projection is disabled. Session steering never grants merge or deployment
authority.

GitHub's public-preview native stack object is treated as a verified execution
primitive, not as the dependency source of truth. Plane relations and the
CodeOps scheduler still decide admission and enforce at most two unmerged pull
requests in a chain. A linear child can use a native stack; sibling fan-out
keeps one deterministic native child and uses branch-only stacking for the
others because a GitHub stack is linear. Native stack number and position are
retained as immutable provenance even after GitHub retargets, rebases, or
dissolves the live stack.

When GitHub reports a merged pull request in a native stack, the controller
reloads the exact bounded stack and reconciles every merged member
idempotently. This covers GitHub's atomic higher-layer merge behavior, where
one merge operation may merge the selected pull request and all unmerged
layers below it. No review, stack, or reconciliation path grants auto-merge or
deployment authority.

The context pack and latest research packet are stored on the controller's
single-writer durable volume. A compatible packet may be attached as optional
implementation context. Missing or stale research is recorded as skipped and
never inferred from old Plane comments.
