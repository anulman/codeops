# CodeOps agent guide

## Product model

CodeOps is a Kubernetes control plane for durable coding-agent sessions. One
installation can manage multiple allowlisted repositories. Plane supplies
human-visible work items. Temporal supplies durable workflow execution.
PostgreSQL stores control-plane state. JetStream transports lifecycle events.

Read [`docs/context/CURRENT-STATE.md`](docs/context/CURRENT-STATE.md) before a
change. Use the remaining files in `docs/context/` for product, domain,
decision, and source context.

## Directory map

- `packages/codeops-contracts/`: versioned wire and persistence contracts.
- `services/`: trusted gateways, workers, controllers, agent runtime, and
  acceptance runner.
- `sites/agents-ui/`: private operator interface.
- `infra/charts/codeops/`: public Helm installation boundary.
- `infra/k3s/codeops-vps/`: isolated VPS development-cluster contract.
- `infra/scripts/`: renderers, validators, proofs, and release builders.
- `docs/architecture/`: accepted system architecture.

## Authority map

- The control gateway owns Kubernetes effects and repository read/write
  selection.
- The session gateway owns authenticated session commands.
- The Plane controller owns Plane and GitHub webhook admission.
- The model proxy is the only runtime boundary that receives the reusable
  model-provider credential.
- Repository-controlled Agent Jobs receive no reusable GitHub or model-provider
  credential.

## Non-negotiable invariants

- Bind every effect to one repository, base commit, session, generation, and
  lease.
- Resolve credentials from the admitted repository before an external effect.
- Reject unknown repositories, identity drift, credential reuse, and mutable
  image references.
- Keep credentials out of logs, browser bundles, workflow history, Plane, and
  generated evidence.
- Preserve immutable release tags and registry identities.
- Do not publish, merge, deploy, or change live infrastructure without explicit
  authority.

## Change protocol

1. Identify the owning contract and authority boundary.
2. Run the smallest relevant test while editing.
3. Run `nub run verify` before a commit or handoff.
4. Run `nub run acceptance:agents-ui` for UI changes.
5. Build each affected image for Docker or packaging changes.
6. Review the complete diff for credential, identity, and fail-open behavior.

## Commit messages

- Write a short, capitalized imperative subject. Aim for 50 characters and do
  not exceed 72. Do not end the subject with a period.
- Prefer a plain subject such as `Reject mutable release tags`. Do not add a
  type prefix such as `fix:` or `feat:` unless release tooling requires it.
- If the change needs context, add a blank line and a body. Wrap body text at
  72 characters.
- Use the body to explain the problem, the reason for the change, the prior
  behavior, the new behavior, and non-obvious consequences. Do not narrate the
  diff or use chat history as the source of truth.
- Put issue and pull request references after the explanatory body.
- Read the staged diff before you write or amend the message. Make sure the
  message describes the complete commit and nothing outside it.

## Test selection

- Contract change: `nub run --filter @codeops/codeops-contracts test`
- Agents UI change: `nub run --filter @codeops/agents-ui test`
- Service change: `nub run --filter <package-name> test`
- Helm, docs, or release change: `nub run check:chart`
- Cold-start evaluation: `nub run evaluate`
- Complete gate: `nub run verify`

Keep technical product text short and direct. Follow ASD-STE100 as the writing
standard. For developer documentation, also use the Google developer
documentation style guide. Project-specific terminology and rules take
precedence. Preserve exact API, schema, environment-variable, and Kubernetes
identifiers.
