# Consumer deployment

Use `codeopsctl` when a repository owns its CodeOps installation. The CLI is
the primary operator interface. The reusable GitHub Action is a thin wrapper
around the same file.

Each CodeOps GitHub Release contains:

- `codeopsctl.mjs`;
- `codeops-consumer-lock.json`;
- `release-manifest.json`;
- `golden-release-report.json`;
- the OCI chart archive and `SHA256SUMS`.

`golden-release-report.json` uses schema
`codeops.golden-release-report/v2`. It binds two operational-only proofs to the
same source SHA and immutable release manifest:

- `sourceProof.evidence` declares `simulated-provider` with fake-provider
  mode because the 11 deterministic source scenarios use fake adapters;
- `artifactProof.evidence` declares `released-image`, no source checkout, and
  immutable image references because an anonymous disposable cluster resolved all ten images and the exact OCI
  chart, deployed the release, rejected a forced update, restored the prior
  revision, passed `codeops.smoke/v1`, and completed cleanup.

The report does not declare browser acceptance or live-provider evidence. It
does not claim that the source scenarios ran inside the deployed services. It
contains no prompt, body, diff, log, attachment, credential, Secret data, or
raw Kubernetes workload object.

Commit the release's `codeops-consumer-lock.json` to the consumer repository.
Commit the non-secret Helm values and one policy file. Do not commit a
credential value.

The policy uses schema `codeops.consumer-policy/v1`:

```json
{
  "schemaVersion": "codeops.consumer-policy/v1",
  "helmTimeout": "20m",
  "httpTimeoutMs": 15000,
  "requiredSecrets": ["codeops-postgres", "codeops-session-secrets"],
  "cluster": {
    "kubernetesServiceCidrs": ["10.43.0.1/32"],
    "readyNodeSelector": "example.com/codeops=true"
  },
  "postDeployHttpChecks": [
    { "url": "https://plane.example.com", "acceptedStatuses": [200] }
  ]
}
```

`helmTimeout` defaults to `20m`. `httpTimeoutMs` defaults to 15000.
`acceptedStatuses` defaults to `[200]`. The CLI rejects unknown fields and
out-of-range duration, timeout, and status values.

The consumer owns these environment rules. CodeOps does not create, read,
export, or rotate the listed Secret values.

Verify without Kubernetes mutation:

```sh
node codeopsctl.mjs verify \
  --lock infra/codeops/codeops-consumer-lock.json \
  --values infra/codeops/values.yaml \
  --release codeops \
  --namespace codeops
```

Deploy after the workflow writes an explicit `KUBECONFIG`:

```sh
node codeopsctl.mjs deploy \
  --lock infra/codeops/codeops-consumer-lock.json \
  --values infra/codeops/values.yaml \
  --policy infra/codeops/policy.json \
  --release codeops \
  --namespace codeops
```

The deploy command verifies public release artifacts and environment policy.
It snapshots release PVC identities and hashes external Secret data without
printing it. It then runs one atomic Helm upgrade, checks release identity and
readiness, rejects image drift, and runs bounded HTTPS checks. If a check after
Helm fails, the command rolls an upgrade back to the exact prior revision. It
uninstalls a failed first release. It also removes a namespace that it created
for that failed first release. The command emits
`codeops.consumer-evidence/v1` JSON only after the complete transaction passes.
It does not test provider-specific product behavior.

Run a credential-safe readiness check at any time:

```sh
node codeopsctl.mjs smoke --release codeops --namespace codeops
```

GitHub Actions consumers can pin the release source SHA:

```yaml
- uses: anulman/codeops/.github/actions/codeops@<40-character-source-sha>
  with:
    command: deploy
    lock: infra/codeops/codeops-consumer-lock.json
    values: infra/codeops/values.yaml
    policy: infra/codeops/policy.json
    release: codeops
    namespace: codeops
```

The consumer workflow still owns its kubeconfig source, environment approval,
concurrency, provider checks, and public-edge acceptance.

## Upgrade for interactive workspace launch

Before a consumer upgrades from a release without interactive workspace
launch, update the external Secrets. Do this before `codeopsctl deploy` so the
new Deployments do not wait for a missing Secret key.

1. Add one new `workspace-launch-token` key to the Secret selected by
   `controlGateway.secretName`. Generate a URL-safe value of at least 32
   characters. Do not reuse the dispatch, repository-head, publication,
   session, steering, or model-proxy token.
2. Keep every catalog repository in the Secret selected by
   `controlGateway.repositoryAuthoritySecretName`. Its `registry.json` uses
   `codeops.repository-registry/v1`. Each entry references distinct
   repository-scoped `readTokenFile` and `writeTokenFile` paths in that same
   Secret. The launch path mounts only the read token in the short-lived source
   materializer. Publication remains a separate operation that uses write
   authority.
3. Add the control-gateway and repository-authority Secret names to the
   consumer policy's `requiredSecrets` list. This makes `codeopsctl deploy`
   verify that their identities and data hashes do not change during the Helm
   transaction.
4. Run `codeopsctl verify`, then deploy the immutable release. The migration
   hook creates the workspace launch and checkpoint-artifact tables and grants
   the receipt-only runtime role the exact artifact columns that it needs.

The public catalog exposes no credential or Secret path. It derives one key
from each repository name, converts the key to lowercase, replaces unsupported
characters with hyphens, and selects `main`. Repository names must therefore
produce unique keys after normalization. For example, `anulman/CodeOps`
becomes `codeops`. Use distinct repository names when two owners have
repositories whose names normalize to the same key.

Quickstart mode creates and retains the launch token automatically. Existing-
Secret mode never creates or changes the consumer's Secret data.

## One-stop upgrade (COAUTO-49)

Use the released `codeopsctl.mjs` from the approved target release. Verify its
`SHA256SUMS` first. An upgrade consumes an existing immutable release; release
publication and human environment approvals remain in their existing workflows.
It does not build, retag, publish, or grant itself authority.

Recommended noninteractive agent invocation, after approval and provisioning
an explicit `KUBECONFIG`:

```sh
node codeopsctl.mjs upgrade \
  --lock infra/codeops/codeops-consumer-lock.json \
  --values infra/codeops/values.yaml \
  --policy infra/codeops/policy.json \
  --release codeops --namespace codeops \
  --operation-dir /private/operator-state/codeops-upgrade \
  --notification-url https://events.example.com/codeops-upgrades
```

Use complete non-secret values with external credential references. Upgrade
uses Helm `--reset-values`; it does not inherit unspecified installed values.
The namespace and a deployed Helm release must already exist. The operator
needs the chart's Kubernetes
permissions, including permissions in its execution namespace. Preserve the
consumer workflow's approval and per-installation concurrency gate. The local
operation lock is not a distributed installation lock.

The command verifies the existing release's golden report against the exact
source, chart, and image digests. It renders the chart and checks cluster network
configuration, Ready nodes, RBAC, service accounts, and required Secret and
ConfigMap references and keys. It repeats preflight immediately before cutover.
Upgrade is forward-only: it uses neither Helm `--atomic` nor compensating
rollback, uninstall, or database-owner role regrant on failure. After application-
role cutover, restarting an older API or downgrading Helm is unsupported. Failed
effects retain diagnostics and an unknown or failed state for explicit forward
reconciliation. Review migration and release compatibility before authorization.
The separate `deploy` command retains its existing rollback behavior; do not use
it as a recovery shortcut across this cutover.

The operation directory must be operator-owned, mode `0700`, outside source
control, and on durable local storage. Receipts use mode `0600` and atomic,
synced replacement. The identity binds exact lock, values and policy bytes,
release name, namespace UID, cluster UID, and notification destination. Retain
this directory and its artifact cache across invocations. Do not edit its state.
No historical authority is inferred from a receipt.

### Plan, compose, and recover

Add `--plan` (alias `--dry-run`) to inspect the stages and input hashes without
network access, subprocesses, or file writes. A plan is not a live preflight.
The operation directory and notification destination are optional for a plan.

Stages are `verify`, `preflight`, `deploy`, and `notify`. Add `--stage <name>`
to stop at that boundary; necessary earlier checks still run. For example, run
`--stage preflight`, then the same inputs with `--resume --stage deploy`, then
`--resume --stage notify`. Existing `verify`, `deploy`, and `smoke` commands and
their JSON contracts remain available.

Read status without cluster access:

```sh
node codeopsctl.mjs upgrade \
  --operation-dir /private/operator-state/codeops-upgrade --status
```

After interruption, repeat the recommended invocation with `--resume`, the
same files and destination, and the same cluster. Resume reconciles the recorded
next Helm revision and operation description, then checks release identity,
readiness, exact images, preservation, and HTTP policy. It never issues a second
Helm upgrade after recorded intent. If the outcome remains unknown, retain the
logs and reconcile with the release owner. Even an interruption between intent
and Helm requires reconciliation; absence of a revision is not proof that it
is safe to repeat a write. Do not delete the operation directory to bypass this.

An unclean process exit retains the `active` lock. Before an operator removes
that file, they must establish that the recorded PID, its Helm child, and any
other writer have stopped. Then use `--resume`. Do not clear it based on age.
A failed terminal operation is not restarted by resume. Resolve its cause and
obtain any required authority before beginning a new operation.

### Output and delivery

Upgrade emits a bounded `codeops.upgrade/v1` JSON summary with an operation ID.
It makes no model calls and never prompts. Exit codes are:

| Code | Meaning |
| --- | --- |
| 0 | Requested stage completed; a complete upgrade also has an acknowledgement. |
| 2 | Invalid inputs, operation lock, or identity/prerequisite admission blocked. |
| 3 | Known failure; failure event acknowledged. |
| 4 | Effect outcome unknown; reconciliation required. |
| 5 | Terminal event awaits acknowledgement, including deliberate stop after deploy. |

Subprocesses do not stream output. Private logs beneath the durable operation directory record
command status, output byte counts, and bounded startup diagnostics. Raw command
output is fully redacted, including Helm output that can contain Secret values.
Diagnostics retain only known Kubernetes reason codes and Pod UIDs, never
container logs, event messages, or raw workload objects. Inspect the private
`diagnosticPath` directly for interactive diagnosis. A human can add `--stream`
to stream the same redacted diagnostics to stderr; agents should omit it.
There is no raw-stream option. Confirmed configuration/startup failures stop Helm
early; ambiguous image pulls and API outages do not count as confirmed failures.
The command captures diagnostics while Helm runs and retains them on failure.
It leaves failed workloads for explicit forward reconciliation and any later
authorized cleanup.

A successful, acknowledged upgrade removes diagnostic logs and retains operation
receipts and artifacts. Failure, interruption, unknown outcomes, and pending
acknowledgements retain logs. Resume migrates existing legacy temporary diagnostics without deleting originals; if legacy logs were removed, it records `diagnosticHistoryMissing` and continues from durable intent and the same notification event, without inventing missing history. Preserve them until reconciliation; private
permissions are not a substitute for redaction.

The configured HTTPS receiver must durably deduplicate `eventId` and return
`{"eventId":"<the received event ID>"}` only after storage. The command sends
`codeops.upgrade-event/v1` with an `Idempotency-Key` header, refuses redirects,
and makes up to three bounded attempts. A lost acknowledgement leaves the same
event pending. Schedule the ordinary invocation with `--resume --stage notify`
in the existing credential-scoped operator runner to retry delivery without
model polling. A pending terminal notification does not require cluster access.
A success HTTP status alone is not an acknowledgement. URLs must
contain no credential, query, or fragment. This command does not install a
notification service or background worker.

### Isolated qualification

Run the focused source regressions with
`node --test infra/scripts/test-codeopsctl.mjs`, then `nub run check:chart` and
`nub run verify` in the established credential-free isolated runner and hosted
CI. Existing release workflows retain the same gates and package this CLI file;
no additional release asset or dependency is required.

Before production use, qualify the real Helm path in disposable infrastructure
with production-shaped values, synthetic credentials, and no production network
access. Exercise missing Secret keys, execution-namespace RBAC denial, wrong
network policy, startup configuration failure, interruption immediately before
and after Helm, and acknowledgement loss. Assert exact tested/deployed digests,
no duplicate Helm revision on resume, failure-log retention, and success cleanup.
The published golden report proves the existing released-image lane; it does not
claim to test the consumer's production-specific configuration.
