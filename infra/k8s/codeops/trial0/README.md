# Trial 0 Plane, Temporal, and orchestrator

Trial 0 uses Plane Community Edition as the human-visible work-item and status
ledger. The chart and application versions are pinned in
`plane-chart.lock.json`; CI verifies the values contract. The trusted deployer
must separately verify the downloaded chart archive against the pinned digest.

The trusted external supervisor must:

1. derive the disposable namespace from the exact candidate SHA;
2. label the admitted worker `renoconcierge.ca/codeops=true` only after the live
   capacity gate passes;
3. copy the `ghcr-renoconcierge` image-pull Secret into the disposable
   namespace without exposing its contents;
4. create the five referenced Plane Secrets in that namespace without writing their
   values to Git, logs, workflow inputs, Plane, or Temporal history;
5. copy `renoconcierge-preview-wildcard-tls` into the disposable namespace;
6. replace `plane-candidate.preview.renoconcierge.ca` with
   `plane-<candidate-sha-prefix>.preview.renoconcierge.ca`;
7. resolve every image in the rendered chart to an immutable registry digest
   and attest that every source tag still matches `plane-images.lock.json`;
8. apply `plane-limit-range.yaml`, then install the pinned, digest-rewritten
   chart with `plane-values.yaml`;
9. independently verify every Deployment, StatefulSet, PVC, Ingress, and
   required API operation before accepting the Plane portion of Trial 0.

Required Secret names and keys:

- `codeops-plane-rabbitmq`: `RABBITMQ_DEFAULT_USER`,
  `RABBITMQ_DEFAULT_PASS`;
- `codeops-plane-postgres`: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB`;
- `codeops-plane-object-store`: `USE_MINIO`, `AWS_REGION`,
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_S3_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`,
  `FILE_SIZE_LIMIT`;
- `codeops-plane-app`: `SECRET_KEY`, `LIVE_SERVER_SECRET_KEY`, `REDIS_URL`,
  `DATABASE_URL`, `AMQP_URL`;
- `codeops-plane-live`: `REDIS_URL`, `LIVE_SERVER_SECRET_KEY`.
- `codeops-session-broker-database`: `database-url`. This is a dedicated,
  externally provisioned least-privilege PostgreSQL DSN for the CodeOps
  session broker. It must target the stable
  `renoconcierge-postgres-cnpg-pgbouncer` service and must not reuse the
  shared application owner credential.
- `codeops-session-broker-read-auth`: `token`. This read-only bearer
  capability is mounted by the control gateway and Agent Sessions UI only.
- `codeops-session-broker-write-auth`: `token`. This distinct write bearer
  capability is mounted by the control gateway and Agent Sessions UI only.
- `codeops-session-runtime-worker-auth`: `token`. This worker-only bearer is
  mounted by the control gateway and disposable session runtime Job only.
- `codeops-session-job-initialization-auth`: `token`. This distinct Job-only
  bearer can compare-and-create one root session and cannot claim work.
- `codeops-session-runtime-worker-database`: `database-url`. This DSN must use
  the dedicated receipt-only role provisioned by
  `session-runtime-worker-grants.sql`; it must not reuse the broker owner DSN.

The candidate has no Kubernetes credential. Cleanup must remove the Helm
release, namespace, PVCs, copied TLS material, generated Secrets, node label,
and any external DNS record within the bootstrap plan's 24-hour deadline.

Render and rewrite without contacting the cluster:

```bash
helm template codeops-plane makeplane/plane-ce \
  --version 1.6.0 \
  --namespace "$CODEOPS_NAMESPACE" \
  -f infra/k8s/codeops/trial0/plane-values.yaml \
  --set "ingress.appHost=$CODEOPS_PLANE_HOST" \
  | node infra/scripts/rewrite-codeops-plane-images.mjs \
  > "$CODEOPS_RENDERED_MANIFEST"
```

The rewrite fails if the chart adds or removes an image, a lock entry is not a
SHA-256 digest for the same repository, no images are rendered, or any mutable
tag survives.

## Temporal and orchestrator

Trial 0 runs a real Temporal development server from the official
`temporalio/admin-tools` image pinned in `temporal-image.lock.json`. Its SQLite
store is persisted on a bounded Cinder PVC, and the `codeops` namespace is
created at startup. This is deliberately a single-node non-production server;
it proves durable workflow mechanics for the disposable trial but is not a
production topology.

`temporal.yaml` keeps both the Temporal UI and gRPC service cluster-internal.
The gRPC port is admitted only from the orchestrator pod; an operator may reach
the UI temporarily through an authenticated local port-forward, but there is no
public Temporal ingress. Both workloads use the CodeOps-only node selector,
explicit resources, non-root containers, and service accounts with token
mounting disabled.

The orchestrator implements the authoritative Trial 0 lifecycle as
Ready-authorized coding, structured passing-test evidence, and an automatically
dispatched isolated critic before the separate externally reported independent
human acceptance verdict. The critic evaluates narrow ticket completion in the
broader project/product context across seven lenses: ticket completion, unused
code, simplicity/maintainability, existing-system reuse, test effectiveness,
user-facing behavior, and security/privacy. A rejected candidate loops through
a fresh coding Job with the exact cumulative patch and critic findings, then
tests/checkpoint/critic again. A pass reaches human review; four rejected coding
rounds fail closed. The branch is protected by Temporal patch ID
`coding-autonomous-critic-v1`: old histories keep their original
evidence-to-acceptance path, while new coding executions record the marker
before their first dispatch.

The tokenless orchestrator authenticates to a separately reviewed
`codeops-control-gateway` through the file-mounted
`codeops-agent-dispatch-auth` Secret. The gateway—not the orchestrator or
candidate Agent Job—holds the namespace-scoped Kubernetes identity. It accepts
only the fixed Trial 0 Agent dispatch shapes, creates the bounded tokenless
Job, reconciles its terminal pod, validates the digest-bound checkpoint record,
and persists that checkpoint before acknowledging the Temporal activity. For
critic and revision Jobs it reads only the exact prior `changes.patch` from
the evidence PVC, mounts that file read-only by `subPath`, verifies its
digest/size and clean application to the same base, and prevents runtime
containers from mounting the evidence claim directly.
Research comments are already human approval for the bounded read-only run;
the trusted human Ready transition authorizes routine coding planning and
execution without a second unsurfaced approval signal.

The Plane controller resolves the exact protected `main` head through the
gateway before admitting a coding workflow. That read-only endpoint uses the
separate externally created `codeops-repository-head-auth` Secret; the
controller never receives `codeops-agent-dispatch-auth` and therefore cannot
bypass Temporal to create an Agent Job directly.

Agent Sessions runtime claims and completions use the separate externally
created `codeops-session-runtime-worker-auth` Secret. The gateway binds that
capability to the fixed `acp-worker:primary` audit identity; it is not shared
with session read/write, Agent Job dispatch, repository-head, or publication
routes. The current NetworkPolicy does not admit an ACP worker workload yet,
so the endpoints remain unreachable until the reviewed transport package adds
that exact caller. Do not reuse one of the existing endpoint tokens or broaden
gateway ingress to activate the transport.

The gateway also owns the bounded GitHub write boundary for candidate
publication and public-preview native stacks. Candidate publication requires
an exact current branch/head match and can only fast-forward the already-bound
pull-request branch. The stack adapter reloads and validates both pull
requests, then may create a two-layer stack or append one child only when the
bound parent is the current top layer. It rejects sibling fan-out, topology
drift, redirects, and unverified 422 races. Stack reads and writes use separate
internal bearer capabilities; the Plane controller never receives the GitHub
repository credential.

Native stacks complement rather than replace scheduler policy. Linear
dependencies use GitHub's retarget/rebase mechanics, while independent direct
siblings may remain branch-only stacks. A merged native-stack event reloads
the exact stack so all pull requests merged by GitHub's atomic higher-layer
merge are projected to their tickets idempotently. None of these routes can
merge a pull request or deploy a candidate.

The gateway mounts only the repository token from the externally created
`codeops-agent-source-credentials` Secret. The real OpenAI API key exists only
in the trusted `codeops-model-proxy` Deployment. Varlock validates the proxy
environment, redacts sensitive values, and prevents accidental process leaks.
The proxy accepts only the Responses API and replaces a valid run token with
the real key before it calls OpenAI.

Each serialized Agent Job receives a signed, run-bound model proxy token with
a maximum lifetime of 75 minutes. The coding-agent container uses an isolated
temporary Codex home and never mounts a reusable model credential. Network
policy admits the proxy only from Agent Pods. The proxy has no Kubernetes
ServiceAccount token and is not exposed outside the cluster. Create the
`codeops-model-proxy-credentials` Secret separately with `openai-api-key` and
`signing-key` keys. Use the same signing key in the trusted gateway and proxy.

The gateway may create/delete, but never read or list, one immutable
request-digest-derived repository Secret. Its namespace Role may
create/get/delete only the fixed ServiceAccount, Job, and NetworkPolicy
resources plus read the terminal pod and session-gateway log. The trusted
renderer requires the exact Kubernetes API Service address as a `/32`; no
broad private-network egress is accepted.

Codex keeps command execution in the workspace sandbox. Cached web search is
available for normal research without a network approval. An automatic
security reviewer handles exceptional command-level network requests. The
durable ACP timeline records tool and approval decisions. Kubernetes still
denies private, link-local, loopback, and carrier-grade NAT destinations. This
reduces prompt-driven exfiltration risk without adding a service mesh or a
human approval to each research request. It does not make an approved public
HTTPS destination trustworthy.

```bash
CODEOPS_CONTROL_GATEWAY_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_MODEL_PROXY_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_AGENT_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_SESSION_GATEWAY_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_KUBERNETES_API_CIDR=<api-service-ip>/32 \
  node infra/scripts/render-codeops-control-gateway.mjs \
  > "$CODEOPS_CONTROL_GATEWAY_MANIFEST"
```

The trusted supervisor builds the `codeops-orchestrator-runtime` Docker target,
records its registry digest, and renders the deployment:

```bash
CODEOPS_ORCHESTRATOR_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-orchestrator.mjs \
  > "$CODEOPS_ORCHESTRATOR_MANIFEST"
```

Rendering rejects missing, mutable, malformed, or duplicated image
substitutions. The candidate still receives no Kubernetes credential.

## Agent Sessions UI

The internal Agent Sessions UI is packaged as the `agents-ui-runtime` Docker
target and runs with a tokenless ServiceAccount, a read-only root filesystem,
and only the distinct session-broker read/write bearer capabilities. Its
NetworkPolicy admits HTTP only from `ingress-nginx` and allows egress only to
the control gateway and cluster DNS. The checked-in manifest intentionally has
no Ingress: `HARDEN-13` owns the Cloudflare Access policy and public hostname,
and that boundary must be completed before an ingress is added.

```bash
CODEOPS_AGENTS_UI_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-agents-ui.mjs \
  > "$CODEOPS_AGENTS_UI_MANIFEST"
```

After the internal Service and broker are ready, render and apply the bounded
cluster Playwright smoke Job using the exact acceptance-runner image digest.
The tokenless Job may reach only the UI Service, sends a synthetic Access
principal, validates desktop and mobile fleet surfaces, and fails on horizontal
overflow. It does not test the external Cloudflare Access policy owned by
`HARDEN-13`.

```bash
CODEOPS_ACCEPTANCE_RUNNER_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-agents-ui-smoke.mjs \
  > "$CODEOPS_AGENTS_UI_SMOKE_MANIFEST"
```

## Disposable Agent Sessions runtime Job

The video proof uses a dedicated `codeops-session-proof-*` namespace and an
ephemeral PostgreSQL workload. Render the namespace package first. The package
binds the namespace name to one run ID and exact base SHA, enforces restricted
Pod Security, applies aggregate object/CPU/memory/storage bounds, and defaults
all pod ingress and egress to denied. Rendering does not create the namespace:

```bash
CODEOPS_SESSION_PROOF_NAMESPACE=codeops-session-proof-video-1 \
CODEOPS_RUN_ID=video-1 \
CODEOPS_BASE_SHA=<40-lowercase-hex> \
  node infra/scripts/render-codeops-session-proof-namespace.mjs \
  > "$CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST"
```

After separately reviewing that exact manifest, issue the seven distinct Secret
objects without printing their values, render the exact database image digest,
and apply only inside that disposable namespace:

```bash
infra/scripts/issue-codeops-session-proof-secrets.sh \
  --namespace "$CODEOPS_SESSION_PROOF_NAMESPACE"

infra/scripts/issue-codeops-session-proof-runtime-credentials.sh \
  --namespace "$CODEOPS_SESSION_PROOF_NAMESPACE" \
  --registry-config-file "$CODEOPS_SESSION_PROOF_REGISTRY_CONFIG_FILE" \
  --repository-token-file "$CODEOPS_SESSION_PROOF_REPOSITORY_TOKEN_FILE"

CODEOPS_SESSION_PROOF_POSTGRES_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-session-proof-database.mjs \
  > "$CODEOPS_SESSION_PROOF_DATABASE_MANIFEST"
```

The database uses `emptyDir`, has no outbound network path, admits only the
standalone proof gateway and runtime worker, and creates a separate receipt
worker login during first initialization. The broker owner and receipt worker
DSNs are projected from different Secrets. The runtime credential issuer accepts
only explicit regular files, validates one `ghcr.io` registry entry, normalizes
one bounded repository-read token, creates rather than updates exactly two
Secrets, rolls back partial issuance, and never prints either value. It does not
copy credentials from shared dev or production. ChatGPT device authentication
remains separate: render the existing credential-only login/smoke Jobs through
the proof wrapper so every object is explicitly bound to the exact namespace
and run ID. Only their 1 GiB RWO claim reaches the coding-agent container; the
Jobs receive no Kubernetes token, Secret volume, repository credential, or
model API key and can reach only DNS plus public HTTPS:

```bash
export CODEOPS_AGENT_DIGEST=sha256:<64-lowercase-hex>
export CODEOPS_SESSION_PROOF_NAMESPACE=codeops-session-proof-video-1
export CODEOPS_RUN_ID=video-1

CODEOPS_AUTH_ACTION=login \
  node infra/scripts/render-codeops-session-proof-codex-auth.mjs \
  > "$CODEOPS_SESSION_PROOF_CODEX_LOGIN_MANIFEST"

CODEOPS_AUTH_ACTION=smoke \
  node infra/scripts/render-codeops-session-proof-codex-auth.mjs \
  > "$CODEOPS_SESSION_PROOF_CODEX_SMOKE_MANIFEST"
```

`codex-login` completion is now separately bound to the exact reviewed login
artifact and exactly four server-assigned identities: its PersistentVolumeClaim,
ServiceAccount, Job, and NetworkPolicy. Grant-package identities, missing or
extra objects, renamed or duplicate resources, empty UIDs, wrong artifacts,
generic evidence, and unreviewed fields cannot complete the apply step. The
A concrete but uninvoked create-only adapter now admits only the exact
`codex-login` authorization and reviewed manifest bytes, refuses any
pre-existing package object, streams those bytes once through `kubectl create`,
double-reads all four server UIDs around the final live
operator/target/Namespace-UID check, and emits no receipt after partial creation
or identity replacement. The separate `wait-codex-login` completion
postcondition is now bound to the exact login apply receipt/evidence chain, the
same create-only Job UID at generation 1, and the same bound, non-deleting
credential-claim UID. It proves the reviewed one-completion, one-parallel,
non-retrying, fifteen-minute-deadline Job reached exactly one successful
completion with zero active or failed executions and a valid start/completion
interval. Generic status text, logs, credential contents, missing or extra
fields, pending or failed Jobs, retries, timestamp drift, replaced resources,
and pending/deleting claims cannot complete the step. A concrete but uninvoked
waiter repeats live operator, target, and Namespace-UID admission around a
bounded sixteen-minute poll, reads only the exact Job and claim metadata, fails
immediately on terminal failure, and double-reads the successful Job and bound
claim before emitting evidence and a receipt. CI tests both closed adapters but
cannot create the claim or run the interactive device-auth Job.

`codex-smoke` replacement completion is separately bound to the exact reviewed
smoke artifact and the exact preceding login-completion receipt/evidence chain.
Its evidence requires the login Job to be absent, a distinct smoke Job UID, and
the original PersistentVolumeClaim, ServiceAccount, and NetworkPolicy UIDs to
remain unchanged. A generic four-object inventory, reused login Job identity,
replaced retained object, missing or extra object, wrong artifact/action,
credential contents, logs, chain drift, or extra evidence fields cannot
complete the replacement step. A concrete but uninvoked replacement adapter
now verifies that chain and the four live server identities before mutation,
deletes only the completed login Job through a foreground Kubernetes DELETE
preconditioned on its exact UID, verifies its absence, rechecks the retained
objects, and creates only the smoke Job extracted from the digest-bound reviewed
manifest. It double-reads the final smoke and retained identities around live
operator/target/Namespace-UID admission and emits no receipt after deletion or
creation failure, replacement, or partial state. CI exercises the adapter only
through injected fakes and never deletes or creates a live Job. The separate
`wait-codex-smoke` completion contract and concrete but uninvoked
waiter now bind the exact replacement receipt/evidence chain to the same
create-only smoke Job UID at generation 1, the same bound non-deleting
credential claim, and continued absence of the login Job. Completion requires
exactly one successful execution with zero active/failed work or retries, the
reviewed fifteen-minute deadline, and monotonic authorization/start/completion/
observation time. The waiter repeats live operator, target, and Namespace-UID
admission around a sixteen-minute-bounded poll, fails immediately on terminal
failure, and double-reads the smoke Job, claim, and login absence before
emitting evidence and a receipt. Pending, failed, retried, replaced, deleting,
malformed, extra-field, chain-drifted, or timestamp-drifted state fails closed.

The `start-ui` apply boundary is separately bound to the exact reviewed UI
artifact and exactly the Deployment, Service, ServiceAccount, and NetworkPolicy
server UIDs. Its concrete but uninvoked adapter repeats live operator, target,
and Namespace-UID admission, refuses any pre-existing package object, streams
the reviewed bytes once through `kubectl create`, and double-reads all four
identities around the final admission check. Partial creation, a missing object,
Namespace or resource replacement, manifest/action drift, or timestamp drift
emits no receipt. CI exercises the adapter only through injected fakes and
never creates a live UI resource.

The separate `wait-ui` completion contract self-contains and hash-verifies the
exact UI apply receipt/evidence, reuses the create-only Deployment UID at
generation 1, and requires exactly one desired/current/updated/ready/available
replica with zero unavailable replicas and both rollout conditions ready. Its
concrete but uninvoked waiter repeats live operator, target, and Namespace-UID
admission around a two-minute-bounded poll of only that Deployment, then
double-reads the final ready identity before emitting evidence and a receipt.
Pending, stale-generation, incomplete, replaced, malformed, chain-drifted,
extra-field, or final-state-drifted readiness fails closed.

The `start-runtime` apply boundary derives the exact Job, ServiceAccount, and
NetworkPolicy names from the reviewed proof session suffix and binds their
server UIDs to the exact reviewed runtime artifact. Its concrete but uninvoked
adapter repeats live operator, target, and Namespace-UID admission, refuses any
pre-existing package object, streams the reviewed bytes once through
`kubectl create`, and double-reads all three identities around the final
admission check. A malformed or overlong session identity, partial creation,
missing object, Namespace or resource replacement, manifest/action drift, or
timestamp drift emits no receipt. CI exercises the adapter only through
injected fakes and never creates a live runtime Job.

Final proof cleanup must delete the disposable namespace; if credentials must
be revoked independently first, run:

```bash
infra/scripts/revoke-codeops-session-proof-secrets.sh \
  --namespace "$CODEOPS_SESSION_PROOF_NAMESPACE"

infra/scripts/revoke-codeops-session-proof-runtime-credentials.sh \
  --namespace "$CODEOPS_SESSION_PROOF_NAMESPACE"
```

The standalone proof gateway is likewise render-only and has no release/apply
integration. It accepts only the UI and runtime worker, reaches only the proof
database and DNS, and mounts no repository, GitHub, publication, model, or
Kubernetes-controller authority.

Render the Agent Sessions UI through its proof wrapper so its four resources
are bound to the same namespace and run ID. The UI remains tokenless, mounts
only the distinct broker read/write capabilities, exposes only a ClusterIP,
and reaches only the same-namespace proof gateway plus DNS. It has no admitted
cluster ingress or Ingress object; record through a reviewed Kubernetes
port-forward/Playwright path that injects the synthetic Access principal rather
than weakening the production Access check:

```bash
CODEOPS_AGENTS_UI_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_SESSION_PROOF_NAMESPACE=codeops-session-proof-video-1 \
CODEOPS_RUN_ID=video-1 \
  node infra/scripts/render-codeops-session-proof-ui.mjs \
  > "$CODEOPS_SESSION_PROOF_UI_MANIFEST"
```

After every manifest is rendered and separately reviewed, build the immutable
composition plan. The planner only reads artifacts, validates their exact
resource sets and namespace mode, hashes them, and emits ordered JSON. It has no
Kubernetes client and cannot apply or delete anything. The sequence requires
database/gateway/grant readiness, credential-only login and smoke completion,
UI readiness, runtime start, off-cluster evidence capture, exact capability
revocation, namespace deletion, and a final absence check:

```bash
export CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST=/path/to/namespace.yaml
export CODEOPS_SESSION_PROOF_DATABASE_MANIFEST=/path/to/database.yaml
export CODEOPS_SESSION_PROOF_GATEWAY_MANIFEST=/path/to/gateway.yaml
export CODEOPS_SESSION_PROOF_GRANTS_MANIFEST=/path/to/grants.yaml
export CODEOPS_SESSION_PROOF_CODEX_LOGIN_MANIFEST=/path/to/codex-login.yaml
export CODEOPS_SESSION_PROOF_CODEX_SMOKE_MANIFEST=/path/to/codex-smoke.yaml
export CODEOPS_SESSION_PROOF_UI_MANIFEST=/path/to/ui.yaml
export CODEOPS_SESSION_PROOF_RUNTIME_MANIFEST=/path/to/runtime.yaml

CODEOPS_SESSION_PROOF_NAMESPACE=codeops-session-proof-video-1 \
CODEOPS_RUN_ID=video-1 \
CODEOPS_BASE_SHA=<40-lowercase-hex> \
CODEOPS_SESSION_SUFFIX=video-1 \
  node infra/scripts/render-codeops-session-proof-plan.mjs \
  > "$CODEOPS_SESSION_PROOF_PLAN"
```

Execution admission is a second, operator-owned artifact. It must bind the
SHA-256 of the reviewed plan bytes to the authenticated Kubernetes username,
UID when the authenticator supplies one, SHA-256 of the active client
certificate, exact context and API server, and a positive window no longer
than four hours. Namespace creation is the only operation allowed while unbound.
After creation, every remaining operation—including exact deletion—must first
re-read the Namespace and match its name, proof labels, and immutable
`metadata.uid`; a same-name replacement is rejected. Final teardown succeeds
only when that UID-bound Namespace is absent. The admission module is an
offline verifier and still has no Kubernetes client or apply/delete path:

```text
infra/scripts/codeops-session-proof-admission.mjs
```

Before creation, the read-only live preflight consumes that admission and uses
only `kubectl config`, `kubectl auth whoami`, and `kubectl get namespace`. It
hashes the active client certificate in memory without printing certificate or
key material, rechecks the reviewed plan bytes and exact target, and succeeds
only while the exact proof namespace is absent. It cannot apply, create, patch,
delete, issue credentials, or execute any later lifecycle step:

```bash
CODEOPS_SESSION_PROOF_PLAN=/path/to/plan.json \
CODEOPS_SESSION_PROOF_ADMISSION=/path/to/admission.json \
  node infra/scripts/run-codeops-session-proof-preflight.mjs
```

The first mutating boundary is deliberately limited to creation of the already
reviewed namespace package. It verifies the namespace-manifest digest before
contacting the cluster, repeats the live preflight immediately, streams the
reviewed bytes over stdin to one `kubectl create` (never `apply`), reads back
the Namespace, and emits the admission bound to its immutable UID. It cannot
issue credentials, start workloads, update an existing object, or delete
anything. If package creation partially fails after the Namespace exists, it
still emits a UID-bound non-proceed receipt and exits nonzero so teardown can
target that exact identity; it never guesses that the remaining resources were
created. Do not run it until the exact source head has passed review:

```bash
CODEOPS_SESSION_PROOF_PLAN=/path/to/plan.json \
CODEOPS_SESSION_PROOF_ADMISSION=/path/to/admission.json \
CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST=/path/to/namespace.yaml \
  node infra/scripts/run-codeops-session-proof-namespace-create.mjs \
  > /path/to/bound-namespace-receipt.json
```

Before that create-only path may run, the matching cleanup boundary must be
reviewed and qualified. Cleanup accepts only the exact creation receipt and
reviewed plan bytes. It repeats the live principal, credential, target, labels,
and Namespace UID checks, then sends one direct Kubernetes DELETE with a
server-enforced `DeleteOptions.preconditions.uid`. It does not rely on
`kubectl delete`, which has no UID/resource-version check. The client accepts
only the active inline CA, certificate, and key from the same kubeconfig,
rechecks the certificate fingerprint without printing TLS material, rejects a
same-name replacement, and reports success only after a second principal/
target check and exact Namespace absence. It cannot delete any other resource,
create, apply, patch, issue credentials, or target shared dev/production:

```bash
CODEOPS_SESSION_PROOF_PLAN=/path/to/plan.json \
CODEOPS_SESSION_PROOF_NAMESPACE_RECEIPT=/path/to/bound-namespace-receipt.json \
  node infra/scripts/run-codeops-session-proof-namespace-delete.mjs \
  > /path/to/namespace-delete-receipt.json
```

Every intermediate action must additionally pass through the non-mutating
step-receipt contract in
`infra/scripts/codeops-session-proof-step-receipts.mjs`. It accepts only an
exact successful creation receipt, reviewed plan bytes, the complete ordered
predecessor-receipt byte chain, the live operator/target, and the same labeled
Namespace UID. Artifact-bearing steps also require the exact reviewed manifest
bytes. Authorization and completion each repeat the live admission check; the
completion receipt hashes both its exact predecessor and a verified evidence
artifact so steps cannot be skipped, reordered, replayed under a replacement
Namespace, or spliced between proof runs. Credential issuance evidence is
metadata-only: the exact Secret names, namespaces, object UIDs, types, data-key
names, and proof-scope labels. Secret values are rejected from the evidence
artifact. The receipt and evidence modules deliberately have no Kubernetes or
credential mutation path. The first concrete—but not automatically
invoked—adapter is
`infra/scripts/codeops-session-proof-credential-issuer.mjs`. It accepts only
the exact next credential-issuance authorization, repeats the live
operator/target/Namespace-UID check before calling the existing create-only
issuer, reads only UID/type/label/data-key metadata through a value-free
`kubectl` template, repeats the live check after issuance, and only then returns
the evidence bytes and completed receipt. Authorization drift and timestamp
reordering fail before mutation; post-issuance Namespace replacement withholds
the receipt. The matching terminal adapter is
`infra/scripts/codeops-session-proof-credential-revoker.mjs`. It verifies the
complete predecessor chain and the two evidence artifacts hashed by the
original issuance receipts, recovers exactly the nine issued Secret UIDs, and
repeats live identity admission before mutation. It reads only each current
Secret UID, rejects same-name replacements, and sends direct Kubernetes DELETE
requests with server-enforced UID preconditions. An interrupted retry may skip
an originally issued UID that is already absent, but it must verify all nine
names absent, repeat live admission, and only then emit the evidence and
completion receipt. The existing name-only shell revokers remain outside this
path. Every remaining apply/wait/record/stop adapter remains closed until it
has the same bounded postcondition and tests. Neither concrete credential
adapter is wired to Release or automatically invoked.

`start-database` has the first concrete apply adapter and postcondition
contract. The uninvoked adapter accepts only the exact authorization and
reviewed database manifest digest, refuses any pre-existing package object,
and sends those bytes once through `kubectl create`. It double-reads exactly
the five server-assigned resource UIDs—ServiceAccount, ConfigMap, Deployment,
Service, and NetworkPolicy—around the final live operator, target, and
Namespace-UID check. Missing, extra, duplicate, renamed, UID-less,
wrong-manifest, wrong-step, wrong-Namespace, value-bearing, and unreviewed
fields fail closed. Partial creation or identity replacement emits no receipt
and must be reconciled through reviewed UID-bound teardown. Database readiness
remains a separate closed postcondition; neither adapter is invoked by CI.

`wait-database` now has a concrete but uninvoked bounded polling adapter. Its
self-contained evidence must carry and hash-verify the exact
predecessor apply receipt and metadata-only apply evidence, reuse the applied
Deployment UID, retain its create-only generation, and prove exactly one
desired, current, updated, ready, and available replica with zero unavailable
replicas plus both `Available=True` and `Progressing=True`. Because the reviewed
Deployment readiness probe is
`pg_isready`, this is the bounded Kubernetes signal for PostgreSQL acceptance;
generic status text, logs, extra fields, stale generations, and replacement
Deployments cannot complete the step. The adapter repeats the live operator,
target, and Namespace-UID admission before polling and before completion; caps
the configured inter-poll delay budget at two minutes; bounds every API read;
reads only the exact Deployment; and emits no receipt on timeout, malformed
state, or identity replacement. It does not read Pod logs, inspect Secret
values, mutate Kubernetes, or run in CI.

`start-gateway` completion is now separately bound to the exact reviewed
gateway artifact and exactly four server-assigned identities: its Deployment,
Service, ServiceAccount, and NetworkPolicy. Database identities, missing or
extra objects, renamed or duplicate resources, empty UIDs, wrong artifacts,
and generic evidence cannot complete the gateway step. A concrete but uninvoked
adapter now admits only the exact `start-gateway` authorization and reviewed
manifest bytes, refuses any pre-existing package object, sends those bytes once
through `kubectl create`, double-reads all four server UIDs around the final
live operator/target/Namespace-UID check, and emits no receipt after partial
creation or identity replacement. Migration readiness remains a separate
closed action adapter, and the apply adapter is not invoked by CI.

`wait-gateway-migration` now has a non-mutating postcondition. Its evidence
self-contains and hash-verifies the exact gateway apply receipt/evidence,
reuses the applied Deployment UID at create-only generation 1, proves the
single gateway replica is current and ready with both ready conditions, and
attests the migrated `codeops.session_runtime_execution_receipts` relation by
positive server OID, exact six-column shape/nullability, `dispatch_id` primary
key, exact foreign key to `codeops.session_runtime_outbox(dispatch_id)`, and the
four digest/status/state/result-type check-constraint semantics.
Generic health text, logs, table contents, missing or extra fields, schema
drift, stale rollout state, and replacement Deployments cannot complete the
step. A concrete but uninvoked adapter now verifies the exact apply chain
before live access, repeats operator/target/Namespace-UID admission around the
bounded poll, reads only the applied gateway Deployment plus PostgreSQL catalog
metadata through the disposable database Deployment, and compares all four
parsed check expressions exactly before assigning their semantic labels. It
caps the configured delay budget at two minutes and repeats both reads before
emitting evidence and a receipt. Missing relations may be retried within the
bound; malformed catalog output, changed check expressions, replacement,
rollout drift, query failure, or final-state loss fails closed. The query reads
no application rows or Secret values, performs no writes, and is not invoked
by CI.

After the database and standalone gateway are ready, run the exact-digest,
non-retrying grant Job. It waits boundedly for the gateway migration, mounts
only the database-owner credential, grants only execution-receipt columns to
the pre-created worker role, and can reach only the proof database plus DNS:

`grant-receipts` completion is separately bound to the exact reviewed grants
artifact and exactly four server-assigned identities: its ConfigMap, Job,
NetworkPolicy, and ServiceAccount. Gateway/database identities, missing or
extra objects, renamed or duplicate resources, empty UIDs, wrong artifacts,
generic evidence, and unreviewed fields cannot complete the apply step. The
concrete but uninvoked create-only adapter now admits only the exact
`grant-receipts` authorization and reviewed manifest bytes, refuses any
pre-existing package object, streams those bytes once through `kubectl create`,
double-reads all four server UIDs around the final live
operator/target/Namespace-UID check, and emits no receipt after partial creation
or identity replacement. `wait-grants` completion is now separately bound to
the exact grant apply receipt/evidence chain and the applied Job UID at
create-only generation 1. It proves the reviewed one-completion, one-parallel,
non-retrying, five-minute-deadline Job reached exactly one successful
completion with zero active or failed executions and a valid start/completion
interval. Generic status text, logs, missing or extra fields, pending or failed
Jobs, retries, timestamp drift, and replacement Jobs cannot complete the step.
The concrete but uninvoked waiter repeats live operator, target, and
Namespace-UID admission around a bounded six-minute poll, reads only the exact
Job, fails immediately on terminal failure, and double-reads the successful
state before emitting evidence and a receipt. CI tests the closed adapter but
cannot create or run this Job.

```bash
CODEOPS_SESSION_PROOF_POSTGRES_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-session-proof-grants.mjs \
  > "$CODEOPS_SESSION_PROOF_GRANTS_MANIFEST"
```

The live proof runtime is a bounded, non-retrying Job rather than a shared
Deployment. Its init container checks out one exact SHA, the runtime worker
uses separate Job-initialization, claim/completion, and receipt-database
credentials, and the existing `codeops-agent` image runs Codex ACP beside it.
The two runtime containers share only the workspace and a memory-backed Unix
socket. The Job receives no Kubernetes token, denies ingress, and permits
egress only to the standalone proof gateway, the disposable proof database,
cluster DNS, and public HTTPS needed for repository/model access.

For an existing externally managed broker database, provision the receipt-only
role with an admin connection before creating its external Secret. The
disposable proof database above creates the login itself, but the same grants
must still be applied after the gateway migration creates the receipt table:

```bash
psql "$CODEOPS_SESSION_BROKER_ADMIN_DSN" \
  --set=worker_role=codeops_session_runtime_worker \
  --file=infra/k8s/codeops/trial0/session-runtime-worker-grants.sql
```

Render only for an exact disposable proof identity. Rendering does not apply
or admit the Job:

```bash
CODEOPS_AGENT_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_SESSION_RUNTIME_WORKER_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_BASE_SHA=<40-lowercase-hex> \
CODEOPS_BRANCH=feat/agents-ui \
CODEOPS_LEASE_ID=<lowercase-uuid> \
CODEOPS_REPOSITORY=https://github.com/anulman/renoconcierge \
CODEOPS_RUN_ID=video-proof-1 \
CODEOPS_SESSION_ID=ses_video_1 \
CODEOPS_SESSION_SUFFIX=video-1 \
CODEOPS_WORKFLOW_ID=video-proof-1 \
  node infra/scripts/render-codeops-session-runtime-worker.mjs \
  > "$CODEOPS_SESSION_RUNTIME_WORKER_MANIFEST"
```

The repair function is intentionally absent from the polling entrypoint and
manifest. A repair operator must first reconcile the external ACP/workspace
outcome, then invoke the exact-result repair seam in a separate reviewed
one-shot process; the live worker never guesses or automatically retries an
incomplete receipt.

## Plane research controller

The privileged Plane controller is packaged separately from Agent Jobs. It
receives no Kubernetes service-account token, reads the Plane API key and
webhook HMAC secret only from files in the externally created
`codeops-plane-controller-secrets` Secret, and persists its event/request
deduplication ledger on a single bounded `ReadWriteOnce` claim. The Deployment
uses `Recreate` with one replica so two writers cannot mount or update the
ledger concurrently.

Only the exact SHA-bound
`https://work.renoconcierge.ca/webhooks/plane`
endpoint is public. `/healthz` remains pod-local. Network policy admits ingress
only from ingress-nginx and egress only to Temporal, cluster DNS, and public
HTTPS for the fixed Plane API origin plus the internal control gateway. The
controller image, control-plane SHA, Plane workspace, admitted human actor
IDs, and exact webhook host are validated by the trusted renderer:

```bash
CODEOPS_PLANE_CONTROLLER_DIGEST=sha256:<64-lowercase-hex> \
CODEOPS_CONTROL_PLANE_SHA=<40-lowercase-hex> \
CODEOPS_PLANE_CONTROLLER_HOST=work.renoconcierge.ca \
CODEOPS_PLANE_WORKSPACE_SLUG=<workspace-slug> \
CODEOPS_ALLOWED_HUMAN_ACTOR_IDS=<comma-separated-lowercase-uuids> \
CODEOPS_READY_STATE_ID=<ready-state-lowercase-uuid> \
CODEOPS_PERSONA_USER_IDS=<uuid=@ai-handle,...all-seven-personas> \
  node infra/scripts/render-codeops-plane-controller.mjs \
  > "$CODEOPS_PLANE_CONTROLLER_MANIFEST"
```

The trusted supervisor must create the Secret without logging either value,
copy the preview wildcard TLS Secret, render and server-dry-run the exact
manifest, and verify the PVC, rollout, private health route, public signed
webhook path, and restart-persistent deduplication before configuring Plane.
Plane's webhook record must enable both **Issue** and **Issue comment** events:
Ready admission arrives as an `issue` update, while persona research triggers
arrive as `issue_comment` creation. A live smoke must verify both event flags
before a ticket may move to Ready.
The controller credential is never mounted into the orchestrator or an Agent
Job.

The externally created `codeops-research-projection-auth` Secret contains only
the `token` key and is mounted by the orchestrator and controller. The
orchestrator posts schema-validated research packets and terminal workflow
notices to their cluster-internal exact routes. Network policy admits those
routes only from the orchestrator; the public Ingress still exposes only
`/webhooks/plane`.
The controller durably claims the packet identity before applying exactly one
source-ticket findings comment, reconciles an existing deterministic
`external_source`/`external_id` comment after a crash, and records
`mutations-applied` before acknowledging Temporal. No lifecycle mutation is
representable or admitted.

## Scoped cluster-native image path

Disposable Trial 0 runtime images are built inside isolated Kubernetes Jobs and
stored in an authenticated registry backed by an 8 GiB `ReadWriteOnce` claim.
This replaces dependence on GitHub-hosted runner admission without turning the
old unbounded `rc-image-stage-*` registry into shared infrastructure.

The registry, rootless BuildKit, and source Git images are locked to verified
linux/amd64 platform digests in `cluster-build-images.lock.json`. The registry
has one `Recreate` replica, no service-account token, htpasswd authentication,
a cluster-internal Service, and a SHA-bound TLS pull endpoint. Network policy
admits only ingress-nginx and the exact builder label.

Each externally rendered builder Job:

- checks out exactly one 40-character candidate SHA with a run-scoped
  repository-read credential visible only to the init container;
- removes the Git remote before the build;
- receives no Kubernetes token, host path, Docker socket, Role, or RoleBinding;
- runs rootless BuildKit with a read-only source mount, bounded ephemeral
  storage, one-hour deadline, no retry, and only DNS, registry, and public-HTTPS
  egress;
- builds exactly `codeops-orchestrator-runtime` or the standalone Plane
  controller Dockerfile and pushes a SHA-bound candidate tag to the private
  registry.

Rootless BuildKit requires unconfined seccomp/AppArmor and
`--oci-worker-no-process-sandbox`; this exception is explicit and isolated by
the tokenless account, no host mounts/capabilities, strict network policy, and
disposable namespace. The trusted supervisor must resolve the pushed manifest
to an immutable digest before rendering any runtime workload.

```bash
CODEOPS_BASE_SHA=<40-lowercase-hex> \
CODEOPS_REGISTRY_HOST=registry-<first-12-sha>.preview.renoconcierge.ca \
  node infra/scripts/render-codeops-cluster-registry.mjs \
  > "$CODEOPS_REGISTRY_MANIFEST"

CODEOPS_BASE_SHA=<40-lowercase-hex> \
CODEOPS_IMAGE_KIND=plane-controller \
CODEOPS_BUILD_ID=build-plane-controller-<first-12-sha> \
  node infra/scripts/render-codeops-cluster-image-builder.mjs \
  > "$CODEOPS_IMAGE_BUILDER_MANIFEST"
```

The external supervisor creates three credentials without logging their
contents: `codeops-registry-auth` (`htpasswd`),
`codeops-registry-push` (`config.json` for the internal Service), and
`codeops-registry-pull` (a Kubernetes pull Secret for the exact TLS host).
Builder-specific `codeops-build-<build-id>` Secrets contain only a
run-scoped repository-read token and are deleted with the Job.

## Agent Job boundary

`agent-job-template.yaml` is rendered and applied only by the trusted external
supervisor. Candidate code does not receive Kubernetes credentials and cannot
create this Job itself. The rendered run uses an exact source SHA, digest-only
images, a tokenless service account, an ephemeral workspace and checkpoint, a
memory-backed pod-local ACP socket, a one-hour deadline, and a NetworkPolicy
that denies all ingress and private-network egress.

The init container alone receives the named run-scoped repository-read Secret
and removes the remote after checking out the exact base SHA. The coding-agent
container alone receives the named run-scoped model Secret. Neither credential
is exposed to the session gateway.

`codeops-agent` pins the official Codex ACP adapter and serves it only through
the pod-local Unix socket. `codeops-session-gateway` speaks ACP, allows only
single-use tool permissions, retains bounded and redacted event metadata,
captures a bounded binary Git patch, and atomically checkpoints the response,
event ledger, patch digest, and any failure before stopping the sidecar. It
also emits exactly one digest-bound checkpoint record to its own pod log so the
trusted gateway can retain evidence without exec access to the Agent Job.

The trusted renderer requires an explicit `CODEOPS_AGENT_ROLE`. A
`coding-agent` receives a writable ephemeral source mount. The
`qa-contract-researcher` receives the same exact-SHA source mount read-only,
records its role in checkpoint schema v2, and fails if any source patch exists.
One human-authored research comment may tag multiple registered `@ai-*`
personas. Temporal dispatches one isolated researcher Job per persona
sequentially, preserving the strict Trial 0 one-Job concurrency cap, and the
research packet must record one explicit terminal perspective for each tag.
Neither role receives a Plane credential. Research packets and proposed Plane
mutations must cross the separate controller boundary and satisfy the
`@renoconcierge/codeops-contracts` schemas before application; lifecycle state
changes are not representable for the researcher.

CI independently installs both npm locks, tests and typechecks the gateway,
builds both runtime images, exercises the fail-closed Job renderer, and parses
every rendered resource without requiring cluster discovery. The trusted
supervisor separately performs Kubernetes client dry-runs against the real
cluster API, pushes the exact candidate images, substitutes their registry
digests, and retains the checkpoint before the routing-matrix workload can
count as executed.
