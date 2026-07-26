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

The only automated research trigger is a new human-authored comment containing
one or more registered persona mentions delivered through a signature-verified
Plane webhook. The v2 registry is `@ai-web`, `@ai-security`, `@ai-database`,
`@ai-infra`, `@ai-design`, `@ai-product`, and `@ai-ml`. Text after the mentions
is the bounded round brief; a mention-only comment uses the bound ticket title
and description. Ordinary comments, edited comments, deleted comments,
unregistered `@ai-*` text, and service-authored comments are context only and
must not start a run.

`qaContractResearcherPolicy` and the research mutation schemas enforce a
content-only capability envelope. The researcher may propose or apply comments,
labels, project/ticket edits, and same-project ticket creation. Cancellation is
represented only as `ticket.cancel-proposal`; lifecycle state changes, ticket
deletion, and project deletion are not representable.

The trusted controller must additionally resolve every referenced ticket and
prove it belongs to the request's project before applying a mutation. It must
snapshot the exact Plane revision and repository SHA at admission and preserve
the triggering actor/comment IDs. The researcher receives no Plane credential.

A research packet contains exactly one terminal perspective for every requested
persona, including an explicit `no-additional-findings` outcome when
appropriate, plus the synthesized current and expected behavior,
fixture/evidence references when available, blocking decisions, and proposed
mutations. A canonical video is strongly encouraged for user-visible behavior,
but its absence does not by itself invalidate a packet. Video is human
evidence, not the acceptance oracle.

`readinessGateSchema` keeps one Plane `Ready` state while compiling a
ticket-specific set of criteria under `qa-ticket-readiness/v1`. Each criterion
records:

- whether it is required or recommended;
- whether it applies to this ticket;
- whether it is satisfied, missing, or not applicable;
- why it was classified that way and any supporting evidence.

Ready is derived mechanically: there must be no unresolved product decision and
no missing criterion that is both applicable and required. Missing recommended
evidence never blocks Ready. Reproduction steps, fixtures, cleanup plans, and
videos become required only when the ticket's behavior, controlled state, side
effects, risk, or explicit human request makes them necessary. The research
persona must not invent evidence, silently waive required criteria, or require
an artifact merely because its profile can sometimes use one.

Run the boundary suite with:

```sh
nub run --filter @renoconcierge/codeops-contracts test
nub run --filter @renoconcierge/codeops-contracts typecheck
nub run --filter @renoconcierge/codeops-contracts build
```
