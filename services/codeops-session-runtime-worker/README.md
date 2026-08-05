# CodeOps Session Runtime Worker

This standalone package owns the worker-side HTTP transport for Agent Sessions
runtime dispatches. It validates the same shared wire schemas as the trusted
control gateway, claims at most one immutable dispatch, binds a completion to
the exact dispatch and live claim lease, and submits it through the dedicated
worker-only bearer boundary.

The transport, not the ACP executor, owns the completion envelope. An executor
may return only the claimed command type and its command-specific checkpoint,
lease, or fork material. Dispatch, session, generation, lease, idempotency,
event-cursor, and completion-time identity are copied from the validated live
claim, so a future ACP adapter cannot substitute broker-owned identity.

The lifecycle executor receives only the immutable dispatch, never the worker
bearer token, claim token, claim count, or claim expiry. Before invoking an
external operation it atomically reserves the digest-bound dispatch. It then
completes that reservation with the prepared result before broker completion.
A reclaim replays a completed result; a `started` record without a result fails
closed for operator reconciliation instead of repeating an ambiguous prompt,
checkpoint, hibernate, resume, or fork side effect.

`PostgresRuntimeExecutionReceiptStore` implements that reserve/complete seam
against `codeops.session_runtime_execution_receipts`. The versioned broker
migration creates one immutable row per outbox dispatch and binds it to the
outbox with a foreign key. The future worker database role needs only bounded
`SELECT`, `INSERT`, and the exact completion `UPDATE` on this table; exact grants
and the reconciliation path remain part of the caller workload boundary.

`SessionJobInitializer` uses a distinct bearer to compare-and-create only a
root broker session and validates the returned repository/branch/SHA/workflow/
run/lease identity. `SocketAcpWorkspaceLifecycle` connects to the pod-local ACP
Unix socket, maintains an atomic broker-session-to-ACP-session map, relays
permission requests through a required callback, captures tracked and
untracked workspace changes, and prepares strict prompt/checkpoint/hibernate/
resume/fork results. Resume loads the exact checkpoint ACP session; fork uses
ACP's native session fork and records independent child broker/ACP identity.

`runtime-main` is the single-claim polling entrypoint. It binds the durable
permission callback inside the transport, uses one PostgreSQL connection for
execution receipts, and exits on the first execution error so an ambiguous ACP
operation is never silently retried. SIGTERM/SIGINT stop only after the active
claim returns. `reconcileIncompleteRuntimeExecution` is the separate repair
seam: it may adopt an out-of-band reconciled result for the exact incomplete
reservation, but cannot invoke ACP/workspace side effects or repair drift.

The package still deliberately has no Kubernetes workload and runtime command
admission remains fail-closed. The exact caller image/Job, Unix-socket sidecar,
NetworkPolicy, database grants, and repair operator boundary must be packaged
and reviewed before this entrypoint can claim work in a cluster.

Focused checks:

```sh
npm ci --workspaces=false --prefix services/codeops-session-runtime-worker
npm run build --prefix packages/codeops-contracts
npm test --prefix services/codeops-session-runtime-worker
npm run typecheck --prefix services/codeops-session-runtime-worker
```
