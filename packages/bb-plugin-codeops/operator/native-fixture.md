# Isolated native workflow and panel fixture

This fixture uses real bb threads, the real server launcher and browser UI.
It does not mock validation, submit receipts or deploy an installation. Run it
only on a temporary operator-managed qualification instance, not production.
The coding worker must not obtain server configuration or Kubernetes credentials.

## Server-only execution policy

Set `CODEOPS_EXECUTION_CONFIG` on the trusted server to an absolute regular-file
path. Example contents:

```json
{
  "version": 1,
  "externalSandboxHosts": [{
    "hostId": "<exact-native-bb-host-id>",
    "profile": "kubernetes-isolated-worker-v1"
  }]
}
```

The supported profile is an **operator attestation**, not an agent-selected
runtime profile or proof inferred from metadata. Before listing a host, verify
that its non-root worker Pod has private storage, no shared server home/database,
no Kubernetes/launcher or production credentials, and enforced network denial
to peer workers, management/cluster APIs and production databases. The worker
must not be able to replace the server file or any of its parent directories.
Use mode 0600 or 0400 and a server/root-owned file on a protected server volume.
The loader rejects symlinks, group/world-writable files, unknown profiles,
wildcards, duplicate IDs and malformed configuration. File checks supplement
the external trust boundary; they cannot prove that a volume is not shared.
Use an ordinary protected file rather than a symlinked projected-config path.

Both worker and reviewer spawns reread this file and match the live environment's
native `hostId` exactly. An attested host selects `full`; every other host keeps
`accept-edits`. No file configured means the unchanged default. A configured
but unreadable/invalid file blocks spawn. Briefs, tool arguments, project labels
and writable plugin metadata cannot enable full mode. Removing an entry affects
future spawns; it does not stop an already-running child. Stop such a child with
normal bb lifecycle controls before decommissioning its outer isolation.

This selection changes no Pod, policy, RBAC, credentials or human gate.
The separate `CODEOPS_VALIDATION_CONFIG` still controls only the trusted Job
launcher. The two configurations must never be mounted into workers.

## Reproduce the native flow

1. Operator: obtain the exact plugin candidate and verify commit/tree. Build and
   temporarily install it on an isolated bb 0.43.1 qualification server with
   SDK 0.4.87. Configure the validation launcher as described in [README.md](README.md)
   and the exact host attestation above. Keep all deploy/install actions on the
   operator side. There is no production installation step in this fixture.
2. Create a disposable native project and managed worktree at the exact candidate
   on that isolated host. Create a parent thread on this environment. Its initial
   task should only acknowledge the fixture and remain idle. Use native IDs from
   `bb thread show <parent-id> --json` and `bb environment show <env-id> --json`.
   Do not fabricate IDs or use a shared host. Pin the desired Codex provider/model
   as the temporary project's normal defaults; CodeOps uses native defaults.
3. Independently stage the candidate image with Node 24 and frozen dependencies.
   The fixture's check runs `test/execution-policy.test.ts` inside the disposable
   validation Job. It writes only temporary test files. Its argv uses no network
   and does not need a writable candidate root. This proves native progression;
   the broader required candidate tests need their own Job evidence.
4. Write `/operator/fixture.json` with `key` (unique to this qualification),
   `projectId`, `parentThreadId`, `environmentId`, `repository`, `base`,
   `candidate: {head, tree, files}`, `hostId`, and `expectedPermissionMode: "full"`.
   Candidate metadata must match the protected image catalog and live worktree.
5. From the authorized operator checkout, prepare the frozen no-change brief:

```sh
node --experimental-strip-types packages/bb-plugin-codeops/operator/native-fixture.ts \
  prepare /operator/fixture.json /operator/start.json
bb codeops command "$(cat /operator/start.json)"
```

Save the returned run ID. Native idle events and the schedule drive progression;
inspect with `bb codeops command '{"op":"get","id":"<run-id>"}'`. For a bounded
manual wake use `{"op":"reconcile","id":"<run-id>"}`. Do not repeatedly retry
an unknown check/spawn effect. Expect distinct worker and reviewer threads,
actual candidate-bound Job evidence and `Publish / NeedsAttention` with manual
publication as the reason. The candidate must remain unchanged. This no-change
fixture is not a substitute for testing code implementation/correction behavior.

```sh
node --experimental-strip-types packages/bb-plugin-codeops/operator/native-fixture.ts \
  capture /operator/fixture.json /operator/native-evidence.json <run-id>
```

Capture reads live plugin state, thread status and environment host IDs.
bb 0.43.1 `ThreadResponse` has no `permissionMode` field. Capture pages through
`bb thread log <id> --json --limit 100 --after-seq <seq>`, the CLI surface for
`bb.sdk.threads.events.list`. It reads host-resolved policy from
`client/turn/requested.data.execution.permissionMode`. The native SDK's
`threads.defaultExecutionOptions` derives its recorded options from these same
request events; it is not a field in `thread show`.

For each observed request, capture requires the expected mode, a later
`turn/input/accepted` with matching `data.clientRequestId`, and a later successful
`turn/completed` with the same row-level `scope.turnId`. It rejects missing,
ambiguous, mismatched, failed or truncated evidence, including a later request
with a different mode. No prose, request parameters in legacy events, project
defaults or writable plugin metadata can substitute for this provenance.

The receipt records only policy, request/turn identities and event IDs/sequences;
raw event pages (which can include transcript content) are transient and are not
printed or saved. CLI failures are sanitized. Pagination is bounded to 10,000
rows per child; a larger log or an over-limit response blocks capture rather
than implying complete proof. Capture also checks exact brief/candidate and G3/G4
bindings and requires both children idle. It reads no authentication file or
kubeconfig and does not change workflow state.

These events prove bb's resolved dispatch policy and completed native turn,
not a provider's physical sandbox implementation. Preserve operator-observed
shell/provider and outer-isolation evidence separately. The pinned public
[CLI log implementation](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/apps/cli/src/commands/thread/show.ts)
and [native event writer/readback](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/apps/server/src/services/threads/thread-events.ts)
provide the inspected contract.

Restart the temporary server with its durable store and protected configuration
preserved. Capture to a second new file; run identity, candidate, evidence and
child IDs must be unchanged. Starting the same frozen brief again must return
the same run, not spawn more children. Test unsafe/unlisted host selection in
the automated harness rather than executing a worker on a shared host. For live
negative validation, omit the candidate from a disposable server's catalog and
confirm `Validate / NeedsAttention`, no accepted checks and no reviewer; retain
that separate run as failure evidence. Restore configuration only on the
operator side, with a new fixture key after confirming termination.

## Reproduce the panel checks

Use a browser-capable isolated operator image. Install the frozen workspace
and matching Playwright Chromium through the existing acceptance runner tooling.
Supply an operator-approved authenticated browser state if the temporary server
requires it; keep that file outside the repository and worker volumes.

Write `/operator/panel-fixture.json`:

```json
{
  "panelUrl": "https://<temporary-bb-origin>/plugins/codeops/runs",
  "nativeEvidencePath": "/operator/native-evidence.json",
  "storageStatePath": "/operator/browser-state.json",
  "outputDirectory": "/operator/new-panel-evidence"
}
```

Use the actual CodeOps navigation URL from that instance if its route differs.
Omit `storageStatePath` only if the approved temporary server does not require it.

```sh
node infra/scripts/qualify-bb-codeops-panel.mjs /operator/panel-fixture.json
```

The script checks the real panel at desktop/mobile widths, candidate, condition,
exact evidence/review and native thread controls. It saves screenshots and a
result record. It neither clicks progression/cancellation nor relaxes browser
sandbox settings. A failed browser launch, login or assertion is a blocker,
not a successful visual review. Inspect both screenshots before accepting layout.

Return exact plugin commit/tree, native capture, Job/Pod and image receipts,
restart/duplicate/negative observations, browser result/screenshots and source
review in this bb thread. The operator owns teardown and evidence retention.
No fixture success grants publication, merge, release or deployment authority.
