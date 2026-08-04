# Agent Sessions UI

Internal TanStack Start command center for live and archived RenoConcierge
CodeOps sessions.

The fleet and cockpit load strict session snapshots and ordered event pages
through server functions. The server reads its broker token from a mounted
file, validates every upstream response, and never includes that credential in
the browser bundle. Production server functions require Cloudflare Access's
authenticated-user header. The cockpit always renders the complete action set
on desktop and mobile; availability comes only from the broker capability
snapshot, unavailable actions stay visible, and the browser never simulates
completion.

Server configuration:

- `CODEOPS_SESSION_BROKER_URL` — exact internal control-gateway origin.
- `CODEOPS_SESSION_BROKER_READ_TOKEN_FILE` — mounted read-token path.
- `CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE` — mounted write-token path; it
  must be distinct from the read credential.
- `AGENTS_UI_ACCESS_REQUIRED` — optional local override; production always
  requires Access.

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
