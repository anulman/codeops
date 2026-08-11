# Contributing

## Contribution license

CodeOps uses the GNU Affero General Public License, version 3 only. By
submitting a contribution, you license that contribution under
AGPL-3.0-only. CodeOps does not require a separate contributor license
agreement.

Submit only work that you have the right to license. Preserve third-party
copyright, attribution, notice, and license text. Do not copy code with an
incompatible license into this repository.

## Validation

Run the complete local gate before you submit a pull request:

```sh
nub install --frozen-lockfile
nub run verify
nub run acceptance:agents-ui
```

If a change adds or updates a dependency, verify its license and update the
third-party notices when the distribution boundary changes. The license gate
rejects CodeOps packages without `AGPL-3.0-only` metadata and rejects
unapproved JavaScript dependency licenses.
