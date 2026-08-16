# Contributing

## Contribution license

CodeOps uses the Apache License, Version 2.0. By submitting a contribution,
you license that contribution under Apache-2.0. CodeOps does not require a
separate contributor license agreement.

Submit only work that you have the right to license. Preserve third-party
copyright, attribution, notice, and license text. Do not copy, adapt, link,
vendor, or add a package dependency under a copyleft or source-available
license. See [LICENSE_POLICY.md](LICENSE_POLICY.md).

## Validation

Run the complete local gate before you submit a pull request:

```sh
nub install --frozen-lockfile
nub run verify
nub run acceptance:agents-ui
```

If a change adds or updates a dependency, verify its license and update the
third-party notices when the distribution boundary changes. The license gate
rejects CodeOps packages without `Apache-2.0` metadata and rejects unapproved
JavaScript dependency licenses.

## Commit messages

Treat the commit log as developer documentation. The diff records how the code
changed. The commit message must preserve what changed and why.

Follow these rules:

1. Write a capitalized, imperative subject that completes this sentence:
   `If applied, this commit will ...`
2. Aim for 50 characters. Do not exceed 72 characters.
3. Do not end the subject with a period.
4. Use a plain subject without `feat:`, `fix:`, or another type prefix unless
   release tooling requires the prefix.
5. If a body is necessary, separate it from the subject with a blank line and
   wrap it at 72 characters.
6. Explain the problem, why this solution is necessary, the prior and new
   behavior, and any non-obvious consequence. Do not narrate the diff.
7. Put issue and pull request references after the explanatory body.
8. Read the staged diff before you write or amend the message. Use conversation
   history only as supporting context, not as the source of truth.

Use ASD-STE100 Simplified Technical English as the writing standard for
technical product text. Also follow the
[Google developer documentation style guide](https://developers.google.com/style)
for developer-facing prose. Project-specific terminology and rules take
precedence.

This policy incorporates the commit-message guidance from
[Tim Pope](https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html)
and [Chris Beams](https://cbea.ms/git-commit/).
