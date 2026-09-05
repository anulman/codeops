# Protected identity and prior-chart cutover contract

Prepared implementation/design; not a live deployment receipt. The supervisor
remains disabled. Do not migrate the damaged ledger as part of this cutover.

## Quickstart ordering (development only)

The managed quickstart is not a production owner-isolation boundary: the runtime
control gateway can create workloads in the namespace containing PostgreSQL.

Only the **new** migration and application Secrets are pre-install/pre-upgrade
hooks. Their weights are -15 and -14; the migration ServiceAccount is -13 and the
migration Job is -10. The application password is looked up in the new staged
Secret, so retry uses the same identity. The Job reads application authority from
this new Secret, not the old gateway database-url. It reads existing runtime,
model proxy and relay identities unchanged. The old gateway connection remains
usable while grants are created. Regular gateway Secret replacement happens only
after successful migration. A failed hook cannot rotate the old runtime Secret.
Hook credentials are retained on success; they must not use hook-succeeded
cleanup. Do not turn existing runtime Secrets into hooks.

For an external (non-quickstart) installation, pre-provision BOTH
migration.secretName and migration.applicationSecretName through the protected
credential controller. The chart does not invent or log their values. The
application database-url must equal the reviewed future gateway database-url,
not its prior owner connection. A missing Secret blocks the Job before execution.
First install still uses an ordinary migration Job: database and regular runtime
Secrets do not exist at pre-install time.

## Production authority placement

| Identity | Location | Authority |
|---|---|---|
| schema owner/bootstrap | codeops-database-owner | database owner; deployment-only mounts |
| migration executor | codeops-database-owner | approved immutable migration Job only |
| runtime gateway | agents-system | existing runtime Jobs/Secrets, NO owner namespace binding |
| application login | runtime credential boundary | non-owner DML only; no role memberships |
| runtime/model/relay logins | runtime credential boundary | narrow existing grants; no DDL/escalation |
| supervisor inspector | codeops-inspection | SELECT-only login; read-only resource projection tool |
| PostgreSQL | protected database namespace or external managed service | no runtime exec/workload/Secret access |

A namespace name or Secret rename is not sufficient. No owner or bootstrap
credential may remain in a namespace where the gateway can create Pods/Jobs or
read Secrets. This includes Helm release Secrets containing rendered credentials.
The prepared protected-runtime-values.PREPARED.yaml selects an exact database
namespace AND Pod label for runtime egress. It is NOT safe to apply to the live
managed StatefulSet before the placement gate below.

The production runtime Helm release must use external PostgreSQL, quickstart
false, migration.enabled=false; a separate operator-owned release/job in the
protected namespace owns schema operations. Its Helm storage must also be in the
protected namespace. Runtime Helm values contain references, never owner values.

The migration Job is not admitted by CodeOps. An external operator supplies a
reviewed immutable image, exact target, all five pre-provisioned database identity
refs, and pre-migration schema fingerprint. Quiesce session writes with a
separate operator action limited to the named session gateway. The migration
container gets no Kubernetes token. Unquiesce only after migration, role-denial
proofs and schema compatibility pass. Do not reuse the runtime gateway's token.

## Forward-only application-role cutover (deployment gate)

Before execution, bind the approved prevention-aware image digests, database
identity/schema fingerprint, credential references, and every affected startup
consumer in the operator run record. Include shared credential consumers such as
Temporal; preserve the database, storage and unrelated workloads. This document
is preparation, not authorization to deploy its example namespace topology.

**After application-role cutover, do not restart the alpha72 API, automatically
roll back to its image, or perform a Helm downgrade to its chart/runtime.** Alpha72
API startup invokes migrations and must fail with PostgreSQL `42501` under the
restricted application identity. The prevention-aware read-only initializer is
required. Prior-image fixture DML does not prove old API startup compatibility.

- Before runtime credential replacement: preserve the prior credential and image.
  Restore only the exact quiesced writers after checking identity, actual grants,
  schema and committed effects. A failed hook can leave separately committed
  role-provisioning changes; transaction rollback is not a global rollback.
- After successful role/credential cutover: keep incompatible consumers stopped.
  On failure, record actual image/schema/role/Secret-reference state and correct
  forward using an approved prevention-aware image and protected deployment path.
  Resume only after compatible startup and scoped denial checks pass.
- Never regrant owner, CREATE, elevated membership or migration authority to an
  application identity to make old startup or rollback succeed. If a safe forward
  correction is unavailable, remain stopped and escalate to the operator; do not
  restore historical authority, reset the ledger, or enable the supervisor.

Human merge/release and exact production cutover approval remain separate. The
successful disposable CI evidence is not production identity enforcement.

## Network and workload admission

Use the companion protected-boundary.yaml in a DISPOSABLE cluster first. It
creates owner and inspection namespaces, default denies, and narrow owner RBAC.
The DB policy admits port 5432 only from the exact agents-system namespace AND
application component labels, or from exact protected namespace/component pairs.
DNS egress permits only kube-system/kube-dns on TCP/UDP 53. No broad ipBlock rule.
Network selectors are an additional boundary: runtime code can choose Pod labels,
so SQL grants must still deny DDL for every runtime-reachable credential.

Enforce Pod Security restricted in both protected namespaces. Runtime identities
must not have cluster-scoped create, bind, escalate, impersonate, namespace patch,
node/proxy, CSR, storage/PV, or protected namespace access. A privileged runtime
Pod, hostPath, hostPID or hostNetwork could bypass namespace/network isolation:
review admission policies on agents-system before cutover, not only Role rules.
The inspection tool uses its own token/login, no exec shell, kubeconfig selection,
raw Secret endpoint, credential output, or fallback to the broad host operator.
Adding inspector RBAC while retaining that fallback does not pass the gate.

## Current live placement blocker and exact next change

The current PostgreSQL workload and bootstrap Secret reside in the runtime
namespace. Moving only the migration Job leaves bootstrap and Pod-exec paths.
The existing database volume cannot simply be mounted cross-namespace. No volume
move, restore, destructive reset or database replacement is included here.

Before production application, the operator must supply ONE exact reviewed
placement plan that preserves the existing database and unrelated consumers,
with storage/namespace identity and RBAC/admission proofs. If this requires a
storage migration, stop and report that separately; do not improvise it. Until
then, this packet's runtime external-DB overlay is deliberately NOT applicable
to the current managed StatefulSet. Do not apply an overlay which would delete
that StatefulSet or detach its preserved volume.

## Disposable upgrade/denial proof and live gates

1. Replay a prior-chart fixture: old gateway owner credential remains present.
   Stage new owner/application Secrets, provision all roles, prove the new app
   can perform intended DML and cannot DROP SCHEMA/CREATE ROLE/SET ROLE owner.
2. Inject migration failure before runtime resource application. Confirm old
   credential is unchanged and the runtime deployment has not rolled forward.
3. Retry with the same staged app identity; migrate successfully; apply the new
   app connection. Repeat SQL DDL/escalation denial for all runtime and inspector
   identities. Read-only defaults alone do not count: reset them in the proof.
4. Using real tokens in a disposable API server, prove runtime and inspector
   cannot read owner Secrets, create owner workloads, exec DB Pods, impersonate
   or alter RoleBindings. SelfSubjectAccessReview is useful but not a substitute
   for real harmless refused requests. Include positive allowed read/DML controls.
5. Independently review exact digests and evidence. Then obtain live identity
   readback and execute only the approved non-destructive cutover.
6. Fresh admission is a separate reconciliation: fence stale workloads and
   ambiguous provider effects; no invented approvals/receipts or historical rows.

Source render tests and synthetic SQL are NOT a live Helm upgrade, Kubernetes
RBAC denial proof, independent review, or permission to enable the supervisor.
