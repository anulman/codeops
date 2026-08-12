# Current state

CodeOps is a public alpha. Version 0 releases are public development releases.
The repository contains one standalone source tree, ten immutable runtime
images, and one OCI Helm chart. Published releases retain the chart, release
values, image plan, checksums, SPDX SBOMs, and license-policy reports.

The chart supports managed, external, or disabled Plane, Temporal, and
JetStream capabilities. PostgreSQL is required and can be managed or external.
The complete source gate is `nub run verify`.

Current limitations:

- Production onboarding requires repository-scoped GitHub and Plane authority.
- Managed Plane requires a human onboarding step before the adapter can start.
- The project is alpha. Values and contracts can change before version 1.0.
