# Runtime compatible substitution

Workspace admission records one immutable runtime-requirements object and its
canonical SHA-256 digest. The installation owns a closed profile registry. A
profile binds capabilities, resource bounds, authority, image digests, a
compatibility-policy revision, and one exact release digest.

Before any Kubernetes effect, provisioning selects a compatible profile and
stores the complete profile as the launch binding. A replay uses that stored
profile even when the deployed registry now contains a newer release with the
same profile ID. It does not rebuild an old Job from mutable registry state.

Workspace roots resolve their runtime owner from the workspace launch. Other
root Jobs store the selected binding on the root session. Fork and work-item
sessions follow immutable parent lineage to exactly one root owner. A claim
must present the exact profile, release, and capability digests in that
binding. The serializable claim transaction records those values as execution
proof. Expired claims cannot change them.

Requirements and their digest are admitted as one all-or-none pair. Contract
validation verifies the canonical digest, and database triggers keep the pair
and the first launch binding immutable. Newly created unbound launches cannot execute.
Capability removal, policy drift, authority expansion, and insufficient
resources fail closed.

The migration marks only sessions that are already active as compatible with
an older worker protocol. Their first post-upgrade claim stores the deployed
profile on the root. New sessions and all other unbound roots fail closed.

The version 1 Job-initialization HTTP boundary remains available for old
workers. A bound worker uses the version 2 HTTP boundary and a version 3 body
that requires the complete profile tuple. During a gateway rollout, a bound
worker retries only that exact request on the version 2 boundary for bounded
route, transport, and availability failures. It never removes the tuple or
falls back to version 1. Session identity makes an ambiguous retry idempotent,
and a later worker attempt can recover after the new gateway fleet is ready.

The release-image producer derives `runtime.releaseDigest` from the complete
immutable release image manifest. Runtime-binding evidence also activates a
claim-protocol fence. An older claimant, SQL revert, or workspace-launch revert
cannot discard or bypass that evidence. Each revert takes write-blocking table
locks in a fixed order before it checks for binding evidence. A binding that
commits first is visible to the guarded recheck and blocks the revert.
