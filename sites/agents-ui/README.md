# Agent Sessions UI

Internal TanStack Start command center for live and archived RenoConcierge
CodeOps sessions.

The fleet and cockpit are currently backed by contract-shaped fixtures while
the durable broker adapter is implemented. The cockpit always renders the
complete action set on desktop and mobile. Availability comes only from the
broker capability snapshot; unavailable actions stay visible, and the browser
never simulates completion.

The shared wire boundary lives at
`@renoconcierge/codeops-contracts/session-broker`. Mutations must carry the
exact session generation, durable lease ID, and an idempotency key, then render
the broker's committed command result.

Run focused checks from the repository root:

```sh
nub run --filter @renoconcierge/codeops-contracts test
nub run --filter @renoconcierge/agents-ui test
nub run --filter @renoconcierge/agents-ui typecheck
nub run --filter @renoconcierge/agents-ui build
```
