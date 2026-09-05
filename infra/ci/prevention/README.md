# Disposable prevention CI

`Disposable prevention` is a single-node GitHub-hosted PR check (also manually runnable). It is not a
production rollout, ledger recovery, supervisor admission, or an Astra gate.
The workflow runs only same-repository PRs; review the exact controller diff. Preserve
human merge and deployment gates. PR134's placement harness is not a dependency.

## Boundary

The reviewed controller has only the newly created kind cluster's kubeconfig.
Checkout credentials are not persisted; its environment and HOME exclude tokens,
production configuration, and provider authority. The standard gateway Dockerfile
acquires npm packages with scripts disabled, then executes repository rewriting
and compilation in BuildKit `network=none` steps. No custom OCI exporter is used.
Upstream tool and image pins are in `pins.json`; locks stay in the normal source.
The existing scoped OS-tool exception and original notices still apply.

Calico provides real NetworkPolicy enforcement. After image acquisition/import,
node-namespace mangle POSTROUTING and runner iptables rules deny new node/Pod connections to the host, bridge peers,
and external networks. An outside-cluster canary succeeds before fencing and
fails after. The node fence covers same-bridge forwarding that bypasses Docker host chains. CoreDNS has no upstream forwarder. Candidate Pods have restricted
admission, no host mounts, and only the disposable credentials explicitly needed
by their role. A disposable inspector token exercises actual API allow/deny
requests; impersonation checks are additional evidence, not a substitute.

No claim is made against a malicious runner administrator. The hosted runner,
Docker/BuildKit, pinned kind/Calico, and reviewed controller are trusted CI tools.
The production Docker socket, kubeconfig, credentials, volumes, and network are
never used. Do not run this controller on the persistent personal/production host.

## Tests and scope

The Helm slice copies the shipped migration, credential, and helper templates
verbatim. It omits unrelated Plane/Temporal/model services and adds a test-only
PostgreSQL Deployment and writer. Template hashes identify this deliberate scope;
it is not a full-stack chart-install claim.

The job requires fresh install, alpha72 credential upgrade and prior initialization
compatibility, invalid-input refusal before quiescence, alpha69's genuine nonempty
migration, precommit failure/rollback, committed failure, explicit UID/resourceVersion
writer restoration, and idempotent retry. SQL history is never fabricated. Failure
in prior initialization compatibility is a real blocker; do not change it to pass.
Five independent restricted SQL connections exercise positive access plus refused
DDL/escalation. A positive local DB connection pairs the CNI refusal. Kubernetes
Pod-security, API, and outside-egress denials are separate assertions.

The 45-minute job deadline, bounded Job deadlines, Pod memory/CPU limits, serial
cases, and scoped cleanup bound execution. Keep at least **16 GiB free AFTER full
staging**. The controller does not prune shared state or delete incident artifacts.
On cancellation the disposable runner remains the outer cleanup boundary.
Only bounded summary JSON is uploaded; no Secret objects, raw process environments,
SQL URLs, database dumps, or generated inventories enter the source or artifacts.

## Qualification

`test_controller.py` renders the actual migration slice with Helm and checks
failure accounting/restoration refusal. Run it only in a credential-free,
network-disabled fixture. It cannot prove CNI, kubelet admission, or migrations.
`nub run verify` remains required in the existing isolated repository-test boundary.
The affected image build and real cluster job require the disposable hosted runner.
No local/synthetic result replaces their receipts. Production role/tool separation,
CNI rollout and fresh authority admission remain separate, uncompleted gates.
