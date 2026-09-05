# Database prevention deployment packet

Status: prepared, not a production rollout authorization receipt. The incident
hold stays in effect. Do not use the damaged CodeOps control plane for this repair.

## Exact candidate review

1. Verify the disposable launcher image, code and config digests outside the
   checkout. Install the reviewed launcher and config as operator-owned files.
2. Supply the reviewed `--expected-source-sha256` and pinned dependency tar.
   Run `--gate proof`, `--gate focused`, then `--gate verify`. Each invocation
   creates a new PostgreSQL instance and a copied workspace, with loopback-only
   networking, no published port, no host credential or Docker socket mounts,
   no capabilities and a non-root test process. The operator verifies container
   identity and PostgreSQL system ID before any repository execution.
3. Review the complete diff and exact evidence. Do not run the checkout's Python
   launcher directly with production-capable authority. The repository copy is
   for review and distribution, not an automatic bootstrap.

The launcher accepts no database URL or Docker options. Test owner authority
exists only on a disposable instance. Optional PostgreSQL suites refuse arbitrary
caller targets before their first mutation. A database name is not isolation.
The Node guard is defense in depth; it is not the credential/network boundary.
Dependency and Helm archives are copied into the disposable volume, never mounted
from the host. Offline chart verification checks pinned archive hashes.

## P1 corrections and qualification evidence

The FD-relative snapshot reader refuses symlink ancestors/leaves, special files,
hardlinks, cross-device traversal and detectable content mutation. Same-filesystem
bind mounts are not detected: host mount topology must remain operator-controlled. It pins the source
root across Git enumeration and file reads. Failed snapshots are not imported.
Synthetic races are tested before installing the launcher; no checkout code is
run by those proofs. Exact snapshot content/mode digest is required at launch. Manifest v2 hashes a
version prefix followed by sorted records: 8-byte big-endian path length, path
bytes, one normalized executable byte, 8-byte content length and 32-byte SHA256.
This digest is not compatible with the ambiguous prior format.
The operator must pin dependency tar digests in launcher-config.json; passing a
mutable dependency directory is no longer supported. Dependency archives must
be reviewed for contained paths/link targets before their digest is admitted.
The corrected launcher was independently reviewed, installed and read back in
this incident; exact installation and qualification receipts are recorded in
`R1-INSTALLED-QUALIFICATION.md` in the incident prevention directory. This is not
an assertion about another host: verify its effective resolved launcher/config
against those accepted identities before use. Never use the superseded launcher
or interpret container-only proofs as host snapshot coverage. Existing unchanged
qualification need not be rerun merely to update this documentation.

See [PROTECTED-CUTOVER.md](PROTECTED-CUTOVER.md) for the explicit prior-chart
credential ordering, protected namespace/tool design and remaining live placement
blocker. The managed quickstart does not claim production owner isolation.

After application-role cutover, alpha72 API restart and automatic old-image or
Helm downgrade are forbidden. Use a prevention-aware image and forward correction
without regranting owner authority; see the forward-only section of the runbook.

## Production cutover: blocked pending exact live identity review

- Provision `codeops-migration-secrets/database-url` through the deployment secret
  boundary. It contains the existing schema-owner connection. Never put its value
  in an argument, log, issue or report.
- Provision the application connection for `codeops_app` in the gateway's
  `database-url` key through protected secret entry. The migration Job reads both
  identities, checks the same target, provisions grants, and leaves object
  ownership with deployment. Runtime startup only checks role and schema digests.
- Migration runs only as a deployment Job with a separate ServiceAccount and
  owner-secret mount. Upgrade quiescence uses a short-lived Role limited to the
  named writer deployment, not the control gateway ServiceAccount. The lifecycle relay no longer runs migrations or mounts
  owner authority. Application Pods never receive the migration secret.
- `codeops_inspector` is a NOLOGIN, SELECT-only group role. Bind a dedicated
  inspection login through the protected operator credential boundary. No role
  membership or ownership is accepted on runtime/inspection roles. Read-only
  transaction defaults supplement grants; they are not the enforcement boundary.
- Review all live login memberships, schema/table/function ownership, PUBLIC
  grants, role-specific defaults and secret consumers before mutation. Shared
  database-owner credentials may serve other workloads; do not revoke or rotate
  them until each consumer has a reviewed replacement.
- Apply `supervisor-inspection-rbac.yaml` only with the supervisor tool-identity
  cutover. Replace the supervisor's broad kubeconfig/tool grants; adding a narrow
  Role while retaining cluster-admin does not enforce read-only supervision.
- Independently prove `DROP SCHEMA`, table DDL, `SET ROLE`, secret reads, Pod exec
  and workload creation are refused for runtime and supervisor identities. Use
  disposable identity clones for destructive SQL statements, never production.
- Render the exact upgrade with protected existing values. Review the secret-ref,
  authentication, network policy and image diff. Do not use reset values or expose
  rendered Secrets. Do not affect Temporal, Plane or RenoConcierge workloads.
- Production migration execution remains blocked on trustworthy live lineage and
  the exact retained-Job backfill inputs. Do not invent missing owners, permission
  decisions, provider receipts or historical authority. No historical recovery is
  included in this prevention packet.

The live control gateway also has namespace-wide Secret read and Job creation
permissions. A different Secret name in that namespace does not prevent it from
retrieving owner authority. Production cutover therefore also requires an
operator-only migration namespace/secret boundary (including the existing
PostgreSQL bootstrap owner Secret) and independently proven cross-namespace
read/Pod-creation denial. This chart change separates mounts and code paths; it
does not claim to solve that live Kubernetes escalation boundary. Do not remove
dynamic runtime Secret/Job permissions without a reviewed replacement contract.

The current operator has broad production-capable tools. This packet cannot
make that authority read-only through a repository change. A separate trusted
identity/secret boundary and independent review are required before cutover.

## Supervisor friction protocol

The shared COAUTO Friction register has one issue per recurring class, a friction
label, evidence, version, owner, current fix status, workaround removal condition
and executable exit proof. Existing permanent-fix tickets remain authoritative.

Stop identical retries after a repeated deterministic failure. Stop the affected
automation immediately for data loss or an authority-boundary failure. Review at
phase boundaries, without polling loops. Close only with exact-version regression
and deployed-path evidence. A lucky retry or source-only fix is not closure.
Workers initially send sanitized structured reports through the supervisor.
COAUTO-38 explicitly adds scoped, idempotent native report contribution; it does
not distribute a Plane token or confer permission to mutate external state.

Preserve Lane A 37 → 32 → 38 → 4 → 3 → 7 → 8 and Lane B
14 → 15 → 39 → 20 → 18 after prevention. Feature merge gates stay human-only.
PostgreSQL backups, WAL archiving, restore drills and incident-evidence deletion
are outside this alpha scope. Preserve the original incident volume, 13 snapshots
and 7 clones. Do not enable the ordinary supervisor until enforcement proofs and
fresh admission reconciliation are safe.
