# CodeOps

CodeOps is a Kubernetes control plane for durable coding-agent sessions. One
control plane is designed to manage multiple allowlisted repositories.

This repository is in a private extraction phase. The current source comes
from the reviewed RenoConcierge CodeOps stack. Do not treat the chart or
configuration as a stable public API until the portability and
multi-repository acceptance suites pass.

## Components

- `packages/codeops-contracts`: shared session and workflow contracts
- `sites/agents-ui`: operator UI
- `services/codeops-plane-controller`: work-item and GitHub controller
- `services/codeops-control-gateway`: trusted session control gateway
- `services/codeops-session-runtime-worker`: ACP runtime transport
- `services/codeops-agent`: isolated coding-agent image
- `services/codeops-model-proxy`: trusted OpenAI credential boundary
- `services/codeops-orchestrator`: Temporal workflow worker
- `infra/charts/codeops`: CodeOps Helm chart

The Helm package deploys the Agents UI, session control gateway, trusted
control gateway, Plane controller, Temporal orchestrator, model proxy, and
PostgreSQL. It provides immutable image references for the Agent Job, session
gateway sidecar, and session runtime worker. Temporal remains an external
dependency and must be configured with an exact `host:port` address.

## Local validation

```sh
nub install
nub run verify
```

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
