# Kubernetes execution machines proposal

Status: proposal only. No Kubernetes objects, RBAC, services, machine records,
bootstrap identities or external resources were created or changed.

## Recommendation and actual bb boundary

Reuse the existing cluster's compute and storage through one optional bb
machine provider. Keep bb as the machine/enrollment owner and CodeOps as the
run-state owner. Do not add PostgreSQL, Temporal, JetStream, the old dispatcher,
or another scheduler for plugin state. Do not call the old controller.

The compatibility target is installed bb 0.43.1 / SDK 0.4.87. Installed
`bb-plugin-sdk.d.ts` declares `bb.experimental_machines.register` with
`create`, `reconcileCleanup`, `remove`, and paired optional `suspend`/`resume`.
Create receives a stable key, attempt, parsed non-secret inputs, awaited
`checkpoint(resource)`, progress reporter and abort signal. Removal receives
the persisted resource. Compare the [source contract at the SDK artifact's
commit](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/packages/plugin-sdk/src/backend-contract.ts).

`bb.experimental_machines.bootstrap({key, executor, report, signal})` returns
`{hostId}`. `MachineExecutor.exec` receives `{command: string[], stdin: string,
timeoutMs, signal, onOutput}` and returns `{exitCode}`. A provider supplies
transport; core owns enrollment and daemon installation. The public host SDK
has `experimental_create`, `experimental_suspend`, `experimental_resume`,
`retryCleanup`, `get`, and `delete`. Inputs and resource JSON are durable and
readable; neither may contain credentials.

Inspect [bootstrap source](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/apps/server/src/services/machines/bootstrap.ts)
and [enrollment source](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/apps/server/src/services/machines/enrollments.ts)
before implementing transport. A bootstrap response is not a claim that an
agent provider or project checkout is ready.

## Lifecycle and resource design

1. **Admit:** choose an operator-maintained installation profile, immutable
   image digest, pinned bb/SDK pair, storage class, CPU/memory/disk limits,
   namespace and TTL. Inputs contain the profile ID and bounded budget only.
   Reject unknown profiles, mutable tags and unconstrained resource requests.
2. **Allocate:** derive a label-safe key hash. Create one worker workload and
   one PVC per bb machine under that key. Use provider-owned labels and store
   namespace, object names, Kubernetes UIDs, PVC UID and image digest in the
   bb checkpoint immediately after allocation. If a response is lost, list by
   exact key and validate UIDs/spec hashes; never allocate a second worker.
3. **Bootstrap:** implement `MachineExecutor` over an already authorized,
   narrow Kubernetes exec transport into the selected container. Pass core's
   stdin privately; never place it in Pod args, environment, a ConfigMap,
   annotations, logs, progress strings or persisted resource JSON. Suppress
   raw transport errors and redact output before forwarding. No public
   service or inbound listener is required; use existing approved outbound
   bb enrollment transport. If the server is not reachable through an
   approved route, fail readiness. Do not expose one automatically.
4. **Ready:** require workload readiness, enrolled host identity and live
   daemon connection, expected protocol/artifact identity, healthy provider
   authentication, source setup and a clean environment. Core sets up a
   missing project source when its chosen environment provider requires it.
   The machine provider must not clone a parallel checkout itself.
5. **Execute:** use core's environment/thread APIs. One worker PVC contains
   its bb data directory and private checkout area. Do not share a writable
   home, credential directory or Git object store across machines. Enforce
   requests/limits, namespace quotas and a bounded admission cap. A worker
   must receive neither a Kubernetes service-account token nor publication,
   deployment, database or reusable repository-write credentials.
6. **Reconcile:** restart uses the same bb key and checkpoint; observe UID,
   digest, enrollment and connection state before action. Pod restart reuses
   the PVC and same machine identity. Replacement must fence the old daemon
   before the new one connects. Unknown allocations remain pending and are
   discovered by `reconcileCleanup`; it must never bootstrap a new machine.
7. **Suspend:** start without suspend support. Later add both suspend and
   resume only after testing graceful daemon stop, process quiescence and
   storage recovery. Await checkpoint before removing compute. A checkpoint
   is metadata, not a filesystem snapshot. Preserve PVC and enrollment for
   suspension; resume the same fenced identity. Do not claim scale-to-zero
   saved memory or process state.
8. **Terminate:** request core machine deletion; reconcile environment
   teardown, revoke enrollment/access grants and delete only owned UIDs.
   Stop retries when ownership/spec identity differs. Keep failures visible;
   core retries provider cleanup. Use `ephemeral: false` initially so an
   empty thread set cannot erase an unfinished durable run's files. Enable
   ephemeral mode only after testing its different environment-cleanup path.
9. **Retain/clean:** separate compute termination from artifact/PVC deletion.
   Default to retained evidence and a finite operator-selected recovery
   window. Export run records and evidence before uninstall. After expiry,
   delete by exact ownership record and retain an audit tombstone. Never use
   an unconstrained label selector as deletion authority.

## Versioning and credential separation

Pin the runtime image by registry digest and record Node, bb, provider and
plugin artifact versions. bb's enrollment installer uses its server artifact
and can configure daemon auto-update. This can conflict with image pinning:
the implementation must reconcile that update behavior with an operator-owned
version policy, prove the running artifact matches it, and block admission on
mismatch. A pinned image alone is insufficient. Do not claim the current
bootstrap API has an undocumented `disableAutoUpdate` argument.

Keep a narrow provisioner credential on the trusted provisioning side, never
inside a worker. The plugin process is full trust; secret settings do not
create isolation from other code in that process. An external credential
boundary is needed if repository-controlled workers share its account or
filesystem. Model-provider enrollment/authentication is a separate mechanism
from machine enrollment. The Kubernetes provider must not copy the user's
personal auth directory. Use a supported operator-approved provider bootstrap
or retain a visible provider-authentication blocker.

Use existing cluster policies for public egress and private-network denial,
non-root execution, dropped capabilities, seccomp and no service-account-token
mount. A Kubernetes exec transport needs scoped RBAC for its owning workload;
that future permission is a human deployment decision. This proposal does not
grant it. No consumer namespace, domain, registry account or storage provider
is embedded in CodeOps source.

## Required future acceptance evidence

Test with a disposable nonproduction namespace and explicit operator authority:
crash after allocation, crash after enrollment, duplicate create, stale UID,
protocol mismatch, provider-auth failure, PVC exhaustion, unavailable storage,
lost connection, overlapping resumes, failed revoke/delete and cleanup retry.
Measure bounded resource use and prove old/new daemon identity fencing. Verify
bootstrap material is absent from workload specs, logs, checkpoints and user
artifacts. Test cancellation before enrollment and removal without a daemon.
Until these tests pass, this is a design proposal, not a provisioning feature.
