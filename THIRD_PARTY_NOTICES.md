# Third-party notices

CodeOps source is licensed under the Apache License, Version 2.0. CodeOps
distributions also contain or refer to third-party software under separate
licenses. Those licenses apply to the third-party software only.

## Bundled Helm chart dependencies

The CodeOps Helm archive bundles these upstream Helm charts:

| Component | Version | License | Source |
| --- | --- | --- | --- |
| NATS Helm chart | 2.14.0 | Apache License 2.0 | <https://github.com/nats-io/k8s/tree/nats-2.14.0/helm/charts/nats> |
| Temporal Helm chart | 1.6.0 | MIT | <https://github.com/temporalio/helm-charts/tree/temporal-1.6.0> |
| Plane CE Helm chart | 1.6.2 | AGPL-3.0-only | <https://github.com/makeplane/plane> |

The packaged chart includes the applicable license and copyright text under
`licenses/`. The upstream chart archives do not become CodeOps-authored work.
Plane is an approved copyleft aggregate exception. CodeOps does not copy,
adapt, or link Plane source. The chart deploys Plane as separate processes and
preserves its upstream license and source obligations.

## Referenced services and images

The chart can install or connect to PostgreSQL, NATS, Temporal, and Plane. It
can also pull images and their transitive operating-system packages from
upstream registries. Those components remain under their own licenses. A
release includes an SPDX SBOM and a license-policy report for each published
CodeOps image. Use those release assets as the exact component inventory for
that release.

The SBOM is an inventory aid. It does not replace the license text or the
source-code obligations that apply to a component.
