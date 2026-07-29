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
- Every research and coding request carries `codeops.project-context/v1`: the
  exact Plane project identity and description, control-plane SHA, target-base
  SHA, and a path-sorted SHA-256 manifest plus trusted content for the bounded
  context pack. Missing documents, digest drift, or a request/context identity
  mismatch fail before model execution.
- Every `codeops.coding-request/v2` also carries the immutable admitted ticket snapshot:
  the current work item, bounded non-CodeOps comments, relations, and the
  bounded same-project task index. Referenced decision tickets therefore cross
  the Agent Job boundary as digest-bound input instead of being inferred from
  an unavailable Plane board.
- Every autonomous coding round must retain `codeops.coding-outcome/v1`
  evidence naming at least one exact passing test command. A separate critic
  then returns `codeops.adversarial-review/v1`, bound to that test evidence,
  the workflow/work item/base SHA, and the exact cumulative checkpoint and
  patch URI/digest/size. Its seven independent lenses are ticket completion,
  unused code, simplicity/maintainability, effective use of existing systems,
  test effectiveness, user-facing behavior, and security/privacy.
  The critic must also retain at least one exact independently executed passing
  verification command; a lens summary alone is not test evidence.
  Critical/high findings are always `must-fix`; accepted tradeoffs and
  non-actionable findings require justification; a passing verdict is
  impossible while any must-fix finding remains.

## Adversarial coding review

The coding Agent Job cannot write its own adversarial-review report. Temporal
automatically dispatches a distinct isolated `critic-agent` after every
retained coding checkpoint. The gateway mounts the exact prior cumulative
patch from durable evidence by a read-only file `subPath`, verifies its digest
and size before applying it to the exact base, and rejects the critic if its
final cumulative patch differs by one byte. The critic receives the immutable
ticket, human comments/decisions, relations, bounded same-project task index,
trusted project/product documents, structured passing test evidence, and exact
candidate identity. It has no Plane, GitHub, merge, deployment, acceptance, or
Kubernetes authority.

The workflow introduces this branch behind Temporal patch ID
`coding-autonomous-critic-v1`. Existing histories without that marker replay
the former evidence-to-acceptance path; new coding executions record the
marker before their first dispatch and must converge through the autonomous
critic loop before acceptance.

A `revision-required` report automatically dispatches a fresh coding Agent Job
with the rejected cumulative patch and exact structured findings already
applied as immutable input. That job must resolve every must-fix item, rerun
focused tests, and retain a new cumulative checkpoint before the next critic
round. The loop allows at most four coding rounds and otherwise fails closed.
A pass advances to the separate independent human acceptance wait;
adversarial review does not replace executable acceptance. Non-blocking
fast-follow recommendations are retained structurally but carry
`planeMutationAuthorized: false`; ticket-required gaps and concrete
security/privacy regressions can never be fast follows.

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

The packet also binds the project-context digest. The trusted controller
persists the successfully projected packet by work-item identity. A later
coding request records research as `required`, `optional`, or `skipped`.
Required research must include an exact compatible packet; optional research
may attach one; skipped research must not. Missing or stale research does not
block a bounded Ready ticket unless the disposition is explicitly required.

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
