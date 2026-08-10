# CodeOps Helm chart

This chart packages the CodeOps control plane. The release name, namespace,
host, ingress class, node selector, storage class, image registry, and Secret
names are configurable. All CodeOps images must use exact SHA-256 digests.

The chart contains:

- dedicated PostgreSQL storage for session state;
- the authenticated session control gateway;
- the HMAC-authenticated Plane and GitHub webhook controller;
- the Agents UI with signed Cloudflare Access JWT verification;
- scoped ServiceAccounts for the UI, gateway, model proxy, and per-session runtime;
- a Varlock-backed model proxy and immutable runtime image inputs;
- a pre-upgrade, non-retrying schema migration Job;
- a namespace-wide default deny plus explicit component NetworkPolicies.

The chart does not create credentials. Before installation, the internal
release boundary must create these Secrets:

- `codeops-postgres`: `password`;
- `codeops-session-secrets`: `database-url`, `read-token`, `write-token`,
  `runtime-worker-token`, `initialization-token`, `github-steering-token`,
  `runtime-database-url`, `runtime-database-role`. The runtime URL uses the
  named receipt-only role, a 32–256 character URL-safe password, the in-cluster
  PostgreSQL service, and database `agents`; it must not use the gateway
  database role;
- `codeops-model-proxy-credentials`: `openai-api-key`, `signing-key`;
- `codeops-access`: `audience`, `allowed-emails`.
- `codeops-controller-secrets`: `plane-api-key`, `plane-webhook-secret`,
  `research-projection-token`, `repository-head-token`,
  `github-steering-token`.
- `codeops-controller-config`: the controller's non-file runtime
  configuration, including Temporal, Plane, repository, actor, persona, and
  lifecycle state identities.
- `codeops-repository-webhooks`: `registry.json` plus only the repository-scoped
  GitHub webhook secret files referenced by that manifest. Use schema
  `codeops.repository-registry/v1`. Keep the read-token and write-token file
  references in the manifest, but do not include those credentials in this
  Secret. The webhook controller must not receive repository read or write
  authority. Do not put credentials inline. Do not reuse a webhook Secret key
  or credential value across repositories.
- `codeops-runtime-source`: `repository-read-token`. Only the trusted
  root-session Job uses this read-only source credential.

The GitHub webhook controller is a separate HMAC-authenticated process. It
selects the signing key from the untrusted payload's bounded repository
identity, verifies the exact raw body, and then admits the parsed event. An
unknown repository or a signature from another repository fails closed. The
controller uses the gateway's dedicated steering token and has no browser,
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

The main-only `internal` release first installs PostgreSQL with application
replicas at zero when the Helm release does not exist. The next Helm revision
runs the forward-compatible schema migration as a `pre-upgrade` hook. The
migration creates or rotates the receipt-only runtime role from the exact
runtime DSN, removes all broad schema/table/sequence authority, and grants only
the execution-receipt columns. It then
rolls out all application workloads with `--atomic --wait`. Later releases run
the same migration hook before each rollout.

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
  --set githubController.image.digest=sha256:<digest> \
  --set githubController.controlPlaneSha=<git-sha> \
  --set postgresql.image.digest=sha256:<digest> \
  --set runtime.workerImage.digest=sha256:<digest> \
  --set runtime.agentImage.digest=sha256:<digest> \
  --set modelProxy.image.digest=sha256:<digest> \
  --set agentsUi.access.issuer=https://<team>.cloudflareaccess.com
```

Run the chart contract with:

```sh
node --test infra/scripts/test-codeops-chart.mjs
node --test infra/scripts/test-codeops-root-session.mjs
node --test infra/scripts/test-codeops-release-images.mjs
```
