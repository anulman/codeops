# Interactive runtime terminal reconciliation

The control gateway reconciles terminal Kubernetes Jobs for interactive
Workspace Sessions. The runtime worker is not the terminal authority. A worker
can finish its ACP operation and then lose the completion compare-and-swap.

Each runtime Job carries the Session ID, generation, lease ID, run ID, and
resource role. The controller reads the authoritative Job and its owned Pods.
It also accepts a retained pre-upgrade Job only when its exact UID was captured
in the durable upgrade-time allowlist, all three newer identity annotations are
absent, and its immutable launch request digest and original Session, initial
generation, deterministic launch lease, run, role, and Job name match. Partial
annotation sets fail, and the allowlist is never rebuilt after migration.
It records the Job UID and resource version and, when applicable, the Pod UID
and resource version. The controller-emitted cause is one of `completed`,
`failed`, `evicted`, or `deadline_exceeded`, with the Kubernetes reason,
message, and runtime-worker exit code when Kubernetes supplies them. The public
contract reserves `cancelled` for explicit Session cancellation evidence; this
Kubernetes reconciler never creates that authority.

One serializable database transaction:

1. locks the exact Session;
2. rejects generation, lease, run, Job UID, or terminal-progress drift;
3. appends one `runtime_terminal` Session event with the complete observation;
4. moves the Session to `completed`, `failed`, or `cancelled`;
5. releases the Session lease when it is still active and clears the pending permission;
6. removes permission relay rows and active claim tokens for the same
   generation and lease; and
7. records the Job UID and resource version as durable reconciliation progress.

The controller discovers work from durable Workspace launch and Session rows.
A durable scan cursor orders candidates by Session ID and wraps at the end, so
every eligible Session progresses across polls and after restart. Active and
hibernated Sessions are eligible: hibernated Sessions retain their released
lease identity and may move only to `completed` or `failed` when the exact
pre-hibernation runtime later supplies unambiguous terminal evidence. A
committed observation makes later duplicate, reordered, or replacement
observations a no-op. Completed, failed, cancelled, and archived Sessions are
never reopened.

Job deletion and Job failure reasons are not cancellation authority. Only an
explicit Session cancellation command can move a Session to `cancelled`.
Conflicting terminal Job conditions, Job/Pod disagreement, and multiple owned
terminal Pods fail closed for later inspection.

This reconciler does not start a replacement runtime and does not release
scheduler capacity or provider authority. Those effects require separate
durable identities and authorization.
