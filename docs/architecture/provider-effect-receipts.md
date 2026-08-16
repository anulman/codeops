# Provider effect receipts

CodeOps stores GitHub authorization and remote effect state as separate facts.
An allow-once permission creates an `authorized` provider effect receipt. The
control gateway commits `attempting` before it sends a provider request. An
exact `authorized` receipt can resume after a crash because no provider attempt
was committed. A recovered `attempting` receipt becomes `unknown` and cannot
retry automatically.

The terminal states have these meanings:

- `succeeded`: CodeOps validated the provider result and postcondition.
- `failed`: Provider preflight proved that no remote effect occurred.
- `unknown`: CodeOps cannot prove whether the provider applied the effect.
- `reconciled_satisfied`: A later provider read proves the requested effect.
- `reconciled_not_observed`: A later read proves the exact prior state after
  the provider consistency window.
- `operator_resolved`: An operator supplied a bounded summary and up to 10
  bounded evidence references.

CodeOps does not automatically retry an `unknown` effect. The Agents UI shows
the repository, operation, target, expected head SHA, attempt time, and safe
reconciliation action. The `Run reconciliation read` action performs a
read-only provider request. It does not repeat the mutation.

Reconciliation is operation-specific:

- A pull-request metadata update is satisfied only when the exact identity and
  every requested field match. A mismatch stays unknown because legacy inputs
  do not retain every prior metadata field.
- A review reply contains a hidden marker derived from the effect ID. The read
  searches the exact review thread for that marker.
- An update-branch effect is not observed only when the exact prior head still
  exists after the consistency window. A changed head stays unknown because
  another actor can advance it.
- A check rerun stays unknown when the provider evidence cannot attribute the
  rerun to the CodeOps attempt.

The read projection does not include provider credentials, request headers,
raw provider bodies, or stored reconciliation evidence.
