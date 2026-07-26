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
- apply comments, logical-label operations, project/ticket content edits, and
  same-project ticket creation;
- expose exactly two terminal lifecycle transitions: cancellation for
  obsolete/duplicate/superseded/no-longer-needed work, and completion only
  with cited evidence that the requested outcome already exists;
- resolve only the exact project-local `Cancelled`/cancelled and
  `Done`/completed state pairs; arbitrary state IDs remain unrepresentable;
- preserve evidence references in controller-authored comments and reject
  active or malformed HTML.
- call Plane's current `/work-items/` external API through a fixed,
  credential-free HTTPS origin and workspace slug;
- send the API key only in `X-API-Key`, reject redirects, validate returned
  identities, bound label pagination, and reject any lifecycle-shaped write
  before network I/O.

The QA Contract Researcher never receives the Plane webhook secret or API
credential. Durable deduplication, runtime packaging, and deployment remain
separate fail-closed slices. Until those exist, commenting `/research` must not
be advertised as live.
