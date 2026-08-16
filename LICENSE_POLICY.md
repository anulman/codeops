# License policy

CodeOps-authored work uses Apache-2.0. CodeOps accepts source and package
dependencies only under approved permissive licenses.

## Approved licenses

The dependency gate approves these common permissive license families:

- Apache-2.0
- MIT
- BSD-2-Clause and BSD-3-Clause
- ISC and 0BSD
- BlueOak-1.0.0
- CC0-1.0 and Unlicense
- Python-2.0

The executable gate is the authoritative allowlist. An unknown, custom, dual,
compound, or missing license fails closed until maintainers review the exact
version and distributed artifact.

## Prohibited incorporation

Do not copy, adapt, link, vendor, or add a package dependency under GPL, LGPL,
AGPL, MPL, EPL, CDDL, SSPL, BUSL, Elastic License, Commons Clause, PolyForm,
or another copyleft or source-available license.

Prefer an equivalent permissively licensed dependency. If none exists, stop
the change and request a maintainer decision.

## Separate components

A separately operated or aggregated copyleft component requires an explicit
documented exception and human approval. The exception must identify the exact
component, version, license, boundary, reason, notices, and source obligations.
The component must remain across a process, network, or aggregate distribution
boundary. Do not copy, adapt, link, or vendor its source or library code.

The current approved exceptions are:

- Plane CE 1.6.2 is an unmodified, separately licensed Helm aggregate
  component. CodeOps deploys Plane as separate processes and preserves its
  AGPL-3.0-only text and source notice.
- Lightning CSS 1.33.0 and its exact Linux x64 GNU binary package are
  unmodified MPL-2.0 build dependencies required by the pinned TanStack Start
  and Vite toolchain. The Agents UI uses StyleX for application styling. Its
  runtime image contains the bundled application output and does not contain
  Lightning CSS. The executable gate binds this exception to the exact package
  names, versions, and license. A version or package change fails closed.
- `web-push@3.6.7` is an unmodified MPL-2.0 runtime module behind the Web Push
  delivery interface. No maintained permissive drop-in provides the same Web
  Push encryption and VAPID behavior. The executable gate binds this existing
  exception to the exact package name, version, and license. Replace it before
  changing that dependency boundary.

## Validation

Run `nub run check:licenses` after a dependency or distribution change. The
complete `nub run verify` gate also runs this check. Release jobs retain the
exact SPDX SBOM and license-policy report for every CodeOps image.
