# CodeOps Helm chart

This chart packages the CodeOps control plane. The release name, namespace,
host, ingress class, node selector, storage class, image registry, and Secret
names are configurable. All CodeOps images must use exact SHA-256 digests.

The chart contains:

- dedicated PostgreSQL storage for session state;
- the trusted Kubernetes Agent Job control gateway and evidence storage;
- the authenticated session control gateway;
- the HMAC-authenticated Plane and GitHub webhook controller;
- the Temporal workflow orchestrator;
- the Agents UI with signed Cloudflare Access JWT verification;
- scoped ServiceAccounts and RBAC for each fixed operand and per-session runtime;
- a Varlock-backed model proxy and immutable runtime image inputs;
- a post-install and pre-upgrade, non-retrying schema migration Job;
- a namespace-wide default deny plus explicit component NetworkPolicies.

## Quickstart

The released OCI chart contains the exact immutable image digests and
control-plane source SHA for its version. Pull the chart once to copy its
values example:

```sh
helm registry login ghcr.io
helm pull oci://ghcr.io/anulman/codeops/charts/codeops \
  --version <version> --untar
cp codeops/examples/quickstart-values.yaml values.yaml
```

Replace every empty or angle-bracket value in `values.yaml`. Then install one
single-repository control plane:

```sh
helm install codeops oci://ghcr.io/anulman/codeops/charts/codeops \
  --version <version> \
  --namespace codeops \
  --create-namespace \
  --values values.yaml
```

Quickstart mode creates the required Kubernetes Secrets. It generates internal
database passwords, service tokens, the model-proxy signing key, and the
session steering token. It keeps those values stable during upgrade and
rollback by reading the installed Secret before it renders a replacement.
Quickstart supports exactly one repository. Use the existing-Secret mode below
for multiple repositories or externally managed credentials.

The values file contains external credentials. Helm also stores supplied
values and rendered Secret manifests in the release record. Use dedicated
sandbox credentials. Keep the file out of source control. Use the
existing-Secret mode with an external Secret controller for production.

After installation, configure the GitHub webhook at
`https://<host>/webhooks/github` and the Plane webhook at
`https://<host>/webhooks/plane/<owner>/<repository>`. Use the distinct webhook
Secrets from the same values file.

Helm uninstall retains the quickstart Secrets and PostgreSQL data PVC. Delete
them explicitly only when you intend to destroy the installation identity and
stored data.

## Existing-Secret mode

When `quickstart.enabled=false`, the chart does not create credentials. Before
installation, the operator must create these Secrets:

- `codeops-postgres`: `password`;
- `codeops-session-secrets`: `database-url`, `read-token`, `write-token`,
  `runtime-worker-token`, `initialization-token`, `runtime-database-url`,
  `runtime-database-role`. The runtime URL uses the
  named receipt-only role and a 32–256 character URL-safe password. Its host,
  port, and database must match `database-url`; it must not use the gateway
  database role;
- `codeops-model-proxy-credentials`: `openai-api-key`, `signing-key`;
- `codeops-access`: `audience`, `allowed-emails`.
- `codeops-control-gateway-secrets`: `dispatch-token`,
  `repository-head-token`, `publication-token`.
- `codeops-controller-secrets`: `research-projection-token`.
- `codeops-controller-config`: the controller's non-file runtime
  configuration, including Temporal, internal service origins, the control
  plane source SHA, and durable-state settings. Repository, Plane, actor,
  persona, project, and lifecycle identities belong in the registry.
- `codeops-repository-controller-authority`: `registry.json` plus only the
  repository-scoped GitHub webhook secret, session steering token, Plane API
  key, and Plane webhook secret files referenced by that manifest. Use schema
  `codeops.repository-registry/v1`. Keep the read-token and write-token file
  references in the manifest, but do not include those credentials in this
  Secret. Each repository entry must bind one Plane API origin, workspace,
  project, Ready/In Progress/Needs attention/Complete state set, and Plane
  credential file pair. The controller must not receive repository read or write
  authority. Do not put credentials inline. Do not reuse a Secret key or
  credential value across repositories or authority types.
- `codeops-repository-steering`: `registry.json` plus only the repository-scoped
  session steering token files referenced by that manifest. It must not include
  GitHub webhook, repository read, or repository write credentials.
- `codeops-repository-runtime-authority`: `registry.json` plus only the
  repository-scoped read-token and write-token files referenced by that
  manifest. The control gateway uses this Secret for GitHub evidence reads and
  candidate publication. It must not contain Plane, webhook, or steering
  credentials.
- one project-context Secret per repository. Each Secret contains `AGENTS.md`,
  `SOUL.md`, `CURRENT-STATE.md`, `DECISIONS.md`, `DOMAIN.md`, `PRODUCT.md`, and
  `SOURCE-MAP.md`. Add its Secret name and a unique lowercase directory to
  `githubController.repositoryContexts`. Set the manifest's
  `policy.projectContextRoot` to
  `/var/run/secrets/<full-name>-contexts/<directory>`.
- `codeops-runtime-source`: `repository-read-token`. Only the trusted
  root-session Job uses this read-only source credential.

The controller is a separate HMAC-authenticated process. Plane webhooks use
`/webhooks/plane/{owner}/{repository}`. The route selects the repository's
Plane webhook secret before payload processing. GitHub webhooks
select the signing key from the untrusted payload's bounded repository
identity, verifies the exact raw body, and then admits the parsed event. An
unknown repository or a signature from another repository fails closed. The
controller and gateway select the same repository-specific steering token and
reject cross-repository use. The controller has no browser,
merge, release, or Kubernetes authority. Per-session runtime Jobs consume the immutable worker
and coding-agent image references from `codeops-runtime-images`; the
runtime ServiceAccount does not receive a Kubernetes API token or RBAC grant.
The gateway and model proxy mount the same `signing-key` from
`codeops-model-proxy-credentials`. No copied key or equality check is
required. The coding-agent container receives only a 75-minute session-bound
proxy token. It never mounts the reusable OpenAI credential or reusable Codex
state.

Coding agents use cached Codex web search for ordinary research. Codex
auto-review evaluates exceptional command-level network requests without a
human prompt for each request. Kubernetes NetworkPolicies continue to deny
private, loopback, and link-local destinations. This design reduces the risk
of autonomous egress without blocking normal research. It does not prevent a
compromised repository from sending data to a public destination that the
automatic reviewer permits. Keep session repositories trusted, review the
durable ACP timeline, and use a dedicated OpenAI project with server-side
budget and rate limits.

The model proxy records token subject, status, latency, request size, and
concurrency. It does not record request bodies. It warns at 4 MiB per request,
4 concurrent requests per token, or 8 concurrent requests globally. It uses
high stop-loss limits of 20 MiB per request, 8 concurrent requests per token,
and 16 concurrent requests globally. These limits are incident controls, not
normal operating targets.

The quickstart runs the forward-compatible schema migration as a
`post-install` hook during the first installation and as a `pre-upgrade` hook
for later revisions. The migration creates or rotates the receipt-only runtime
role from the exact runtime DSN, removes all broad schema/table/sequence
authority, and grants only the execution-receipt columns. The hook is
non-retrying and blocks Helm completion if the database contract is not ready.

Helm uninstall removes the workloads, Services, RBAC, NetworkPolicies, and
migration hook. Kubernetes retains the PostgreSQL StatefulSet data PVC so an
operator must explicitly remove that data or delete the release namespace.

Create the first root session only from the trusted operator boundary. Render
one immutable, non-retrying runtime Job with exact session identity:

```sh
CODEOPS_AGENT_DIGEST=sha256:<digest> \
CODEOPS_SESSION_RUNTIME_WORKER_DIGEST=sha256:<digest> \
CODEOPS_BASE_SHA=<40-character-sha> \
CODEOPS_BRANCH=<branch> \
CODEOPS_LEASE_ID=<uuid> \
CODEOPS_RUN_ID=<dns-safe-run> \
CODEOPS_SESSION_ID=<session-id> \
CODEOPS_SESSION_SUFFIX=<dns-safe-suffix> \
CODEOPS_WORKFLOW_ID=<dns-safe-workflow> \
  node infra/scripts/render-codeops-root-session.mjs > /tmp/root-session.yaml
```

Review the manifest, then apply it through the trusted Kubernetes operator.
The runtime worker calls the gateway's dedicated initialization endpoint. The
request is authenticated and idempotent for the exact root identity. The
Agents UI does not receive the initialization token or Kubernetes authority.

Render with exact digests and the Access team domain:

```sh
helm template codeops infra/charts/codeops \
  --namespace codeops \
  --set agentsUi.image.digest=sha256:<digest> \
  --set gateway.image.digest=sha256:<digest> \
  --set controlGateway.image.digest=sha256:<digest> \
  --set githubController.image.digest=sha256:<digest> \
  --set orchestrator.image.digest=sha256:<digest> \
  --set githubController.controlPlaneSha=<git-sha> \
  --set postgresql.image.digest=sha256:<digest> \
  --set runtime.workerImage.digest=sha256:<digest> \
  --set runtime.agentImage.digest=sha256:<digest> \
  --set runtime.sessionGatewayImage.digest=sha256:<digest> \
  --set modelProxy.image.digest=sha256:<digest> \
  --set agentsUi.access.issuer=https://<team>.cloudflareaccess.com \
  --set temporal.address=temporal.codeops.svc:7233 \
  --set 'controlGateway.kubernetesApiCidrs[0]=<api-service-ip>/32'
```

Run the chart contract with:

```sh
node --test infra/scripts/test-codeops-chart.mjs
node --test infra/scripts/test-agents-system-root-session.mjs
node --test infra/scripts/test-codeops-release-images.mjs
node --test infra/scripts/test-codeops-release-workflow.mjs
node --test infra/scripts/test-standalone-image-packaging.mjs
```
