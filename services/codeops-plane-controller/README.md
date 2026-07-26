# CodeOps Plane controller

This service owns the privileged Plane integration boundary. The current slice
implements research-request admission only:

- verify the HMAC over the exact raw Plane v2 webhook body;
- require matching delivery and event headers;
- accept only `workitem.comment.created`;
- require an explicitly admitted human actor and the exact `/research` text;
- reload the current project and work item through a trusted reader;
- bind the request to the exact source SHA and a digest of the Plane revision;
- deduplicate retries with Plane's stable `event_id`, not its per-attempt
  `delivery_id`.

The QA Contract Researcher never receives the Plane webhook secret or API
credential. Mutation execution and deployment are separate fail-closed slices.
Until those exist, commenting `/research` must not be advertised as live.
