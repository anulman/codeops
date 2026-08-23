# CodeOps

CodeOps is an open-source Kubernetes control plane for durable coding-agent
sessions. One control plane is designed to manage multiple allowlisted
repositories.

The project is in alpha. Version 0 releases are public development releases.
The chart and configuration can change before version 1.0. The portability,
multi-repository, browser, image, registry-install, and deterministic golden
acceptance suites qualify each published release.

## Components

- `packages/codeops-contracts`: shared session and workflow contracts
- `sites/agents-ui`: operator UI
- `services/codeops-acceptance-runner`: portable browser acceptance runner
- `services/codeops-plane-controller`: work-item and GitHub controller
- `services/codeops-control-gateway`: trusted session control gateway
- optional S3 proof publisher: isolated publication process in the control-gateway image
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

See [Web Push notifications](docs/operations/web-push.md) to enable background
session notifications, including installed Home Screen app support on iOS.
See [S3 proof publisher](docs/operations/proof-publisher.md) to publish
sanitized reviewer videos and packet indexes through an isolated
S3-compatible credential boundary.

## System requirements

CodeOps requires a working Kubernetes cluster, Helm, `kubectl`, dynamic
persistent-volume provisioning, and an ingress controller. The release gate
uses Kubernetes 1.36.1, Helm 3.19.2, and `kubectl` 1.36.1.

Use these capacity baselines before an installation:

- The default `full-managed` profile requires at least 2.5 available vCPUs,
  8 GiB of available memory, and 40 GiB of free persistent-storage capacity.
  Use a node with at least 16 GiB total RAM so the operating system,
  Kubernetes, and workload spikes do not consume the required 8 GiB.
- [Managed Plane](https://developers.plane.so/self-hosting/methods/docker-compose)
  alone requires at least 2 vCPUs and 4 GB RAM. Plane recommends 8 GB RAM. The
  `full-managed` CodeOps profile also runs PostgreSQL, Temporal, JetStream, and
  the CodeOps services, so Plane's minimum is not sufficient for the complete
  profile.
- If the cluster cannot meet the `full-managed` baseline, use external Plane,
  PostgreSQL, Temporal, or JetStream services and set the matching deployment
  modes in the values file.
- Each active coding-agent session can request 1 GiB and use up to 6 GiB of
  additional memory. Add session capacity above the control-plane baseline.

Run `nub run doctor -- --cluster` before installation. The doctor rejects a
cluster that does not have the required current capacity or Kubernetes
configuration.

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

Run the released Agents UI acceptance runner after a deployment. Pin the
runner image from the same `release-manifest.json` as the chart. The consumer
owns the target URL and the time at which it creates the ephemeral Job. The
consumer also owns any Ingress, TLS, and edge authentication. Do not copy the
browser test into the consumer repository. See the
[acceptance runner operation](docs/operations/acceptance-runner.md).

To evaluate the source without a cluster, Plane, or persona accounts, run:

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
Release-contract changes run it in validation-only mode. Publication requires
an immutable `v<SemVer>` tag at the current `main` source SHA or an explicit
manual dispatch from `main` with one exact SemVer version and `publish=true`.
A publishing run builds all ten images from one source SHA, resolves
their registry digests, embeds those digests and the source SHA into the
packaged values, publishes the Helm chart to
`oci://ghcr.io/anulman/codeops/charts/codeops`, and retains the exact image,
chart, source, and release-values evidence. After the registry-only install
proof passes, the workflow creates an immutable public release in GitHub
Releases with the chart archive, image plan, release manifest, release values,
golden release report, and checksums. The golden release report binds the
11-scenario source proof to anonymous registry access, the exact deployed chart
and images, rollback, smoke, and cleanup evidence. It does not claim that the
source scenarios ran inside the live services. GHCR remains the canonical Helm
registry. GitHub Releases is the durable human-facing release record. Ordinary
branch pushes and CI runs do not
publish artifacts. Each release also retains an SPDX SBOM and a license-policy
report for every published CodeOps image.

## License

Copyright (c) 2026 Aidan Nulman.

CodeOps-authored source is licensed under
[Apache-2.0](LICENSE). You may use, modify, and distribute CodeOps, including
as part of proprietary software, under that license.

CodeOps comes without warranty, to the extent permitted by law.

The Helm archive is a multi-license aggregate. Bundled NATS, Temporal, and
Plane chart code remains under its upstream license. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the license files packaged
inside the chart. Release SBOMs provide the exact image-package inventory.

Contributions use the same Apache-2.0 license without a separate CLA. Code and
package dependencies must use an approved permissive license. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE_POLICY.md](LICENSE_POLICY.md).

## Safety boundary

Repository-controlled runtime containers do not receive reusable OpenAI or
GitHub credentials. The trusted control plane binds every runtime action to an
exact repository, base commit, session, generation, and lease. Keep these
properties fail closed when you change the package or chart.

Interactive GitHub writes require one operation-specific durable allow-once
decision. The session gateway consumes that decision before it calls the
credential-owning control gateway. The control gateway then performs exact
head preflight and postflight identity checks. Only pull-request branch
updates, bounded pull-request title/body/base updates, review-thread replies,
and check reruns are available. Merge, close, release, deployment, deletion,
and generic API operations are not available.

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

The Temporal WorkItem workflow and the interactive Session Broker currently
use two execution adapters. Temporal dispatches a bounded Agent Job. The
Session Broker dispatches the session runtime worker. Both adapters use the
same repository registry, immutable images, model proxy, and cluster policy,
but they do not yet share one resource builder. Treat this split as alpha
architecture. Do not add a third execution adapter.
