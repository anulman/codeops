# CodeOps Plane controller

This service owns the privileged Plane integration boundary. It implements:

- verify the HMAC over the exact raw Plane v2 webhook body;
- require matching delivery and event headers;
- accept only `workitem.comment.created`;
- require an explicitly admitted human actor and the exact `/research` text;
- reload the current project and work item through a trusted reader;
- bind the request to the exact source SHA and a digest of the Plane revision;
- deduplicate retries with Plane's stable `event_id`, not its per-attempt
  `delivery_id`.
- preflight an entire proposed mutation batch before the first write;
- apply only comments, logical-label operations, project/ticket content edits,
  and same-project ticket creation;
- turn cancellation into a comment plus `Cancellation proposed` label without
  changing lifecycle state;
- preserve evidence references in controller-authored comments and reject
  active or malformed HTML.

The QA Contract Researcher never receives the Plane webhook secret or API
credential. A real Plane API adapter, durable deduplication, runtime packaging,
and deployment remain separate fail-closed slices. Until those exist,
commenting `/research` must not be advertised as live.
