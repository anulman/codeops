# Forward execution-namespace cutover

Use `runtime.executionNamespace` for new admissions only. This cutover targets
the existing managed PostgreSQL topology; external database routing is not added. The gateway API and
file dispatcher stay in the control namespace. Their Role and RoleBinding move
to the execution namespace. The database, Temporal, original evidence PVC, and
all historical objects stay in place. Kubernetes transport rejects a resource
whose namespace differs from its configured execution namespace before token use.

The execution namespace contains only runtime accounts, new workspace PVCs,
per-run source/token Secrets, and the three-field runtime worker Secret. No
owner/application URL, provider credential, repository registry or Helm release
Secret is copied there. Non-quickstart Helm uses the operator's read access to
project those three fields from the prevention-aware gateway Secret, requiring
the `codeops_runtime_receipts` login. Private image pull Secrets, if needed, are
separately supplied using `runtime.executionImagePullSecrets`; public digest-pinned
images need none. Short service names resolve through fixed ExternalName aliases;
namespace-scoped network policies allow only the existing runtime service ports.

Candidate evidence remains on the preserved dispatcher PVC. The dispatcher
validates its existing retained request/result and digest, then delivers at most
2,000,000 bytes in immutable 256 KiB Secret chunks. Only the workspace builder
mounts them. It assembles and checks size/digest before `git apply`. Runtime
containers never mount the evidence PVC or candidate chunks. Existing result/log
collection returns through the same namespace-fenced client; no new evidence
service is introduced.

## Operator order (not a deployment receipt)

1. Keep admissions and supervisor disabled. Inventory exact workload/RoleBinding
   identities. Preserve the NULL-admission claimed outbox row and all old objects.
2. Reconcile the row explicitly as an unresolved historical object: record its
   immutable ID, claim and namespace bindings, fence further effects. Do not adopt,
   replay, delete, or invent an admission/approval for it. A separate reviewed
   forward reconciliation is needed before admitting a new request.
3. Apply the already qualified prevention-aware role/Secret cutover using the
   protected migration identity. Never restart alpha72 or regrant owner authority.
4. Render/review this chart with a distinct execution namespace. Confirm the
   gateway has no other RoleBinding/ClusterRoleBinding granting control-namespace
   Secret, workload, exec, impersonation or escalation access. Removing this
   chart's old binding does not remove unrelated grants.
5. Apply the exact human-merged release; verify live gateway token refusal in the
   database namespace and positive scoped execution materialization. Verify
   runtime credential username and real SQL/CNI refusals without destructive SQL.
6. Only then establish a new, truthful signed profile/budget admission and Astra
   smoke. Do not mass-rebind historical work. Preserve approved queue order.

Source/CI merge readiness is not live cutover or fresh-admission proof. The default
empty setting retains the old topology for compatibility and MUST NOT be used to
claim production execution isolation. No database/storage move is required.
