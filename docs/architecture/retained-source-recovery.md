# Retained source recovery and exact publication

Recovery finalizes source retained after a worker terminated. It does not
complete the old dispatch, claim runtime success, create a checkpoint, issue an
adoption receipt, or repair Job progress. The original Session, dispatch,
claim, completion, progress (including a null configuration digest), and
checkpoint records remain unchanged. A separate recovery identity records the
source origin and the operator's current authority.

The writable workspace root omission normalization is independent. It restores
only the reviewed omitted `readOnly: false` shape for the `workspace` mount at
`/workspace` in identity-only comparison. The expected digest continues to bind
the complete configuration. Image drift still fails. This fixes future binding
on the updated image; it cannot prove historical candidate provenance.

## Activation prerequisites

1. Qualify the new source in isolation with the focused contract, ownership,
   recovery, and publication tests, then the required full repository gate.
   Obtain independent review of this complete patch.
2. Apply the registered `retained-source-recovery-v1` migration through the
   existing migration owner and refresh the normal application table grants.
   The migration creates only recovery tables and their immutability fences.
   It performs no historical backfill.
3. Build and activate the qualified gateway and contracts together through the
   normal release process. Existing runtime images remain subject to their
   existing exact configuration checks until separately activated.
4. Configure `CODEOPS_RETAINED_SOURCE_PUBLIC_KEY_FILE` with the isolated evidence
   verifier's Ed25519 public key in PEM form. Configure
   `CODEOPS_RETAINED_SOURCE_EVIDENCE_ROOT` with an absolute, service-owned,
   read-only directory. Both settings are required; absence of both disables
   the recovery route. Neither directory components nor evidence files may be
   symlinks. Agents must have no write access to the directory or access to the
   verifier's private key. No signing endpoint is provided.
5. The repository must already be admitted in the gateway registry with its
   repository-scoped GitHub write authority. The operator uses the existing
   Session Broker write token and authenticated principal header. The signed
   authority must match the current owner, Session generation, lease, repository
   and base. The control-plane database remains the trusted service boundary.

These are activation requirements, not actions performed by source preparation.

## Evidence preparation

The isolated verifier collects the exact retained source without running it and
checks repository, base commit, base tree, result tree, paths, full UTF-8 file
contents, and regular-file modes. It must reject symlinks and special files in
the retained collection, including parent directories. It verifies worker
termination and retained-source origin using service-owned evidence. It reuses
accepted qualification and review records only when their exact candidate
identity is unchanged. It must not infer historical runtime success from those
records. A changed candidate requires new qualification and review.

For corrected retained source, recorded correction provenance must establish
the lineage from the original retained collection to the exact corrected
candidate. Its own exact qualification and independent review are also required.
Qualification and review alone do not establish source origin. The verifier
must check this recorded lineage in the service-owned evidence referenced by
the bundle; it must not infer it from matching repository and base alone.

`retained-source-recovery.ts` defines the strict
`codeops.retained-source-evidence/v1` schema. It includes:

- A new `recoveryId` UUID, globally unique `retainedSourceId`, and
  `origin: "retained-source"`.
- `historical`: original Session and dispatch IDs, worker termination evidence,
  whether checkpoint binding failed, and the SHA-256 canonical JSON digest of
  the `readHistory` SQL projection. That projection includes the complete
  Session and dispatch rows, all Job progress rows ordered by generation, and
  checkpoint descriptor rows ordered by checkpoint ID. The verifier must use
  the same PostgreSQL JSON projection, not a timestamp reserialization. For
  root origin, `historical.workspaceLaunchId` is required and the projection
  also contains `workspaceLaunches`, described below. For admitted origin,
  omit that field; the original four-key projection remains unchanged.
- `authority`: current principal, Session, generation, lease and expiration.
  Current and historical workspace identities must admit the exact repository
  and base. The historical origin must be either a dispatch with its real
  work-item admission UUID, or a genuinely persisted root WorkspaceLaunch with
  a null admission. Both retain their actual historical lease. No admission,
  lease, launch record, or historical success is synthesized.
- `candidate` and its canonical JSON SHA-256 `candidateDigest`.
- `sourceManifestDigest`: the original retained source manifest identity. The
  verifier proves that its repository/base/tree/content/mode set equals the new
  candidate serialization. This preserves accepted source identity when the
  transport digest differs from the original manifest digest.
- `checks`: that same digest, accepted focused/full qualification and review,
  the original `sourceManifestDigest`, qualification and review evidence IDs,
  and reviewer identity. Both digests must match the source fields.
- `publication`: exact base and target branch, commit message, PR title, body,
  and draft flag. `draft: false` is supported only with the accepted signed
  checks required by this operation.

The envelope is `{ "evidence": <object>, "signature": <base64> }`. Sign the
UTF-8 bytes of `"codeops.retained-source-evidence/v1\0"` followed by
`canonicalJsonText(evidence)` using Ed25519. The filename is the lowercase
SHA-256 hex digest of `canonicalJsonText(evidence)`, followed by `.json`.
The request digest uses the `sha256:` prefix. The gateway verifies the signature,
schema, filename identity, candidate digest, authority and historical readback.
The bounded envelope is retained in the service evidence directory; the
verified source and checks are stored immutably in the recovery table.

The verifier is an explicit prerequisite outside the runtime trust boundary.
An operator cannot substitute assertions of approval or source success in the
HTTP request. An evidence bundle may reference existing accepted checks; it
does not create those checks.

### Root WorkspaceLaunch evidence

Set `historical.workspaceLaunchId` to the actual `launch-<24 lowercase hex>`
identity. Use the `readHistory` SQL with parameters for the historical Session,
dispatch, and launch IDs. It adds `workspaceLaunches` to the original history
object: an array of complete `to_jsonb(w)` rows from `codeops.workspace_launches`,
ordered by `launch_id`. The selection matches the supplied launch ID, the
persisted `launch_json.sessionId`, or `launch_json.retryRuntime.sessionId`.
The query reads at most two rows and validation requires exactly one. Hash
this complete object, including the actual persisted `request_json` and
`launch_json`, into `historical.digest` before signing. Do not create a launch
projection from verifier assertions or omit fields from the persisted rows.

The gateway independently checks the launch ID derived from its principal and
request idempotency key, request digest and prompt, requested catalog sources,
policy, context attachments, and complete workspace. It checks the deterministic
root Session, initial prompt, dispatch and lease IDs against the actual outbox
row and embedded dispatch. The launch principal must own the historical Session
and match both dispatch principal fields and the current signed operator. The
historical Session identity must match the dispatch identity; the complete
workspace must also match the current authorized Session. Repository and base
checks still apply to the signed exact candidate.

This branch supports the original root launch and initial prompt only. A
`retryRuntime`, fork, mixed admission/launch origin, absent launch, or ambiguous
launch match fails closed. A ready launch must also bind its persisted Session
and initial prompt command IDs. Root launch state does not establish worker
success: independent termination and source-origin evidence remain required.
A pending outbox with a prior claim and a terminal failed worker can qualify
without changing status, claim, lease, progress, or checkpoint records.

## Requests

Each request uses `Authorization: Bearer <session-broker-write-token>`,
`X-CodeOps-Principal: <authenticated-operator>`, and
`Content-Type: application/json`. Runtime principals are rejected. The strict
body is identical for all actions:

```json
{ "evidenceDigest": "sha256:<64 lowercase hexadecimal characters>" }
```

Use these POST routes in order:

1. `/v1/retained-source-recoveries/<recoveryId>/finalize`
2. `/v1/retained-source-recoveries/<recoveryId>/branch`
3. `/v1/retained-source-recoveries/<recoveryId>/pull-request`

Finalization returns `source-finalized`, the recovered-source origin and
candidate digest. Each effect request is an explicit allow-once operator
permission for the exact signed publication metadata. Effects can also finalize
the source atomically if it has not yet been finalized. PR creation requires a
successful or reconciled branch result. It creates the real PR directly and
adds an explicit recovered-source origin notice. There is no bootstrap PR.

Requests replay a stored successful result. Identity conflicts and duplicate
retained source identities or repository/target-branch bindings fail closed.
A historical branch/PR provider-effect
record blocks this recovery publication path and must use its original
reconciliation path. The new operation never adopts or retries that effect.

The separate recovery effect table stores the existing GitHub provider request,
payload/permission digests, attempt identity and existing result contracts.
`provenance.sourceRecoveryId` identifies the recovery. Admitted recovery retains
its actual `admissionId` UUID and omits `workspaceLaunchId`. Root recovery uses
`admissionId: null` and its actual `workspaceLaunchId`; that launch ID is never
an admission UUID. Its Session, dispatch, generation and lease fields are
historical references, not a new runtime claim. Current authority is bound by
the immutable signed recovery evidence and the deterministic operation ID.
Normal provider HTTP routes reject
recovery provenance; only this authenticated operation invokes it. Publication
uses the existing GitHub adapter and its repository-scoped credentials.
Ordinary mutation and reconciliation routes require their existing admission
UUID and reject both admitted and root recovery metadata. Runtime request
contracts do not accept recovery metadata. Root provider provenance is limited
to branch creation and PR creation through this signed operation.

An attempted effect is durable before any provider call. An ambiguous call
returns `202` with `state: "unknown"`; repeating the effect cannot write again.
After the bounded 20-minute attempt window, use the same body with
`/reconcile-branch` or `/reconcile-pull-request`. These invoke the existing
read-only provider reconciliation, including exact marker, parent, tree and PR
identity checks. Reconciliation can run after signed write authority expires
but still requires the same current principal, generation, lease and source.
Unknown outcomes remain blocked. `reconciled_not_observed` is terminal and does
not authorize another attempt. No operator-supplied success resolution exists.

## Exact branch candidate format

The existing chunked candidate API and service-owned candidate loader support
an additive `binding` object:

```json
{
  "version": "codeops.github-branch-publish-candidate/v1",
  "binding": {
    "repository": "example/project",
    "baseSha": "<40 hex>",
    "baseTreeSha": "<40 hex>",
    "treeSha": "<40 hex>"
  },
  "changes": [{
    "path": "src/new.txt",
    "oldText": "",
    "newText": "complete file contents\n",
    "exact": { "baseBlobSha": null, "baseMode": null, "mode": "100644" }
  }]
}
```

For a modification, supply the original Git blob SHA and `100644` or `100755`
base mode. `newText` is the full replacement, not a substring. Every change in
an exact candidate must carry `exact`; mixing replacement semantics is denied.
Additions require an absent path, including safe directory parents. Executable
files and empty files are supported. Empty content means an empty regular file,
not deletion. Deletions, symlinks, submodules, binary/NUL content, traversal,
`.git` paths, duplicate paths and ancestor/descendant collisions are unsupported
and rejected. Other base-tree entries remain intact.

The existing bounds are 100 changed paths, 100,000 characters per file, and
4,194,304 serialized candidate bytes, staged in at most 64 chunks. Exact
candidates support `mode: "create"` only. Branch creation checks the base ref,
base tree and each old blob/mode, then requires the provider-created result tree
to equal `treeSha` before creating the commit or ref. It rechecks the base ref
before commit creation. GitHub does not offer an atomic fence on both the base
ref and a new target ref; PR creation separately rechecks the expected base and
head. A later base movement cannot change the published candidate tree.
