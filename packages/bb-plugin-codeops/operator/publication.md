# Trusted publication boundary

Status: implementation under qualification. No service, endpoint, credential,
plugin, worker, Kubernetes permission or production resource was activated.

The native BB server validates the exact run checks and advisory review. An
operator separately admits a time-bounded publication permit. Its identity binds
repository, base, candidate commit/tree, run, generation, lease, owner, scope and
check evidence. The permit specifies one branch, PR title/body and evidence links.
Neither model output nor a provider observation can create that permit.

Run `operator/publisher-host.ts` only on a trusted publisher host. Its operating
account, config, environment, database, Unix socket and bare Git object stores
must be inaccessible to repository-controlled worker, reviewer and validator
processes. A separate process on their shared account/filesystem is insufficient.
The BB server can access the private socket; workers cannot. An isolated fixture
must prove these boundaries before deployment. Do not copy worker GitHub auth,
provider auth or personal directories into the publisher or its fixtures.

The publisher reads the canonical BB CodeOps SQLite database through a read-only
connection before each effect. A request's identity is not that authority. The
live run must still be running, retain the exact generation/lease/candidate and
have matching checks/review. Pause, cancellation, generation replacement, changed
evidence or unavailable authority storage stops subsequent effects. A request
already sent to GitHub can still complete; revocation is not a rollback. Preserve
its intent and recover by remote readback.

## Configuration and commands

The private config and containing directories must belong to the publisher account
and deny group/other access. Populate these keys through an operator-owned process:

```json
{
  "socket": "/private/codeops/publisher.sock",
  "database": "/private/codeops/publisher.sqlite",
  "authorityDatabase": "/private/codeops-authority/codeops.sqlite",
  "repositories": [{
    "name": "example/repository",
    "directory": "/private/codeops/objects/repository.git",
    "credentialVariable": "CODEOPS_GITHUB_EXAMPLE_TOKEN"
  }],
  "webhookSecretVariable": "CODEOPS_WEBHOOK_SECRET",
  "ownActorIds": [123]
}
```

The named repository credential exists only in the trusted publisher environment.
Git and gh children receive only the selected repository credential, a fixed
GitHub host, a limited environment and no personal auth/config directory. Bare
stores must be operator-created, retain no
repository-controlled config, hooks or alternate object paths. The native host exports a bounded Git bundle against the exact admitted base.
The publisher verifies its digest and advertised head, imports objects without
credentials or checkout, and checks the candidate tree and ancestry. Only its
separate fetch of the admitted base and publication calls receive the selected
repository credential. Never mount a worker checkout here. Deployment authority
is a prerequisite, not granted by this plugin. No candidate-image automation is included.

With Node 24, `flock`, Git, gh and the package dependencies present:

```sh
node --experimental-transform-types operator/publisher-host.ts /private/codeops/config.json
```

The launcher holds an OS flock across the entire process. Only its holder removes
a stale socket on restart. Do not invoke the internal `--locked` entry directly.
The private socket accepts JSON POST requests. Operator clients can use
`publisherRequest` from `core/publication-client.ts`; `/admit` takes the exact
`publicationPermit` schema and `/revoke` takes `{ "id": "permit-uuid" }`.
These commands are not agent tools. Admit no permit based solely on a comment.

Set `CODEOPS_PUBLICATION_SOCKET` on the trusted BB server, after separate activation
authority. `bb codeops command` supports these requests:

```json
{"op":"publish","id":"run-id","revision":10,"permitId":"permit-uuid"}
{"op":"milestones","id":"run-id"}
{"op":"reviews","id":"run-id"}
```

Publication creates a Draft PR. Ready, merge, release and deployment remain manual.
A new exact candidate for the same PR requires a new permit with `supersedes`
pointing to the verified prior permit and `previousHead` equal to its exact head.
The publisher checks PR ownership before pushing and uses an exact Git ref lease.
It allows only descendant updates; no unrelated history replacement is admitted.

## Recovery and observation

The database records intent before each mutation. Lost push responses recover
from exact remote-head readback. Lost PR creation responses recover only when the
unique exact owned PR is visible. An empty list after an uncertain create is not
proof that no PR exists. The publisher retains its uncertain create intent and will not retry
creation automatically. Operator recovery requires provider-side investigation;
if absence cannot be established, keep the permit blocked and retain its journal.
Do not erase the journal, change its phase, or reuse the branch to force a retry.
Use `{"op":"abandon-publication","id":"run-id","revision":10}` only after
investigating the possible prior effect. This operator command durably revokes the
recorded permit, retains its identity/history in the run, and then releases the
attempt for replacement. A lost revocation response leaves the attempt unresolved;
retry is idempotent. Revocation tombstones also prevent later admission of an
unknown permit ID. No branch or PR is deleted. Normal retry first performs live
read-only recovery, so a lost successful response can recover without the original
workspace or another bundle export.

An operator may then admit a new, separately reviewed branch
with a fresh permit after accounting for the old potential effect. The old branch
and journal remain retained; no deletion or silent replacement is performed.

Checks, merge, release and deployment reads carry `authority: false`. Each category
reports unavailable reads as `unknown`; the client reports old observations as
`stale`. Check success does not establish required-check policy or permission.
Release tags are resolved to immutable commits; mutable target names are not proof.
Incomplete inventories and exhausted read budgets produce unknown observations.

An existing trusted webhook receiver can forward exact raw UTF-8 body, GitHub
signature, event type and delivery ID through `/review`. No public endpoint is
installed here. The receiver must preserve signed bytes. The adapter verifies the
signature, deduplicates delivery identity, re-reads the PR/comment, ignores own
echoes and routes only to the recorded owner. Unsupported/deleted objects do not
become instructions. Review text is bounded, untrusted evidence. The `reviews`
command exposes its exact link and binding. Notification acknowledgements retain
monotonic owner revisions, so an old acknowledgement cannot hide a newer event.

## Qualification still required

Use a disposable, credential-free runner for all repository-controlled tests.
Unit/synthetic transport tests do not prove the actual GitHub or host boundary.
Qualify real Git/gh publication with a separate approved disposable repository and
repository-scoped fixture credential confined to the publisher container. Never
reuse this implementation worker's gh credential inside tests. The supervisor must
supply the fixture repository/credential boundary; no production authority is implied.
Exercise response loss after push/create/update, process restart, overlapping
requests, revoked leases during a blocked provider call, ownership drift,
duplicate PRs, stale heads and failed cleanup while retaining evidence.
The model/reviewer/validator containers must demonstrably lack socket, environment,
object-store, auth-file and network access to the publication authority.

Run focused tests, native build/type checks, complete `nub run verify`, license
checks, manual full-diff review and hosted CI before Ready. Retain exact source,
image, dependency and isolation identities with the real integration receipts.
