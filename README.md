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
- `infra/charts/agents-system`: current extraction-source Helm chart

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
