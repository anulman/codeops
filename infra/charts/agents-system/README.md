# Mission Control `agents-system` package

This chart packages the independent internal Agent Sessions control plane. It
installs only into the `agents-system` namespace and exposes only
`agents.renoconcierge.ca`.

The chart contains:

- dedicated PostgreSQL storage for session state;
- the authenticated session control gateway;
- the HMAC-authenticated Plane and GitHub webhook controller;
- the Mission Control UI with signed Cloudflare Access JWT verification;
- scoped ServiceAccounts for the UI, gateway, and per-session runtime;
- persistent Codex authentication storage and immutable runtime image inputs;
- a namespace-wide default deny plus explicit component NetworkPolicies.

The chart does not create credentials. Before installation, the internal
release boundary must create these Secrets:

- `agents-system-postgres`: `password`;
- `agents-system-session-secrets`: `database-url`, `read-token`, `write-token`,
  `runtime-worker-token`, `initialization-token`, `github-steering-token`;
- `agents-system-access`: `audience`, `allowed-emails`.
- `agents-system-controller-secrets`: `plane-api-key`, `plane-webhook-secret`,
  `research-projection-token`, `repository-head-token`,
  `github-webhook-secret`, `github-steering-token`.
- `agents-system-controller-config`: the controller's non-file runtime
  configuration, including Temporal, Plane, repository, actor, persona, and
  lifecycle state identities.

The GitHub webhook controller is a separate HMAC-authenticated process. It uses
the gateway's dedicated steering token and has no browser, merge, release, or
Kubernetes authority. Per-session runtime Jobs consume the immutable worker
and coding-agent image references from `agents-system-runtime-images`; the
runtime ServiceAccount does not receive a Kubernetes API token or RBAC grant.

Render with exact digests and the Access team domain:

```sh
helm template mission-control infra/charts/agents-system \
  --namespace agents-system \
  --set missionControl.image.digest=sha256:<digest> \
  --set gateway.image.digest=sha256:<digest> \
  --set githubController.image.digest=sha256:<digest> \
  --set githubController.controlPlaneSha=<git-sha> \
  --set postgresql.image.digest=sha256:<digest> \
  --set runtime.workerImage.digest=sha256:<digest> \
  --set runtime.agentImage.digest=sha256:<digest> \
  --set missionControl.access.issuer=https://<team>.cloudflareaccess.com
```

Run the chart contract with:

```sh
node --test infra/scripts/test-agents-system-chart.mjs
```
