# Lifecycle kernel and event delivery

Status: Accepted on 2026-08-11.

## Decision

CodeOps owns one portable lifecycle model. Provider adapters translate native
provider facts and states into this model. Provider configuration does not
define lifecycle behavior.

PostgreSQL stores the authoritative WorkItem aggregate and its immutable
canonical lifecycle event in one transaction. A relay claims unpublished
events through one lease and publishes them through one delivery driver. The
relay records publication only after the driver acknowledgment. JetStream is
the default delivery driver. Its durable consumers isolate Plane,
notification, and installer-owned projectors.

Do not create PostgreSQL delivery state for each external consumer. Keep the
immutable event journal separate from transient relay state. Store one
transport-neutral publication receipt with the delivery driver, destination,
position, receipt digest, receipt JSON, and publication time. Do not add
JetStream-specific columns to the lifecycle journal.

The relay publishes canonical event bytes to the stable
`codeops.lifecycle.v1.events` route. A delivery driver maps that route to its
native subject, topic, or stream binding.

## Dependency ownership and supported profiles

The user-facing `codeops` chart renders CodeOps resources directly and embeds
default-on Temporal, NATS, and Plane dependency charts. Each capability
selects a driver. Each selected driver uses a `managed` or `external`
deployment mode. The chart renders no dependency resources in `external`
mode.

- PostgreSQL is required in v1. Support `managed` and `external` deployment.
- Temporal is the default orchestration driver. Support `managed`, `external`,
  and `none`. The `none` driver creates a session-only installation and
  disables automated WorkItem workflows.
- JetStream is the default delivery driver. Support `managed`, `external`, and
  `none`. The `none` driver creates a journal-only installation and disables
  outbound projectors.
- Plane is the only work-tracker adapter in the first release. Support
  `managed`, `external`, and disabled operation. Disabling Plane does not
  change lifecycle behavior.

Qualify two named profiles before accepting additional permutations:

- `full-managed`
- `full-external`

Reject incompatible values at render time. Require a capability handshake
before a workload becomes Ready. An alternative delivery or orchestration
component must implement the applicable versioned driver contract. Do not
treat an arbitrary endpoint as a compatible replacement.

Kafka and GitHub Projects or GitHub Issues work-tracker adapters are outside
the first-release boundary. GitHub repository, pull-request, webhook, and
session authority remain supported and are not work-tracker adapters.

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

`provider adapter -> external fact -> provider binding -> canonical command -> lifecycle kernel -> PostgreSQL transaction -> delivery relay -> projector`

- Adapters translate provider shape.
- Bindings map provider identity to canonical identity.
- The lifecycle kernel validates legal transitions, actor capability,
  repository authority, expected revision, evidence, and idempotency.
- PostgreSQL commits authoritative state and the immutable event.
- The selected delivery driver distributes committed events. JetStream is the
  default driver.
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
- Do not couple dependency ownership to capability behavior. `external` means
  that the installer owns deployment. `none` disables the capability.
