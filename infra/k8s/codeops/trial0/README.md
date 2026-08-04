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
