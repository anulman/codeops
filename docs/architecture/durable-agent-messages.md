# Durable agent questions and supervisor replies

A live worker can send a non-blocking FYI, question, decision, or structured
friction report to an explicitly configured supervisor. The worker receives a
correlated reply through its scoped inbox or at its next authorized prompt
boundary. Messages do not grant execution authority. They do not start work,
resume a Session, change a hold, select a model, or consume a permission decision.

## Boundaries and persistence

`messages.send`, `messages.inbox`, and `messages.acknowledge` use the existing
loopback work-item MCP broker and claimed runtime HTTP transport. Neither bearer
credentials nor claim tokens enter tool arguments. The gateway reuses
`loadClaimedDispatchAuthority`, requires a bound runtime profile and claim count,
and checks the current Session generation and lease. The immutable message
records the original dispatch, claim count, source SHA, and a digest of the exact
claim, dispatch, model policy, and runtime binding. Replay never rewrites that
provenance. A new valid claim may read the existing receipt only when the
request, Session generation, lease, source, policy, profile, and route still match.

The `agent-messages-v1` migration adds one scoped message table which also serves
as the delivery outbox, and one supervisor-owned friction-register projection.
A transaction persists a message and emits a PostgreSQL notification. The
notification is only a wake hint. Startup recovery reads the durable outbox;
notifications are not proof of delivery. This uses the existing application
PostgreSQL connection and notification retry policy. Organization-wide Web Push
subscriptions cannot carry scoped message content, so this feature does not fan
messages out through that channel.

A message ID is derived from Session, generation, authenticated sender, and
idempotency key. Different bytes under the same key refuse. A thread has one
origin message and at most one reply, enforced by a unique database constraint.
The database retains immutable content and monotonic delivery, acknowledgment,
and answer timestamps. Acknowledging a question does not answer it or remove it
from the supervisor's unanswered inbox. No reset, adoption, historical repair,
or automatic deletion path is added.

The worker inbox retains replies until explicit acknowledgment. Prompt injection
is bounded to 20 replies for the exact Session generation and lease. A failed
optional inbox read does not block ordinary model work. Received messages are
text data with durable IDs, never commands or permission decisions. A crash
before acknowledgment may repeat the same message ID; it cannot create another
reply or execute a new prompt. A reply to an old generation remains retained and
cannot enter its replacement generation. Blocking waits remain out of scope.

## Supervisor configuration and OpenClaw contract

The optional `CODEOPS_SUPERVISOR_ROUTES_FILE` names a trusted JSON array of routes.
An empty array leaves delivery disabled. Each route contains:

- `id` and `version`: immutable logical routing identities.
- `repository`, `projectId`, and `ownerPrincipalId`: the admitted scope.
- `supervisorPrincipalId`: the explicitly configured supervisor identity.
- `token`: a dedicated messaging credential, distinct from gateway credentials.
- `openClawUrl`: the HTTPS endpoint for the dedicated messaging extension.
- `sessions`: optional exact `{sessionId, workItemId}` bindings for Sessions
  without a durable work-item admission. Existing admissions take precedence.

Changing the route version or supervisor identity does not adopt queued work.
A Session's immutable work-item identity must agree when present. A repository
with multiple projects does not permit cross-project messaging: the project
must match the durable admission or the exact configured Session binding.
Configuration changes and credential installation are separate human-gated work.

`POST /v1/supervisor/messages` authenticates the route before reading input. It
supports `inbox`, `reply`, and `acknowledge`. The model does not select a sender,
credential, project grant, or arbitrary recipient. Each operation rechecks the
stored recipient and current Session. A question or decision accepts one reply.
A friction report requires explicit validation and acknowledgment before reply.

`openclaw-supervisor-adapter.ts` listens for database events, recovers on startup,
and retries at persisted due times. It sends at most four entries per drain with
a ten-second request deadline and the existing eight-attempt notification
policy. It checks the exact message and route receipt before recording delivery.
Stale or exhausted entries remain stored. No transcript polling is used.

`createOpenClawMessageExtension` supplies the receiving handler and scoped
`messages.inbox`, `messages.reply`, and `messages.acknowledge` tools. The host must
bind `operate` to the authenticated gateway endpoint, register those tools only
in this supervisor lane, and implement `OpenClawDurableMessageRuntime.enqueueOnce`.
That method must persist the exact key and payload before returning, reuse its
stored result on replay, and retain ambiguous in-flight work. The extension
selects a deterministic message session key and a four-turn, 60-second limit.
It exposes no execution, Plane-mutation, Telegram, or heartbeat tools.

This is an explicit adapter contract, not a claim that an unmodified OpenClaw
webhook already supplies durable enqueue. A plain `/hooks/wake`, `/hooks/agent`,
Telegram callback, or in-memory queue does not satisfy it. Wiring and verifying
the host's durable enqueue implementation is required before enabling a route.
No host installation or configuration is part of this source candidate.

## Structured friction reports

A report carries a UUID and idempotency key, failure class, exact candidate,
expected and observed behavior, evidence links, impact, suspected or verified
cause, workaround limits and removal criterion, and a proposed fix work-item ID.
The authenticated envelope supplies repository, project, work item, Session,
generation, dispatch, and source identity. A proposed association is data for
supervisor review, not an unrestricted project-system mutation.

The candidate is either the canonical SHA-256 digest of
`{repository, sourceSha}` for the exact admitted base, or a finalized checkpoint
descriptor digest for the same Session generation and source. Arbitrary candidate
claims and unfinalized checkpoint proof refuse.

Initial evidence is supervisor-mediated: links must name byte-verified context
attachments already admitted with the prompt, using
`codeops-context://sha256/<digest>/<name>`. Each attachment must be bounded JSON:

```json
{
  "version": "codeops.friction-evidence/v1",
  "scope": {
    "repository": "example/service",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "workItemId": "22222222-2222-4222-8222-222222222222"
  },
  "sessionId": "session-example",
  "generation": 1,
  "candidate": "sha256:<exact-candidate-digest>",
  "sanitized": true,
  "observation": "Bounded sanitized observation"
}
```

A verified cause also requires matching `verifiedCause` in that trusted evidence.
The gateway verifies bytes and scope rather than fetching caller-selected URLs.
It rejects known credential forms and unsafe controls in report prose and linked
content. This filter is not a general secret detector: the trusted supervisor
must review evidence sanitization before admission and report acceptance. The
current submission boundary deliberately refuses unadmitted new evidence links.

Acknowledgment projects each report once into `agent_friction_register`, keyed
by repository, project, and failure class. Different reports in one failure
class retain their identities and increment the open entry; retries do not.
The register is shared durable supervisor state, not a Plane mutation. No report
or reply can close a friction entry automatically.

## Qualification still required

No tests, builds, installers, database commands, or live provider calls were run
in the implementation Session. Authored tests use local transaction and durable
queue doubles; they do not establish a real restart or PostgreSQL locking proof.

After collection, trusted isolated qualification must check contract/service
compilation, the focused message and runtime tests, the existing migration and
notification regression tests, and the complete repository gates under their
separate authorization. Required acceptance evidence remains a real worker
question/report, one scoped supervisor event, correlated reply after restart,
and duplicate, reorder, stale-recipient, cross-project, forged-evidence, and
secret-bearing refusals. The OpenClaw durable enqueue implementation and route
wiring must be verified before claiming that evidence. Human merge, release,
and deployment gates remain separate.
