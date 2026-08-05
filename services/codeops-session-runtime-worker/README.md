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

The package deliberately does not contain an ACP executor or a runnable polling
entrypoint yet. Runtime command admission remains fail-closed until the ACP
session/workspace lifecycle and the exact Kubernetes caller are packaged and
reviewed. This prevents a transport-only image from claiming work it cannot
safely complete.

Focused checks:

```sh
npm ci --workspaces=false --prefix services/codeops-session-runtime-worker
npm run build --prefix packages/codeops-contracts
npm test --prefix services/codeops-session-runtime-worker
npm run typecheck --prefix services/codeops-session-runtime-worker
```
