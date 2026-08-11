# Product

CodeOps lets a team run durable coding-agent sessions for multiple repositories
from one Kubernetes control plane. Operators can inspect sessions, provide
input, and keep repository credentials outside untrusted runtime containers.

The first-release success criteria are:

- Install from immutable registry artifacts.
- Admit only configured repositories and authority.
- Persist session and lifecycle state across restarts.
- Keep every runtime effect attributable and recoverable.
- Support managed and external infrastructure without changing repository
  identity.
