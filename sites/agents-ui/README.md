# Agent Sessions UI

Internal TanStack Start command center for live and archived CodeOps sessions.

The fleet and cockpit load strict session snapshots and ordered event pages
through server functions. The server reads its broker token from a mounted
file, validates every upstream response, and never includes that credential in
the browser bundle. The chart exposes the UI only through a ClusterIP Service.
The deployment consumer owns any Ingress, TLS, and edge authentication. The UI
uses one fixed internal service principal for downstream audit records. The
cockpit always renders the complete action set
on desktop and mobile; availability comes only from the broker capability
snapshot, unavailable actions stay visible, and the browser never simulates
completion.

Server configuration:

- `CODEOPS_SESSION_BROKER_URL` — exact internal control-gateway origin.
- `CODEOPS_SESSION_BROKER_READ_TOKEN_FILE` — mounted read-token path.
- `CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE` — mounted write-token path; it
  must be distinct from the read credential.

The shared wire boundary lives at
`@codeops/codeops-contracts/session-broker`. Mutations must carry the
exact session generation, durable lease ID, and an idempotency key, then render
the broker's committed command result.

ACP-dependent actions cross a separate strict dispatch/completion adapter in
the control gateway. A dispatch binds the UI service principal, complete
command, exact observed snapshot/cursor, generation, lease, and capability.
The completion must echo that identity before trusted prompt, checkpoint,
hibernate, resume, or fork material can be adapted for the existing serializable
command transaction. The gateway now persists that dispatch in a separately
versioned runtime outbox before any side effect. One worker can atomically claim
the oldest available dispatch with a bounded lease; an expired lease makes the
same immutable dispatch claimable again without minting a second identity.
Local commands and runtime dispatches share one session/idempotency namespace.
Completion ingestion accepts only the exact current claim token before lease
expiry and only while the broker snapshot still equals the dispatch snapshot;
the command result, ordered events, snapshot transition, immutable completion,
and completed outbox state commit atomically. Exact completion retries replay
the retained result, while token, lease, snapshot, or payload drift rolls back.
The control gateway exposes two strict worker-only POST boundaries: one claims
the oldest available dispatch with a bounded lease, and one submits a
claim-token-bound completion for an exact dispatch UUID. A dedicated bearer
capability maps to one server-configured audit worker identity and is distinct
from broker read, write, Agent Job dispatch, repository-head, and publication
authority. Bodies are versioned, strict, size-bounded JSON; query parameters,
identity drift, expired claims, and completion drift fail closed. The separate
runtime-worker package now consumes the same shared schemas and provides a
strict, size-bounded, redirect-rejecting, lease-aware HTTP client. It claims at
most one dispatch, never invokes an executor for an empty claim, and rejects a
drifting or expired completion before it crosses the network. Production
dispatch remains fail-closed until the ACP executor/workspace lifecycle and
exact Kubernetes caller are packaged and the command admission path enqueues
runtime actions through this boundary.

Run focused checks from the repository root:

```sh
nub run --filter @codeops/codeops-contracts test
nub run --filter @codeops/agents-ui test
nub run --filter @codeops/agents-ui typecheck
nub run --filter @codeops/agents-ui build
nub run --filter @codeops/codeops-control-gateway test
```
