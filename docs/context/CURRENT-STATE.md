# Current state

CodeOps is a public alpha. Version 0 releases are public development releases.
The repository contains one standalone source tree, ten immutable runtime
images, and one OCI Helm chart. Published releases retain the chart, release
values, image plan, checksums, SPDX SBOMs, and license-policy reports.

The chart supports managed, external, or disabled Plane, Temporal, and
JetStream capabilities. PostgreSQL is required and can be managed or external.
The complete source gate is `nub run verify`.

CodeOps owns the generic Agents UI acceptance runner and publishes it with
each release. A consumer pins that runner from the same release manifest as
the chart and creates the ephemeral post-deploy invocation. Product-specific
acceptance remains in the product repository.

Current limitations:

- Production onboarding requires repository-scoped GitHub and Plane authority.
- Managed Plane requires a human onboarding step before the adapter can start.
- Temporal WorkItem automation uses the bounded Agent Job adapter. Interactive
  Agent Sessions use the Session Broker runtime adapter. The adapters share
  authority and policy inputs but still have separate resource builders.
- The project is alpha. Values and contracts can change before version 1.0.
