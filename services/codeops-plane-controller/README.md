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
- bind the request to the exact source SHA and a digest of the Plane revision;
- deduplicate retries with Plane's stable `event_id`, not its per-attempt
  `delivery_id`.
- parse Plane CE's signed `issue`/`update` activity envelope for lifecycle
  admission, but accept only a `state` field transition into the configured
  Ready UUID by an explicitly allowlisted human;
- reload the exact ticket after a Ready event, require its state and
  `updated_at` revision to match the signed payload, bind the configured
  repository and exact source SHA, and derive a delivery-independent Ready
  event identity for durable replay handling;
- persist event and request deduplication on a private durable volume with
  payload-digest collision checks, bounded processing leases, crash recovery,
  attempt counts, and explicit terminal outcomes;
- claim both stable identities before enqueue, use the research request ID as
  the deterministic workflow ID, reconcile an already-enqueued request after a
  crash, and persist `request-enqueued` before acknowledging a retry;
- accept only raw JSON `POST /webhooks/plane` requests using Plane's documented
  delivery, event, and signature headers, with a 1 MiB body limit and a
  separate credential-free `/healthz` liveness route;
- start the exact `workItemWorkflow` on the configured Temporal task queue with
  duplicate reuse rejected, running-workflow conflicts rejected, a one-hour
  bound, the researcher role, and the complete bound research request;
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

Ready admission currently stops after the trusted, immutable admission record.
It does not yet enqueue coding work or mutate Plane. The next slice must compile
that record into the strict work-item contract, claim it durably, and start the
coding workflow with its separate plan-approval boundary intact.
