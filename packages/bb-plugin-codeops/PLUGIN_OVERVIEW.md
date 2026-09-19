CodeOps keeps an admitted brief, candidate checks and agent review visible in
one bb panel. One SQLite store owns run decisions while bb owns native threads.

## What you get

- A CodeOps page with stage, condition, candidate, evidence and attention reasons.
- The same command boundary through `bb codeops command`, panel actions and
  the `codeops_command` agent tool.
- Native implementation and advisory reviewer threads with bounded correction.
- Candidate-bound checks and restart/unknown-effect reconciliation.

## Requirements and current limits

Requires bb 0.43.1 and SDK 0.4.87. Isolated checks require a trusted server
launcher and a restricted, default-deny Kubernetes validation namespace.
See [operator setup and qualification](operator/README.md). Bubblewrap is not
a required host dependency. No production or publication credentials belong
in the worker account. Admission checks native project, environment and repository identity.

Native review uses bb’s shared trust model; separate threads do not imply
read-only security isolation. Publication, merge, release and deployment
remain manual; this version does not claim a review-ready handoff. Jev and tracker
synchronization are not configured. Kubernetes provisioning is a proposal only.
