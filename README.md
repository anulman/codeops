# CodeOps

CodeOps is an open-source Kubernetes control plane for durable coding-agent
sessions. One control plane is designed to manage multiple allowlisted
repositories.

The project is in alpha. The chart and configuration can change before the
first stable release. The portability, multi-repository, browser, image, and
registry-install acceptance suites qualify each published release.

## Components

- `packages/codeops-contracts`: shared session and workflow contracts
- `sites/agents-ui`: operator UI
- `services/codeops-acceptance-runner`: portable browser acceptance runner
- `services/codeops-plane-controller`: work-item and GitHub controller
- `services/codeops-control-gateway`: trusted session control gateway
- `services/codeops-session-runtime-worker`: ACP runtime transport
- `services/codeops-agent`: isolated coding-agent image
- `services/codeops-model-proxy`: trusted OpenAI credential boundary
- `services/codeops-orchestrator`: Temporal workflow worker
- `infra/charts/codeops`: CodeOps Helm chart

The accepted lifecycle-kernel and event-delivery boundary is documented in
the [architecture index](docs/architecture/README.md). An unaffiliated agent
should start with [`AGENTS.md`](AGENTS.md) and the
[agent quickstart](docs/agent-quickstart.md).

The Helm package deploys the Agents UI, session control gateway, trusted
control gateway, Plane controller, Temporal orchestrator, model proxy, and
PostgreSQL. It provides immutable image references for the Agent Job, session
gateway sidecar, and session runtime worker. The default `full-managed` profile
installs PostgreSQL, Temporal, JetStream, and Plane. Production profiles can
connect to external services or disable optional capabilities.

## Install

The primary onboarding path uses one values file and one Helm install command.
Released OCI charts embed their exact immutable image set. Quickstart mode
creates the internal credentials and least-authority Secret projections for
one repository:

```sh
helm install codeops oci://ghcr.io/anulman/codeops/charts/codeops \
  --version <version> --namespace codeops --create-namespace \
  --values values.yaml
```

Run `nub run doctor`, then generate a private values file with
`nub run init:quickstart -- --input onboarding.json --output values.yaml`.
Start the input from
`infra/charts/codeops/examples/onboarding.example.json`. The generated file is
mode `0600` and contains credentials. Do not commit it. See the
[operator lane](docs/agent-quickstart.md#operate-a-release) for the complete
sequence.

After installation, run the credential-safe cluster smoke command:

```sh
nub run smoke -- --release codeops --namespace codeops
nub run smoke -- --release codeops --namespace codeops --json
```

The command queries only Helm release metadata and the readiness state of
labeled Deployments, StatefulSets, and persistent volume claims. It does not
query Secrets, Pod environment variables, logs, or rendered Helm manifests.
It returns a nonzero status if a required check fails. JSON output uses the
stable `codeops.smoke/v1` schema with `schemaVersion`, `ok`, `release`,
`summary`, and `checks` fields. A managed dependency has a `health.*` check.
An external or disabled dependency has a skipped health check because it has
no managed Kubernetes resource.

To evaluate the source without a cluster, Plane, Cloudflare Access, or persona
accounts, run:

```sh
nub install --frozen-lockfile
nub run evaluate
```

## Local validation

```sh
nub install
nub run verify
nub run acceptance:agents-ui
```

Validate one complete repository authority manifest before you create or
update Kubernetes Secrets:

```sh
nub run build
npm run validate:registry -- /absolute/path/to/registry.json
```

The command reads the manifest and every referenced authority file from one
local snapshot. It performs no Kubernetes effect or network write. It prints
only the manifest digest, exact repository identities, and admitted authority
classes. It never prints credential values or Secret file paths.

## Release boundary

`.github/workflows/release.yml` is the only package publication boundary.
Release-contract changes run it in validation-only mode. An operator must use
manual dispatch, select `main`, enter one exact SemVer version, and set
`publish=true` before it writes to GHCR. A publishing run builds all ten
images from one source SHA, resolves
their registry digests, embeds those digests and the source SHA into the
packaged values, publishes the Helm chart to
`oci://ghcr.io/anulman/codeops/charts/codeops`, and retains the exact image,
chart, source, and release-values evidence. After the registry-only install
proof passes, the workflow creates an immutable prerelease in GitHub Releases
with the chart archive, image plan, release manifest, release values, and
checksums. GHCR remains the canonical Helm registry. GitHub Releases is the
durable human-facing release record. Ordinary pushes and CI runs do not publish
artifacts. Each release also retains an SPDX SBOM and a license-policy report
for every published CodeOps image.

## License

Copyright (c) 2026 Aidan Nulman.

CodeOps-authored source is licensed under
[AGPL-3.0-only](LICENSE). Network operators that modify CodeOps must offer the
Corresponding Source as required by section 13 of the license.

CodeOps is free software. You may redistribute and modify it under the license.
It comes without warranty, to the extent permitted by law. The complete
Corresponding Source is available in this repository.

The Helm archive is a multi-license aggregate. Bundled NATS, Temporal, and
Plane chart code remains under its upstream license. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the license files packaged
inside the chart. Release SBOMs provide the exact image-package inventory.

Contributions use the same AGPL-3.0-only license without a separate CLA. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Safety boundary

Repository-controlled runtime containers do not receive reusable OpenAI or
GitHub credentials. The trusted control plane binds every runtime action to an
exact repository, base commit, session, generation, and lease. Keep these
properties fail closed when you change the package or chart.

The control gateway resolves Agent Job dispatches through a repository
registry before it reads retained evidence or creates Kubernetes resources.
Each admitted repository has a distinct read and write authority. An unknown
repository, a duplicate identity, an identity/URL mismatch, or credential
reuse fails closed. The process entrypoint accepts
`CODEOPS_REPOSITORY_REGISTRY_FILE` as an exact absolute path to a strict
`codeops.repository-registry/v1` JSON manifest. Each entry binds one repository
to exact GitHub URLs and credential file references, one Plane project and
credential pair, lifecycle state IDs, reviewer and human-actor policy, all
seven persona identities, and one project-context root. It rejects inline
credentials, ambiguous paths, duplicate projects, reused Secret files, reused
credential values, and cross-repository identity drift at startup. The legacy
single-repository environment variables remain only as an explicit
compatibility fallback when no registry file is configured.
