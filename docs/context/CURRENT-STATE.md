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

Interactive ACP sessions can call the provider-neutral `work_items.create`
tool for a repository in the exact workspace source set. The first provider
adapter is Plane. Triage creation is the default and uses the Plane Intake
queue. Direct creation uses the Plane project work-item endpoint and requires
a durable human permission decision for the same live prompt dispatch. The
ACP agent receives no Plane credential. The trusted controller applies the
idempotent provider mutation.

The Session Broker projects pre-policy 0.4.2 workspace snapshots into the
immutable `implement` policy at the read boundary. It does not rewrite the
stored snapshot, checkpoint, cursor, or evidence. This preserves the existing
0.4.2 rollback input while the current fleet and Agents UI use the strict
policy-bearing identity.

Current limitations:

- Production onboarding requires repository-scoped GitHub and Plane authority.
- Managed Plane requires a human onboarding step before the adapter can start.
- Temporal WorkItem automation uses the bounded Agent Job adapter. Interactive
  Agent Sessions use the Session Broker runtime adapter. The adapters share
  authority and policy inputs but still have separate resource builders.
- The project is alpha. Values and contracts can change before version 1.0.
- Interactive workspace launch admits only trusted catalog repositories. The
  source materializer is credential-isolated from the runtime Pod, but coding
  agents retain monitored public HTTPS egress for research and package access.
