# Trusted Kubernetes validation

Implemented, not yet qualified against a live Job. The earlier disposable
Node boundary probe is not candidate test evidence. No resources were deployed
from this checkout. The Kubernetes machine-enrollment proposal remains separate.

## Trust boundary

`server.ts` selects `KubernetesRunner`. Only the trusted bb server reads
`CODEOPS_VALIDATION_CONFIG`, an absolute path outside any worker filesystem.
The config contains paths to a server-only kubeconfig and kubectl executable,
and an operator-attested catalog of exact candidate images. No command, RPC,
agent tool, repository file or worker response can select a launcher or submit
a validation receipt. The host entry cannot call Kubernetes. Bubblewrap's host
RPC remains an optional legacy primitive; normal server validation never calls
it and has no Bubblewrap dependency.

The operator must protect the server, config, kubectl, kubeconfig and image
catalog from coding workers. Use a dedicated identity with only the Role below.
Do not give the bb server a general cluster credential for this feature. An
operator must verify restricted admission, CNI NetworkPolicy enforcement and
node isolation. The runner reads the namespace's policy set and rejects all
but one default-deny policy. RBAC cannot prove CNI enforcement. Policy changes
and other privileged writers remain outside the runner's trust boundary.

The launcher creates one Job per request digest. It does not install a
controller, create services, enroll machines, execute in existing Pods or
change policies. Unknown create/timeout results block the run; no automatic
retry or replacement is permitted. Read back the deterministic Job name
`codeops-<first 48 characters of request digest>` before any operator remedy.
The engine deliberately leaves unknown effects pending, including cancellation.
Automatic recovery of unknown check effects is not implemented. Jobs have a
120-second deadline and one-day TTL. Export evidence before TTL cleanup. The
launcher has no delete permission.

## Operator installation request

These steps require separate operator authority. They are not commands for a
coding worker, and have not been executed here.

1. Review [validation.yaml](validation.yaml). Substitute your validation and
   trusted-server namespace names consistently. `bb-system` must already exist.
   Use the existing dedicated validation namespace if it has the same enforced
   boundary. Do not apply the Namespace or policy over a shared workload.
   Pin Pod Security Admission to your supported Kubernetes version if required
   by installation policy. Verify network denial with a disposable probe.
2. Apply the reviewed file from an authorized operator terminal:
   `kubectl apply -f packages/bb-plugin-codeops/operator/validation.yaml`.
   The Role grants only Job create/get, Pod get/list/log read, and NetworkPolicy
   list in that namespace. `kubectl logs` performs a Pod GET before its
   pods/log request; both read permissions are required. It grants no secrets,
   exec, RBAC, namespaces, nodes, PVCs, production objects or cross-namespace reads. The validation account
   has no RoleBinding and disables token automount.
3. Supply a short-lived, renewable credential for the launcher identity to the
   trusted server through the installation's existing credential mechanism.
   Keep it outside worker volumes; no token or kubeconfig goes in this repo,
   chat, Job spec or evidence. Configure an explicit kubeconfig path. This
   package does not mint a token, select a cluster context or change server
   deployment settings.
4. Independently obtain the exact candidate commit and base, verify the Git
   tree and changed-file list, and build a credential-free validation image.
   Place the clean candidate plus pinned offline dependencies/tools at
   `/candidate`. Record its immutable registry digest. Do not use an image
   attestation supplied only by a worker, a mutable tag, or the boundary-probe
   image as candidate proof. Review the exact distributed image's licenses.
   The image must support uid/gid 1000, a read-only root and writable `/tmp`.
   Baking credentials, model auth, registry auth or server files into it is
   prohibited. This is manual materialization, not a hidden image builder.
5. Place the following JSON outside worker access; substitute actual values.
   `candidate.files` is the exact `git diff --name-only BASE HEAD` array.

```json
{
  "namespace": "codeops-validation",
  "kubeconfig": "/operator/codeops-validation.kubeconfig",
  "kubectl": "/usr/bin/kubectl",
  "candidates": [{
    "repository": "https://github.com/example/repository",
    "base": "<40-character-base>",
    "candidate": {"head": "<40-character-head>", "tree": "<40-character-tree>", "files": ["<changed-file>"]},
    "image": "registry.example/validation@sha256:<64-character-digest>"
  }]
}
```

Set `CODEOPS_VALIDATION_CONFIG=/operator/validation.json` only on the trusted bb
server when the operator installs this candidate. The package remains pinned
to bb 0.43.1 / SDK 0.4.87. This task does not authorize agent installation.
Workers need neither this variable nor any launcher authority.

## Exact qualification request

Use Node 24 and the frozen dependency installation on the trusted operator
side. Prepare `/operator/request.json` with `runId`, `generation`, `lease`,
`repository`, `base`, `candidate`, and `check: {name, argv}` from the admitted
run. Do not replace candidate identifiers with the earlier probe's identity.
The request digest is computed by the runner and binds all these fields.

For root verification, a suitable check argv for an image with Nub/dependencies
already present is:

```json
["/bin/sh", "-c", "cp -a /candidate /tmp/work && cd /tmp/work && nub run verify"]
```

This preserves the read-only root. `/tmp` is limited to 1 GiB and Job time to
120 seconds in this minimal profile. If those limits are insufficient, report
the failure and review a bounded profile change; do not bypass isolation or
claim a partial test passed. No network dependency installation occurs in a
validation Job. Adjust admission checks to the actual offline tool image.

Run on the authorized trusted server, never in the coding worker:

```sh
node --experimental-strip-types packages/bb-plugin-codeops/operator/qualify.ts \
  /operator/validation.json /operator/request.json /operator/new-receipt.json
```

Return the receipt plus sanitized Job/Pod API records and candidate-image
materialization evidence in the parent bb thread. Required receipt fields are
exact candidate/tree/argv/output digests, exit status, run/generation/lease,
repository/base, namespace, Job name/UID, Pod UID and image digest. The runner
uses Kubernetes termination status, not stdout claims. Output is bounded and
hashed; a successful test that prints forged JSON cannot forge another receipt.
This script proves the runner transport only. It does not insert evidence into
a run or claim the plugin's end-to-end flow passed.

Then, with separately authorized plugin installation, admit a disposable native
bb run and prove worker → clean candidate → Job validation → independent critic
→ manual publication handoff, restart, duplicate/unknown effects and failed
isolation. Use the [native workflow and panel fixture](native-fixture.md).
Native children default to `accept-edits`; only exact hosts attested in protected
server configuration use `full`. Verify actual provider behavior in that
external isolation profile without weakening the Pod/network boundary.

Merge, release and deployment remain human-only. Actual Job output and live bb
workflow/browser evidence are required before calling this candidate qualified.

The design follows Kubernetes [Job semantics](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
and [RBAC least privilege](https://kubernetes.io/docs/concepts/security/rbac-good-practices/).
