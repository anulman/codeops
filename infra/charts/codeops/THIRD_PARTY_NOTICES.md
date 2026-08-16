# Third-party notices

This Helm archive contains the CodeOps chart under Apache-2.0 and these
separate upstream charts:

| Component | Version | License | License file |
| --- | --- | --- | --- |
| NATS Helm chart | 2.14.0 | Apache License 2.0 | `licenses/NATS-CHART-APACHE-2.0.txt` |
| Temporal Helm chart | 1.6.0 | MIT | `licenses/TEMPORAL-CHART-MIT.txt` |
| Plane CE Helm chart | 1.6.2 | AGPL-3.0-only | `licenses/PLANE-CHART-AGPL-3.0.txt` |

The upstream projects retain their copyrights. The CodeOps license does not
replace the license of an upstream chart, service, image, or package.
Plane is the only approved copyleft aggregate exception. CodeOps does not copy,
adapt, or link Plane source. The chart deploys Plane as separate processes and
preserves its upstream license and source obligations.

The chart refers to separately distributed images for CodeOps and optional
managed dependencies. Each CodeOps release publishes one SPDX SBOM and one
license-policy report for every CodeOps image.
