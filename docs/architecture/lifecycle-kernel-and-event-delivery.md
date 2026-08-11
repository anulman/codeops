# Lifecycle kernel and event delivery

Status: Accepted on 2026-08-11.

## Decision

CodeOps owns one portable lifecycle model. Provider adapters translate native
provider facts and states into this model. Provider configuration does not
define lifecycle behavior.

PostgreSQL stores the authoritative WorkItem aggregate and its immutable
canonical lifecycle event in one transaction. A relay claims unpublished
events through one lease and publishes them to JetStream. The relay records
publication only after the JetStream publish acknowledgment. JetStream durable
consumers isolate Plane, GitHub, notification, and installer-owned projectors.

Do not create PostgreSQL delivery state for each external consumer. Keep the
immutable event journal separate from transient relay state.

## Lifecycle profile v1

The canonical phases are:

- `Backlog`
- `Ready`
- `InProgress`
- `InReview`
- `Done`
- `Cancelled`

The normal path is `Backlog` to `Ready` to `InProgress` to `InReview` to
`Done`. A policy can make `InReview` optional and allow `InProgress` to
`Done`.

`NeedsAttention` is not a review phase. It is an exception condition on an
active phase. CodeOps retains the resume phase while attention is needed.
Resolving the condition restores the retained phase. A normal review request
or request for changes does not set `NeedsAttention`.

Typed transition policies can require named evidence or approval at defined
transition hooks. A policy returns `allow`, `deny`, or `needs_attention` with
evidence. A policy cannot create states, subscribe to arbitrary facts, or
perform side effects.

## Provider-state bindings

Provider-state bindings are a strict many-to-one function:

`providerStateId -> exactly one CodeOps state`

Many provider states can map to one CodeOps state. One provider state must
never map to two or more CodeOps states. Use immutable provider state IDs when
the provider exposes them.

Each CodeOps state can define:

- a set of accepted provider state IDs for ingress;
- no more than one preferred provider state ID for projection.

The preferred projection state must be in the accepted set. If the provider
already uses an accepted alias for the current CodeOps state, preserve that
alias. Use the preferred target only for a CodeOps-initiated transition or
drift repair.

Reject duplicate provider mappings, ambiguous mappings, multiple preferred
targets, and active transitions that use unmapped provider states.

## Boundaries

The execution path is:

`provider adapter -> external fact -> provider binding -> canonical command -> lifecycle kernel -> PostgreSQL transaction -> JetStream relay -> projector`

- Adapters translate provider shape.
- Bindings map provider identity to canonical identity.
- The lifecycle kernel validates legal transitions, actor capability,
  repository authority, expected revision, evidence, and idempotency.
- PostgreSQL commits authoritative state and the immutable event.
- JetStream distributes committed events.
- Projectors render canonical state in provider-native form.

Keep WorkItem lifecycle events separate from Temporal workflow-run events.
Workflow-run events describe execution. WorkItem lifecycle events define the
portable product contract.

## Rejected alternatives

- Do not use JetStream as the authoritative WorkItem store. It cannot commit a
  stream write atomically with PostgreSQL repository and authority state.
- Do not use one PostgreSQL lease per projector. JetStream durable consumers
  provide independent delivery after publication.
- Do not add a generic rules engine. Use the fixed lifecycle profile and typed
  policy hooks.
- Do not infer outbound provider mappings by reversing an inbound many-to-one
  mapping. Configure one preferred outbound target explicitly.
