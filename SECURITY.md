# Security policy

## Supported versions

CodeOps is an alpha. Only the newest published release receives security
fixes.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for `anulman/codeops`. Include the affected version,
impact, reproduction steps, and any suggested mitigation. Do not include live
credentials or private customer data.

The maintainer will acknowledge a complete report within seven days. Release
timing depends on severity and the availability of a verified fix.

## Security boundary

Repository-controlled runtimes must not receive reusable GitHub or model
provider credentials. Report any path that bypasses repository admission,
credential scope, session generation, lease identity, or immutable artifact
validation.
