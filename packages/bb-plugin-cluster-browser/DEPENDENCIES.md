# Dependency review

CodeOps-authored files are Apache-2.0. `upstream-tools.json` contains the input
schemas and descriptions obtained through `tools/list` from Playwright MCP
0.0.82 (Microsoft, Apache-2.0). `scripts/capture-schemas.mjs` uses the public
`createConnection` API without starting a browser.

Runtime dependencies are MCP SDK 1.30.0 (MIT) and Ajv 8.20.0 (MIT).
`package-lock.json` pins the standalone distribution graph and integrity hashes.
Run `npm ci --workspaces=false --include=dev`, then `npm run check:licenses`.
The repository lock adds this package's graph without updating existing resolutions.
The repository-wide `nub run check:licenses` remains mandatory.

The bb SDK 0.4.87 npm artifact omits a license field and license file. Its npm
`gitHead` is `3b37d2790d084a47c96eb78267da5d159598f203`; that exact source tree's
[LICENSE](https://github.com/get-bb/bb/blob/3b37d2790d084a47c96eb78267da5d159598f203/LICENSE)
is MIT. `SDK-LICENSE.txt` preserves the source notice. The reviewed npm integrity is:

```text
sha512-mTlcPPpef2fA7eWEiP7VutYXP1grn3efKzGDYaSTBXelkrwatUdlPXyZodehJyEJhRYGa8rUXo/WxNIecP9Nvg==
```

This exact version has a documented repository license override. It is a development
and type dependency; the plugin's SDK import is type-only. An SDK upgrade needs a
new artifact and source-license review. This is not a blanket missing-license exception.

Qualification dependencies include Playwright MCP 0.0.82 and its exact Playwright /
Playwright Core version 1.64.0-alpha-1789764292000 (Apache-2.0), TypeScript 6.0.3
(Apache-2.0), Node types 25.7.0, better-sqlite3 13.0.3, and cron-parser 5.5.0 (MIT).
The lock gate checks each transitive artifact; unknown or restricted licenses fail.
No browser binary or OS image is distributed in the plugin. The operator must review
the separate runner image and its OS/browser notices before deployment.

Primary contracts:

- [Requested bb contract revision](https://github.com/get-bb/bb/blob/267938526dfcbc0edb228ce827b5bec202c1af97/packages/plugin-sdk/src/backend-contract.ts).
- Installed SDK 0.4.87 bundled declarations, verified by `bb plugin types --check`.
- [Pinned upstream runner factory](https://github.com/microsoft/playwright/blob/78ff4260d79b924724bdcc4ccd89e463b8f43b0d/packages/playwright-core/src/tools/mcp/program.ts).
- [Pinned upstream HTTP sessions](https://github.com/microsoft/playwright/blob/78ff4260d79b924724bdcc4ccd89e463b8f43b0d/packages/playwright-core/src/tools/utils/mcp/http.ts).
