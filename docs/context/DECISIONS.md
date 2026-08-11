# Decisions

- One CodeOps control plane manages multiple allowlisted repositories.
- Repository identity binds credentials, webhooks, policy, sessions, and
  durable records.
- Provider states map many-to-one into the fixed CodeOps lifecycle.
- In Review is a normal lifecycle phase. Needs Attention is an exception
  condition.
- PostgreSQL stores the durable workflow-event outbox. JetStream is the first
  transport driver. The persistence contract remains transport-neutral.
- Plane is the first work-item adapter. GitHub Issues and GitHub Projects are
  outside the first release.
- Release images and charts use immutable identities and fail closed on reuse.
