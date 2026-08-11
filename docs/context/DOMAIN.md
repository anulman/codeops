# Domain

A repository is the primary authority boundary. A work item can start a durable
session. A session has one repository, base commit, generation, lease, and
ordered event history. A runtime performs bounded work. Trusted gateways admit
commands and effects. Human reviewers retain merge, publication, and deployment
authority.

Plane provides work-item identity and lifecycle state. GitHub provides source,
pull-request, review, and webhook identity. Temporal provides durable workflow
execution. PostgreSQL provides canonical control-plane persistence. JetStream
provides lifecycle-event delivery.
