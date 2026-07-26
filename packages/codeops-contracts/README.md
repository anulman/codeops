# CodeOps contracts

This package is the versioned trust boundary shared by CodeOps workflow,
control, runtime, and projection services. It contains data contracts only; it
does not connect to Temporal, Kubernetes, Plane, Telegram, GitHub, or secret
providers.

## Rules

- Parse untrusted input with the exported Zod schemas before use.
- Treat contract-version changes as compatibility changes.
- Carry secret references, never secret values.
- Redact and classify free-text fields at ingress. Structural schemas reject
  secret-bearing fields, but cannot prove that arbitrary human text contains no
  pasted credential.
- Keep transcripts and workspace contents in evidence storage, not events or
  commands.
- Use `createTransitionId` and `createEventId` for retry/replay-safe logical
  identity. Do not substitute random IDs for durable transitions.
- Evidence references must use bounded, credential-free `https:`, `s3:`, or
  local `artifact:` URIs and include a SHA-256 digest.

## QA Contract Researcher

The only automated research trigger is an exact, human-authored `/research`
comment delivered through a signature-verified Plane webhook. Ordinary
comments, edited comments, deleted comments, and service-authored comments are
context only and must not start a run.

`qaContractResearcherPolicy` and the research mutation schemas enforce a
content-only capability envelope. The researcher may propose or apply comments,
labels, project/ticket edits, and same-project ticket creation. Cancellation is
represented only as `ticket.cancel-proposal`; lifecycle state changes, ticket
deletion, and project deletion are not representable.

The trusted controller must additionally resolve every referenced ticket and
prove it belongs to the request's project before applying a mutation. It must
snapshot the exact Plane revision and repository SHA at admission and preserve
the triggering actor/comment IDs. The researcher receives no Plane credential.

A research packet contains current and expected behavior, fixture/evidence
references, blocking decisions, and proposed mutations. It must include one
canonical video or explain why video is not applicable. Video is human evidence,
not the acceptance oracle.

`readinessGateSchema` keeps one Plane `Ready` state while compiling different
requirements for research, implementation, and qualification work:

- research requires an exact question, authoritative sources, required outputs,
  bounded read/record capabilities, stop conditions, and a product-decision
  escalation rule;
- implementation requires current-behavior evidence, a fixture manifest,
  expected-flow and oracle contracts, cleanup, and zero unresolved product
  decisions;
- qualification requires exact candidate and coverage manifests, an independent
  evaluator identity, retention and cleanup plans, and zero unresolved product
  decisions.

Run the boundary suite with:

```sh
nub run --filter @renoconcierge/codeops-contracts test
nub run --filter @renoconcierge/codeops-contracts typecheck
nub run --filter @renoconcierge/codeops-contracts build
```
