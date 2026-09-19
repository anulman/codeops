# Cluster Browser

A headless bb plugin for one pre-provisioned Playwright MCP worker. It registers
native tools. It does not install a browser, provision a worker, or manage workflows.
CodeOps and other consumers can use its evidence without owning browser infrastructure.

## Compatibility and tools

The reproducible qualification baseline is bb **0.43.1**, Plugin SDK **0.4.87**,
MCP SDK **1.30.0**, and Playwright MCP **0.0.82** (Playwright/Core
**1.64.0-alpha-1789764292000**). Exact dependency versions and integrity hashes
remain locked. A tested baseline is not an exact-version installation requirement.

- bb and Plugin SDK engines accept patches within **0.43.x** and **0.4.x**,
  starting at the baseline. The SDK dependency remains exact for repeatable builds.
- The MCP client negotiates protocol support and requires session support and every
  selected input schema to match. Additional unexposed tools are harmless.
- The worker may report another **1.64.x** Playwright build. A different minor or
  major line, malformed version, missing tool, duplicate tool, or changed selected
  schema fails before a browser call. A matching version is never authentication.

Patch maintenance uses the standing qualification procedure below; it does not
need a new architecture decision for each package. Update exact locks, run license
checks, SDK typecheck/native harness and transport failure tests, then run the real
browser fixture against the proposed runner. Retain its actual package versions,
server readback and source/lock hashes. Qualify bb patches with the installed SDK
and plugin build on that proposed bb version. Publish only the combination tested.
Schema capture alone cannot establish behavior or context isolation; never refresh
the schema baseline just to make a failing test pass.

Playwright MCP **0.0.x** and its alpha Playwright dependency do not promise patch
compatibility. They use the same routine qualification, including browser and
boundary evidence, before an operator changes the runner. Runtime schema checks
are an additional guard, not that evidence. Only the baseline is qualified so far;
synthetic patch tests do not qualify an unreleased package. Changes to API shape,
release line, isolation, permissions or license need explicit review. See
[dependency review](DEPENDENCIES.md). Rollout remains separately authorized.

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
The pinned runner writes automatic post-action snapshots to runner files. After
`open` successfully navigates, the plugin calls the supported read-only
`browser_snapshot` without `filename` on the same session and returns that initial
inline DOM. A navigation error is returned directly, without a snapshot call.
Observation transport failure or cancellation retires the session without replaying
the navigation. A tool-level snapshot error is returned as an error. Later native
interactions retain upstream semantics: call `cluster_browser_snapshot` to inspect
the resulting DOM. Explicit snapshot and console/network tools return inline text
without `filename`; screenshots return native image data with
`--image-responses allow`. Runner file links may accompany results but are not
required or readable through this plugin. There is no `--output-mode` flag in this
pin; `--snapshot-mode full` alone does not inline automatic snapshots.

No evaluator, script runner, browser installer, or arbitrary MCP operation is exposed.
`navigate` accepts ordinary HTTP(S) application URLs. Project targets are entrypoints,
not an egress security boundary; links and redirects can leave those origins.

## Operator setup (separate rollout authorization required)

1. Prepare exactly one private browser worker. Use the exact qualified MCP artifact,
   `--isolated`, `--headless`, `--no-webmcp`, and `--image-responses allow`. Leave shared-context, extension,
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
browser runner image is changed. The Agents UI image build includes this package
manifest so the frozen workspace remains complete. The standalone npm lock supports qualification without
installing or changing a running bb plugin.

### Exact parent-operated browser fixture

Use a separate disposable, non-root runner with the pinned Playwright browser binary
and its OS libraries. The installed `playwright-core/browsers.json` records Chromium
**154.0.8037.0, revision 1246**. The parent selects and independently verifies one
isolation profile. The MCP proof cannot inspect Pod policy or browser process flags.

- `chromium-internal`: use `--sandbox` where Chromium's internal sandbox works.
  This remains the normal path on a supported runtime.
- `external-container`: use `--no-sandbox` **only inside a separate disposable runner**
  protected by the approved outer Kubernetes/container boundary. Require UID 1000,
  read-only root, no capabilities, `no-new-privileges`/no privilege escalation,
  restricted Pod admission, no service-account token or reusable credentials, and
  default-deny ingress/egress (network-none for the local container probe). Use only
  the loopback fixture. Writable temporary/browser output storage must be disposable.
  Attach independent Pod/container and network-denial evidence. This profile does
  not test Chromium's internal sandbox; nested Chrome namespaces are not required.

Never apply `--no-sandbox` to coding workers, shared/user browsers, or a runner without
that verified external boundary. Neither profile authorizes more privileges, node
changes, control-plane changes, or production deployment. Actual rollout must select
and verify an isolation profile separately. Keep MCP/browser/CDP endpoints private.

Use the upstream [Docker guidance](https://playwright.dev/docs/docker) to prepare
libraries. In the separate runner, install this exact package with
`npm ci --workspaces=false --include=dev`. The parent can install the pinned browser
with `node node_modules/playwright/cli.js install chromium` during image preparation.
Do not install libraries or Chromium in the coding worker. Keep package source and
dependencies read-only at runtime. Mount disposable writable `/tmp` and a writable
`.output` directory at the package root for proof receipts; do not make the root
filesystem writable. Set `XDG_CONFIG_HOME=/tmp/config` and
`XDG_CACHE_HOME=/tmp/cache` for full Chromium's writable configuration/cache and
crashpad needs. A temporary home directory alone is insufficient. The runner
commands put MCP output under `/tmp`.

Run the fixture process on runner loopback:

```sh
node scripts/fixture.mjs
```

For `chromium-internal`, start the runner and execute the proof separately:

```sh
XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache \
node node_modules/@playwright/mcp/cli.js --host 127.0.0.1 --port 8931 --isolated --headless --sandbox --no-webmcp --browser chromium --image-responses allow --output-dir /tmp/cluster-browser-mcp --idle-timeout 300000
```

```sh
CLUSTER_BROWSER_FIXTURE_ENDPOINT=http://localhost:8931/mcp \
CLUSTER_BROWSER_FIXTURE_TARGET=http://127.0.0.1:4173/ \
CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE=chromium-internal \
node scripts/qualify-browser.mjs
```

For the parent-operated `external-container` profile, inside the verified disposable
runner only:

```sh
XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache \
node node_modules/@playwright/mcp/cli.js --host 127.0.0.1 --port 8931 --isolated --headless --no-sandbox --no-webmcp --browser chromium --image-responses allow --output-dir /tmp/cluster-browser-mcp --idle-timeout 300000
```

Run the proof in the same isolated environment. Set
`CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256` to the SHA-256 of the parent's
independent boundary evidence artifact, and retain that artifact beside the receipt:

```sh
CLUSTER_BROWSER_FIXTURE_ENDPOINT=http://localhost:8931/mcp \
CLUSTER_BROWSER_FIXTURE_TARGET=http://127.0.0.1:4173/ \
CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE=external-container \
CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256="$BOUNDARY_EVIDENCE_SHA256" \
node scripts/qualify-browser.mjs
```

Both profiles require `--isolated` for per-client browser contexts. That setting is
independent of the process/container sandbox profile. Both profiles execute the
**same** functional, cookie/localStorage isolation,
retention, diagnostic, and real PNG assertions. No test is disabled. The proof writes
`screenshot.png` and `result.json` under `.output/browser-qualification/`. The receipt
records candidate-file hashes, selected profile, and the independent evidence hash.
Those profile fields are operator assertions, not authority or MCP attestation.

This loopback proof requires no private route from the coding worker. A later
multi-host qualification or rollout needs separately authorized authenticated private
TLS routing; this task does not create it. Any token must use the protected setting
or `CLUSTER_BROWSER_FIXTURE_TOKEN` through a secure operator mechanism. The coding
worker has no authority to create routes or Jobs. Do not promote the draft based on
protocol tests or boundary probes alone; retain both actual browser and boundary evidence.
