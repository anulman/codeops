Use native bb tools to inspect and interact with project-configured applications
on one private Playwright MCP worker. Each authenticated thread owns its session.

## Tools

`cluster_browser_open` selects a configured target. The remaining tools expose
upstream navigation, accessibility snapshots, clicks, form filling, key presses,
waits, screenshots, console messages, network requests, and close. Screenshots
use native image parts. Caller-supplied run and candidate labels accompany results.

## Requirements

Requires bb 0.43.1, SDK 0.4.87, and a separately operated Playwright MCP 0.0.82
runner with isolated browser contexts. The operator supplies private connectivity,
authentication, application targets, and cleanup recovery. The plugin does not
provision or deploy a browser. Browser content remains untrusted data.

## Qualification

The package includes SDK, lifecycle, and real HTTP protocol tests plus a disposable
browser fixture. Run browser qualification in a separate runner before rollout.
A protocol handshake is not browser isolation evidence. Review the setup guide
and qualification status before installation.
