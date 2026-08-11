# System overview

CodeOps separates untrusted repository work from trusted control-plane effects.
The Agents UI sends authenticated commands to the session gateway. The Plane
controller admits Plane and GitHub events for one configured repository. The
orchestrator coordinates durable work. The control gateway selects scoped
repository authority and creates Kubernetes Agent Jobs. The model proxy keeps
the reusable provider credential outside those jobs.

PostgreSQL is the canonical state store. Temporal stores workflow execution.
JetStream carries acknowledged lifecycle events. Plane remains an independent
work-item system even when the CodeOps chart manages its deployment.

Every boundary validates a versioned payload and exact identity. Unknown
repositories and identity drift fail before an effect.
