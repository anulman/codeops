# CodeOps Helm chart

This chart packages the CodeOps control plane. The release name, namespace,
node selector, storage class, image registry, and Secret names are
configurable. All CodeOps images must use exact SHA-256 digests.

The chart contains:

- dedicated PostgreSQL storage for session state;
- the trusted Kubernetes Agent Job control gateway and evidence storage;
- the authenticated session control gateway;
- the HMAC-authenticated Plane and GitHub webhook controller;
- the Temporal workflow orchestrator;
- the Agents UI on a private ClusterIP Service;
- scoped ServiceAccounts and RBAC for each fixed operand and per-session runtime;
- a Varlock-backed model proxy and immutable runtime image inputs;
- an install Job and pre-upgrade, non-retrying schema migration hook;
- default-deny selection for every CodeOps workload, each managed Temporal,
  JetStream, and Plane workload, and the Plane MinIO setup Job, plus explicit
  same-namespace and external paths.

## Quickstart

The released OCI chart contains the exact immutable image digests and
control-plane source SHA for its version. The default `full-managed` profile
installs PostgreSQL, Temporal, JetStream, and Plane. The committed quickstart
example instead uses managed PostgreSQL, Temporal, and JetStream with one
external Plane instance.

From a source checkout, run the doctor and generate one private values file:

```sh
nub run doctor -- --cluster
nub run init:quickstart -- \
  --input /absolute/path/onboarding.json \
  --output /absolute/path/values.yaml
```

Start the non-secret input from `examples/onboarding.example.json`. The
initializer discovers the repository, current GitHub user ID, and Kubernetes
API service CIDR when possible. It reads credentials only from the configured
environment-variable names. It writes mode `0600` output and never prints a
credential or generated Secret value.

Then install one single-repository control plane:

```sh
helm install codeops oci://ghcr.io/anulman/codeops/charts/codeops \
  --version <version> \
  --namespace codeops \
  --create-namespace \
  --values /absolute/path/values.yaml
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

The chart creates no Ingress. Use `kubectl port-forward` for local operator
access. If the installation needs public UI or webhook routes, the deployment
consumer must create the Ingress, TLS, and edge authentication resources. Use
the distinct webhook Secrets from the same values file.

## Optional runtime egress proxy

Set `runtimeEgressProxy.enabled=true` to route workspace runtime HTTP and HTTPS
traffic through one internal Squid Service. When enabled, the chart removes
direct public TCP 443 egress from runtime Pods. It permits runtime Pods to
reach the proxy and required internal Services. The proxy accepts only exact
lowercase domain names and configured destination ports. Its generated
configuration denies private, loopback, link-local, metadata, multicast, and
reserved IPv4 destinations after DNS resolution. The final Squid rule denies
all remaining requests.

Use an immutable Squid image digest and an explicit allowlist:

```yaml
runtimeEgressProxy:
  enabled: true
  image:
    repository: ubuntu/squid
    digest: sha256:<64-lowercase-hex-characters>
  allowedDomains:
    - registry.npmjs.org
    - pypi.org
  allowedConnectPorts: [443]
  allowPlainHttp: false
  externalLogRetentionNotice: "Retained by the cluster log collector for 30 days."
```

The proxy does not intercept TLS. Its JSON access record contains only the
timestamp, client Pod IP, method, destination host and port, result, upstream
status, transferred byte count, and duration. CodeOps stores the corresponding
session ID, generation, Pod UID, Pod IP, and observation time in
`codeops.runtime_egress_pod_observations`. Join a proxy record to that table by
Pod IP and the observation time interval. Configure a cluster log collector if
the records must survive Pod deletion.

This feature is an audit and allowlist control. It is not data-loss prevention.
A runtime can send data to an allowed HTTPS destination or encode data in DNS
queries. CONNECT can also carry a non-HTTPS protocol on an allowed port. Keep
the allowlist narrow. Use only trusted repositories. If the feature is
disabled, the chart keeps the existing monitored direct public HTTPS policy.

Each session has one immutable owner principal. The private chart default sets
`agentsUi.authentication.fixedPrincipal=codeops:agents-ui`, which preserves a
single shared operator identity. For multiple operators, clear
`fixedPrincipal` and set `agentsUi.authentication.principalHeader` to the
lowercase name of a trusted edge-authentication header. The edge must remove
any client-supplied copy of that header and write the authenticated principal
before it forwards the request. Configure exactly one of these two values.

On the first upgrade that adds session ownership, set
`sessionOwner.legacyPrincipalId` if the database contains existing sessions.
The migration assigns that explicit principal to every legacy session. It
fails closed if existing sessions are present and the value is empty or
invalid. After the migration succeeds, remove the value from later upgrades.

CodeOps 0.5 projects a stored 0.4.2 workspace identity that has no session
policy into the immutable `implement` policy with an empty context-attachment
descriptor list. The projection does not rewrite the stored snapshot. This
keeps the snapshot readable by 0.4.2 during an atomic upgrade rollback. The
Agents UI acceptance gate loads a serialized 0.4.2 snapshot and checks the
authenticated fleet-backed `/` route and the `/new` route.

Helm uninstall retains the quickstart Secrets and PostgreSQL data PVC. Delete
them explicitly only when you intend to destroy the installation identity and
stored data.

## Existing-Secret mode

For a production consumer repository, use the released `codeopsctl.mjs` and
`codeops-consumer-lock.json`. The CLI owns release verification, the Helm
upgrade and compensating rollback transaction, readiness, preservation
evidence, and exact image verification. The
consumer owns its values, cluster policy, kubeconfig, external Secret names,
provider checks, and public authentication acceptance. See
[`docs/operations/consumer-deployment.md`](../../../docs/operations/consumer-deployment.md).

When `quickstart.enabled=false`, the chart does not create credentials. Before
installation, the operator must create these Secrets:

- `codeops-postgres`: `password`;
- `codeops-session-secrets`: `database-url`, `read-token`, `write-token`,
  `runtime-worker-token`, `initialization-token`, `runtime-database-url`,
  `runtime-database-role`. The runtime URL uses the
  named receipt-only role and a 32–256 character URL-safe password. Its host,
  port, and database must match `database-url`; it must not use the gateway
  database role;
- `codeops-model-proxy-credentials`: `openai-api-key`, `signing-key`,
  `database-url`, and `database-role`. The database URL uses the named
  execute-only ledger role and a 32–256 character URL-safe password. Its host,
  port, and database must match the gateway database URL;
- `codeops-control-gateway-secrets`: `dispatch-token`,
  `repository-head-token`, `github-mutation-token`, `publication-token`.
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

Quickstart uses the chart's generic `AGENTS.md` and `SOUL.md` baselines when
their values are empty. These defaults include the repository authority
boundary and the ASD-STE100 technical product writing standard. Existing-
Secret mode remains explicit: an operator must supply all seven documents.
`CURRENT-STATE.md`, `DECISIONS.md`, `DOMAIN.md`, `PRODUCT.md`, and
`SOURCE-MAP.md` never have generic defaults because they describe one exact
repository.
- `codeops-runtime-source`: `repository-read-token`. Only the trusted
  root-session Job uses this read-only source credential.

Before upgrading an existing-Secret installation to a release with interactive
workspace launch, add a distinct `workspace-launch-token` to
`controlGateway.secretName`. Also include the control-gateway and runtime
repository-authority Secret names in the consumer policy's `requiredSecrets`
list. See
[`docs/operations/consumer-deployment.md`](../../../docs/operations/consumer-deployment.md#upgrade-for-interactive-workspace-launch)
for the ordered upgrade and catalog contract.

Before enabling permissioned GitHub mutations, add a distinct
`github-mutation-token` to `controlGateway.secretName`. The session gateway
uses this internal authority only after it consumes one exact durable
allow-once decision. The control gateway permits only pull-request branch
updates, bounded pull-request metadata updates, review-thread replies, and
check reruns. It does not provide a generic GitHub API route.

The controller is a separate HMAC-authenticated process. Plane webhooks use
`/webhooks/plane/{owner}/{repository}`. The route selects the repository's
Plane webhook secret before payload processing. GitHub webhooks
select the signing key from the untrusted payload's bounded repository
identity, verifies the exact raw body, and then admits the parsed event. An
unknown repository or a signature from another repository fails closed. The
controller and gateway select the same repository-specific steering token and
reject cross-repository use. The controller has no browser,
merge, release, or Kubernetes authority. Per-session runtime Jobs consume the immutable worker
and coding-agent image references from a content-addressed
`codeops-runtime-images-<digest>` ConfigMap; the
runtime ServiceAccount does not receive a Kubernetes API token or RBAC grant.
The gateway and model proxy mount the same `signing-key` from
`codeops-model-proxy-credentials`. No copied key or equality check is
required. The coding-agent container receives only a 75-minute session-bound
proxy token. The proxy role can execute only the fixed budget reservation and
settlement functions. It cannot read or write ledger tables directly. The
coding-agent container never mounts the reusable OpenAI credential, database
credential, or reusable Codex state.

To expose Plane admission through the live controller Service, enable the
repository-qualified webhook Ingress:

```yaml
githubController:
  webhookIngress:
    enabled: true
    className: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
    host: work.example.com
    tlsSecretName: codeops-plane-webhook-tls
    repositories:
      - example/codeops-demo
```

Configure Plane with
`https://work.example.com/webhooks/plane/example/codeops-demo`. The Ingress
uses one exact path for each admitted repository and forwards to the stable
`<release>-codeops-github-controller` Service. Helm upgrades can replace the
controller image without changing the Plane webhook URL. The chart does not
expose the unqualified legacy `/webhooks/plane` path.

The default provider mode is `modelProxy.provider.primary=api-key`. To use a
ChatGPT subscription as the primary provider, set `primary=chatgpt-primary`,
set `chatgptAuthClaimName` to a dedicated ReadWriteOnce PVC in the release
namespace, and keep `replicas=1`. The PVC must contain the Codex OAuth cache at
`chatgptAuthFile`. Set `apiKeyFallback=true` to retain the `openai-api-key` as
the fallback. The model proxy mounts and rotates the OAuth cache. Agent Jobs do
not mount it. The broker falls back only before subscription inference starts
or after an explicit 401, 403, or 429 response. It does not replay an ambiguous
transport failure or a 5xx response.

Coding agents use cached Codex web search for ordinary research. Codex
auto-review evaluates exceptional command-level network requests without a
human prompt for each request. Kubernetes NetworkPolicies continue to deny
private, loopback, and link-local destinations. This design reduces the risk
of autonomous egress without blocking normal research. It does not prevent a
compromised repository from sending data to a public destination that the
automatic reviewer permits. Keep session repositories trusted, review the
durable ACP timeline, and use a dedicated OpenAI project with server-side
budget and rate limits.

Interactive workspace launch uses two separate Pods. A short-lived source
materializer receives the selected repositories' read tokens, resolves only
the server-pinned commits, removes every Git remote, and writes the result to
one bounded workspace PVC. The control gateway deletes the credential Secret
and materializer Job before it creates the runtime Job. The runtime Pod never
mounts repository credentials. It retains the established monitored public
HTTPS policy for research and package retrieval. Therefore, admit only trusted
catalog repositories: repository content executes with public HTTPS egress,
but without reusable GitHub or model-provider credentials.

Workspace checkpoints persist the actual bounded source patches and canonical
scratch-file bundle in PostgreSQL before the checkpoint completion commits.
The runtime database role can insert and verify only its execution receipts
and checkpoint artifacts. Digest-only evidence is not a recoverability
boundary.

The model proxy records token subject, status, latency, request size, request
count, and concurrency. It does not record request bodies. It accepts only
`gpt-5.6-sol` Responses API requests. It adds or enforces a 32,768 output-token
ceiling and permits at most 200 requests for one short-lived run token. It
warns at 4 MiB per request, 4 concurrent requests per token, or 8 concurrent
requests globally. It uses high stop-loss limits of 20 MiB per request, 8
concurrent requests per token, and 16 concurrent requests globally. These
limits are incident controls, not normal operating targets. Keep the dedicated
OpenAI project server-side budget as the final spend boundary.

The quickstart runs the forward-compatible schema migration as an ordinary Job
during the first installation and as a `pre-upgrade` hook for later revisions.
The install Job can run while Helm waits for workload readiness, so workloads
that use migrated database roles do not deadlock the `post-install` phase. The
migration creates or rotates the receipt-only runtime role from the exact
runtime DSN, removes all broad schema/table/sequence
authority, and grants only the execution-receipt and workspace-artifact
columns. The migration is non-retrying and blocks Helm completion if the
database contract is not ready.

Helm uninstall removes the workloads, Services, RBAC, NetworkPolicies, and
migration Job or hook. Kubernetes retains the PostgreSQL StatefulSet data PVC
so an operator must explicitly remove that data or delete the release
namespace.

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

Render with exact digests:

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
