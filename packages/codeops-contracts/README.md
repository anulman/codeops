# CodeOps contracts

This package is the versioned trust boundary shared by CodeOps workflow,
control, runtime, and projection services. It contains data contracts only; it
does not connect to Temporal, Kubernetes, Plane, Telegram, GitHub, or secret
providers.

## Rules

- Parse untrusted input with the exported Zod schemas before use.
- Treat contract-version changes as compatibility changes.
- Carry secret references, never secret values.
- Keep transcripts and workspace contents in evidence storage, not events or
  commands.
- Use `createTransitionId` and `createEventId` for retry/replay-safe logical
  identity. Do not substitute random IDs for durable transitions.
- Evidence references must use bounded, credential-free `https:`, `s3:`, or
  local `artifact:` URIs and include a SHA-256 digest.

Run the boundary suite with:

```sh
nub run --filter @renoconcierge/codeops-contracts test
nub run --filter @renoconcierge/codeops-contracts typecheck
nub run --filter @renoconcierge/codeops-contracts build
```
