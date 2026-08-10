# Agents control plane `agents-system` package

This chart packages the independent internal Agent Sessions control plane. It
installs only into the `agents-system` namespace and exposes only
`agents.renoconcierge.ca`.

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

- `agents-system-postgres`: `password`;
- `agents-system-session-secrets`: `database-url`, `read-token`, `write-token`,
  `runtime-worker-token`, `initialization-token`, `github-steering-token`,
  `runtime-database-url`, `runtime-database-role`. The runtime URL uses the
  named receipt-only role, a 32–256 character URL-safe password, the in-cluster
  PostgreSQL service, and database `agents`; it must not use the gateway
  database role. Add `model-proxy-signing-key`; it must equal the model proxy
  Secret's `signing-key`;
- `agents-system-model-proxy-credentials`: `openai-api-key`, `signing-key`;
- `agents-system-access`: `audience`, `allowed-emails`.
- `agents-system-controller-secrets`: `plane-api-key`, `plane-webhook-secret`,
  `research-projection-token`, `repository-head-token`,
  `github-webhook-secret`, `github-steering-token`.
- `agents-system-controller-config`: the controller's non-file runtime
  configuration, including Temporal, Plane, repository, actor, persona, and
  lifecycle state identities.
- `agents-system-runtime-source`: `repository-read-token`. Only the trusted
  root-session Job uses this read-only source credential.

The GitHub webhook controller is a separate HMAC-authenticated process. It uses
the gateway's dedicated steering token and has no browser, merge, release, or
Kubernetes authority. Per-session runtime Jobs consume the immutable worker
and coding-agent image references from `agents-system-runtime-images`; the
runtime ServiceAccount does not receive a Kubernetes API token or RBAC grant.
The coding-agent container receives only a 75-minute session-bound proxy token.
It never mounts the reusable OpenAI credential or reusable Codex state.

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
  node infra/scripts/render-agents-system-root-session.mjs > /tmp/root-session.yaml
```

Review the manifest, then apply it through the trusted Kubernetes operator.
The runtime worker calls the gateway's dedicated initialization endpoint. The
request is authenticated and idempotent for the exact root identity. The
Agents UI does not receive the initialization token or Kubernetes authority.

Render with exact digests and the Access team domain:

```sh
helm template agents-system infra/charts/agents-system \
  --namespace agents-system \
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
node --test infra/scripts/test-agents-system-chart.mjs
node --test infra/scripts/test-agents-system-root-session.mjs
node --test infra/scripts/test-agents-system-release-images.mjs
```
