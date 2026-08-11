# CodeOps

CodeOps is a Kubernetes control plane for durable coding-agent sessions. One
control plane is designed to manage multiple allowlisted repositories.

This repository is in a private extraction phase. The current source comes
from the reviewed CodeOps stack. Do not treat the chart or
configuration as a stable public API until the portability and
multi-repository acceptance suites pass.

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
[`docs/architecture/lifecycle-kernel-and-event-delivery.md`](docs/architecture/lifecycle-kernel-and-event-delivery.md).

The Helm package deploys the Agents UI, session control gateway, trusted
control gateway, Plane controller, Temporal orchestrator, model proxy, and
PostgreSQL. It provides immutable image references for the Agent Job, session
gateway sidecar, and session runtime worker. Temporal remains an external
dependency and must be configured with an exact `host:port` address.

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

Start from `infra/charts/codeops/examples/quickstart-values.yaml`. See the
chart README for prerequisites, required external values, webhook endpoints,
credential storage, and the advanced existing-Secret mode.

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
artifacts.

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
