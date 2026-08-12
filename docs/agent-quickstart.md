# Agent quickstart

## Understand the repository

Read `AGENTS.md`, then read the seven files in `docs/context/`. These files
define current state, product intent, domain terms, accepted decisions, and the
source map.

## Contribute

```sh
git clone https://github.com/anulman/codeops.git
cd codeops
nub install --frozen-lockfile
nub run evaluate
nub run verify
```

Use the test-selection map in `AGENTS.md` while editing. Run browser acceptance
for UI or authentication changes. Do not publish, merge, or deploy without
explicit authority.

## Evaluate locally

`nub run evaluate` builds the shared contracts, runs the service and UI tests,
and renders the supported Helm profiles with fixture authority. It makes no
network write and needs no Kubernetes cluster, Plane installation, Cloudflare
Access application, GitHub token, OpenAI key, or Plane persona account.

This lane proves source behavior. It does not prove a live provider or cluster.

## Operate a release

1. Install Node.js 24, Nub 0.1, Helm 3, and kubectl.
2. Run `nub run doctor -- --cluster`.
3. Copy `infra/charts/codeops/examples/onboarding.example.json` outside the
   repository. Fill its non-secret IDs and paths.
4. Set the required credential environment variables. See the example file.
5. Generate one private values file:

   ```sh
   nub run init:quickstart -- \
     --input /absolute/path/onboarding.json \
     --output /absolute/path/codeops-values.yaml
   ```

6. Validate the exact file without installing:

   ```sh
   helm template codeops oci://ghcr.io/anulman/codeops/charts/codeops \
     --version <version> --namespace codeops \
     --values /absolute/path/codeops-values.yaml >/dev/null
   ```

7. Install the immutable release:

   ```sh
   helm install codeops oci://ghcr.io/anulman/codeops/charts/codeops \
     --version <version> --namespace codeops --create-namespace \
     --values /absolute/path/codeops-values.yaml --wait --timeout 30m
   ```

8. Run `nub run smoke -- --release <release> --namespace <namespace>`.
9. Verify the migration Job.
10. Configure the GitHub and Plane webhooks documented in the chart README.
11. Run one inert work-item lifecycle smoke test before real repository work.

The initializer discovers the GitHub repository, current GitHub user ID, and
Kubernetes API service CIDR when the input omits them and the required local
CLI is authenticated. It never prints credentials or generated Secret values.

The quickstart example selects managed PostgreSQL, Temporal, and JetStream with
an external Plane instance. The default chart profile remains `full-managed`.
Managed Plane uses a two-stage onboarding flow because Plane must create human
and project identities before CodeOps can receive their IDs and API authority.
