# Consumer deployment

Use `codeopsctl` when a repository owns its CodeOps installation. The CLI is
the primary operator interface. The reusable GitHub Action is a thin wrapper
around the same file.

Each CodeOps GitHub Release contains:

- `codeopsctl.mjs`;
- `codeops-consumer-lock.json`;
- `release-manifest.json`;
- the OCI chart archive and `SHA256SUMS`.

Commit the release's `codeops-consumer-lock.json` to the consumer repository.
Commit the non-secret Helm values and one policy file. Do not commit a
credential value.

The policy uses schema `codeops.consumer-policy/v1`:

```json
{
  "schemaVersion": "codeops.consumer-policy/v1",
  "requiredSecrets": ["codeops-postgres", "codeops-access"],
  "cluster": {
    "kubernetesServiceCidrs": ["10.43.0.1/32"],
    "readyNodeSelector": "example.com/codeops=true"
  },
  "postDeployHttpChecks": [
    { "url": "https://plane.example.com", "acceptedStatuses": [200] }
  ]
}
```

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

The deploy command verifies public release artifacts, checks environment
policy, snapshots release PVC and external Secret identities, runs one atomic
Helm upgrade, checks readiness, rejects image drift, and emits
`codeops.consumer-evidence/v1` JSON. It does not test a consumer's public
authentication path or provider-specific product behavior.

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
