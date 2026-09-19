# Cluster Browser

A headless bb plugin for one pre-provisioned Playwright MCP worker. It registers
native tools. It does not install a browser, provision a worker, or manage workflows.
CodeOps and other consumers can use its evidence without owning browser infrastructure.

## Compatibility and tools

Pin bb **0.43.1**, Plugin SDK **0.4.87**, MCP SDK **1.30.0**, and Playwright MCP
**0.0.82**. That MCP package pins Playwright/Core **1.64.0-alpha-1789764292000**.
The client checks the upstream Playwright version and each selected input schema
before calling a browser tool. It rejects drift. This alpha Playwright dependency
requires explicit upgrade qualification. See [dependency review](DEPENDENCIES.md).

| Native tool | Upstream operation |
| --- | --- |
| `cluster_browser_open` | Resolve project target; create session; `browser_navigate` |
| `cluster_browser_navigate` | `browser_navigate` |
| `cluster_browser_snapshot` | `browser_snapshot` |
| `cluster_browser_click` | `browser_click` |
| `cluster_browser_fill_form` | `browser_fill_form` |
| `cluster_browser_press_key` | `browser_press_key` |
| `cluster_browser_wait_for` | `browser_wait_for` |
| `cluster_browser_take_screenshot` | `browser_take_screenshot` |
| `cluster_browser_console_messages` | `browser_console_messages` |
| `cluster_browser_network_requests` | `browser_network_requests` |
| `cluster_browser_close` | Terminate the owned MCP session with HTTP DELETE |

Interaction schemas come from upstream `tools/list`. The only narrowing removes
`filename`: artifacts return through native tool results, not runner filesystem paths.
No evaluator, script runner, browser installer, or arbitrary MCP operation is exposed.
`navigate` accepts ordinary HTTP(S) application URLs. Project targets are entrypoints,
not an egress security boundary; links and redirects can leave those origins.

## Operator setup (separate rollout authorization required)

1. Prepare exactly one private browser worker. Use the exact MCP package above,
   `--isolated`, `--headless`, and `--no-webmcp`. Leave shared-context, extension,
   CDP, remote endpoint, persistent profile, and imported storage-state options unset.
   `--isolated` creates a new browser context for each client backend. The worker
   may share a browser process. A transport session ID alone does not prove this.
2. Keep browser, CDP, and MCP endpoints private. Supply authenticated TLS routing
   from the bb plugin server to the worker. If using a proxy, forward POST, GET/SSE,
   DELETE, and `Mcp-Session-Id`; preserve the exact host that upstream permits.
   Set upstream `--allowed-hosts` to that exact private host, never `*`.
   Upstream MCP does not implement the plugin's bearer-token authentication itself;
   the trusted ingress must enforce it. The plugin refuses redirects and does not
   perform OAuth or credential acquisition. Plain HTTP is allowed only on loopback.
3. Apply network restrictions outside the plugin. Permit only approved application
   destinations and required DNS. Deny peer workers, management APIs, cluster APIs,
   and production databases. Do not mount reusable application or model credentials.
   Review the runner OS/browser license graph and use an immutable image digest.
4. Run the disposable browser proof below. It must pass before normal PR readiness
   or rollout. The plugin cannot attest runner arguments through MCP.
5. After separate installation approval, install the package subdirectory through
   bb's normal plugin interface. Do not install it as part of coding qualification.
   Use protected plugin settings to enter `workerEndpoint` and optional `workerToken`.
   Both settings have `secret: true`; they stay on the bb server. Stop selected
   sessions before rotating the endpoint/token pair, then resume after both are set. Do not put them in
   prompts, repositories, agent arguments, or shell commands retained in history.
6. Set `projects` to JSON keyed by authenticated bb project IDs. Use normal app
   URLs without userinfo, embedded tokens, query strings, or fragments:

   ```json
   {"isolation":"playwright-isolated","projects":{"proj_example":{"current-preview":"https://preview.example.test/"}}}
   ```

7. Restart/resume selected agent sessions so bb resolves the native tool list.
   The configuration callback exposes this plugin's tools only for configured
   projects. It cannot disable tools owned by another plugin or provider.

## Ownership, lifecycle, and evidence

Ownership comes only from bb's authenticated `execute` context `projectId/threadId`.
Neither tool arguments nor writable thread metadata can choose an owner or endpoint.
Each owner gets a fresh MCP client. Calls retain that client and context. Selecting
a target again closes the old session and starts a new context. Calls for one owner
cannot overlap. Different owners have independent clients; at most 32 are retained.

Idle expiry is five minutes; absolute lifetime is thirty minutes; sweep interval
is fifteen seconds; each call has a sixty-second deadline. Cancellation sends the
SDK cancellation notification and retires the local session. Neither cancellation
nor a transport error proves the browser action stopped. Unknown outcomes are not
retried. Reopen explicitly and inspect app state before repeating a mutation.

Close, expiry, settings changes, and plugin disposal attempt MCP DELETE and close
the client. DELETE has a three-second network deadline. A failed DELETE, process
crash, or partition can leave a remote context. Upstream has no per-session TTL;
its shared browser idle timeout does not bound an orphan while peers remain active.
The operator must provide a bounded worker-recycle policy and recover orphaned
contexts before rollout. A worker recycle closes all contexts, so schedule it as
an operator maintenance action. This plugin does not provision that policy.

Text results are bounded and redact the configured endpoint/host/token. Images are
native image parts, limited to one 5 MB base64 payload per result. Other MCP resource
parts are dropped. A screenshot can contain app data; no transport credential is
injected into a page. Do not use production credentials or secrets in fixture apps.
Snapshots and console/network output remain untrusted. Returned session/target/time
context supports evidence association. Optional `run` and `candidate` labels are
caller-supplied; they do not verify deployed identity or confer authority.

## Opt-in migration for selected sessions

Record each selected session's provider, browser MCP entries, skills, and installed
browser plugins before changing configuration. Through each competing plugin's
supported session selection, exclude those sessions. If it has no session selector,
use a separate explicitly configured agent session or ask the operator to approve a
global change; this plugin does not silently disable another plugin.

Remove/disable competing Playwright/browser MCP entries in that session's supported
provider configuration. Exclude browser-specific skills through the supported bb
skill/session controls. Preserve ordinary search, document fetch, and repository test
capabilities. Restart the session and inspect the resolved tool list. Restore recorded
configuration to roll back. Do not claim migration is complete from configuration alone.

bb 0.43.1 `agents.configure` can select only this plugin's tools and skills. It cannot
turn off a provider-native browser or search tool. Provider-native controls must be
verified for the installed provider; absent a supported control, report that surface
as remaining available. An unrestricted shell can install another browser client.
Tool-list reduction improves discovery; worker networking remains the access boundary.

## Qualification

From this package:

```sh
npm ci --workspaces=false --include=dev
npm run check:licenses
npm run typecheck
npm test
bb plugin types --check .
bb plugin build .
```

Tests use the installed SDK harness, synthetic HTTP MCP failure fixtures, and the
real pinned upstream HTTP server for handshake/schema verification. They do **not**
launch Chromium. Synthetic image tests establish result plumbing, not a real screenshot.
Run repository `nub run verify` and `nub run check:chart` before handoff. No UI or
container image is changed. The standalone npm lock supports qualification without
installing or changing a running bb plugin.

### Exact parent-operated browser fixture

Use a separate disposable, non-root runner with the pinned Playwright browser binary
and its OS libraries. The installed `playwright-core/browsers.json` records Chromium
**154.0.8037.0, revision 1246** (verify against the lock before provisioning).
Use the upstream [Docker guidance](https://playwright.dev/docs/docker) to supply
libraries and preserve existing container, sandbox, and network boundaries. Do not
use `--no-sandbox`, privileged mode, host networking, or the coding worker as the
browser runner. If this runtime cannot launch Chromium under those boundaries,
report that capability to the parent instead of relaxing them.

In that runner, use `npm ci --workspaces=false --include=dev` for this package.
The parent can install the pinned browser with
`node node_modules/playwright/cli.js install chromium` during runner image preparation.
Supply the supported OS libraries in that image; do not install them or Chromium in
the coding worker. Then run these processes separately:

```sh
node scripts/fixture.mjs
node node_modules/@playwright/mcp/cli.js --host 127.0.0.1 --port 8931 --isolated --headless --sandbox --no-webmcp --browser chromium --image-responses allow --idle-timeout 300000
```

Then run the proof from the same disposable fixture environment:

```sh
CLUSTER_BROWSER_FIXTURE_ENDPOINT=http://localhost:8931/mcp \
CLUSTER_BROWSER_FIXTURE_TARGET=http://127.0.0.1:4173/ \
node scripts/qualify-browser.mjs
```

For a separate qualification client, the parent must supply authenticated private
TLS routing to the same single worker and keep the fixture target reachable from
that worker. Supply any token through `CLUSTER_BROWSER_FIXTURE_TOKEN` using a secure
operator mechanism. The coding worker has no authority to create this route or Job.
The proof performs fixture-only mutations, checks cookie/localStorage isolation and
session retention, and writes a real PNG plus a receipt under `.output/browser-qualification/`.
It fails closed when either fixture variable is missing. Do not promote the draft
based on protocol tests or unrelated Kubernetes boundary probes.
