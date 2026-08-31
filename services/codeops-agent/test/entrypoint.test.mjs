import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypointUrl = new URL("../entrypoint.sh", import.meta.url);
const entrypoint = await readFile(entrypointUrl, "utf8");

test("entrypoint requires the isolated per-Session Codex home", () => {
  execFileSync("/bin/sh", ["-n", entrypointUrl.pathname]);
  assert.match(entrypoint, /codex_home="\$\{CODEX_HOME:-\/var\/lib\/codeops-agent\/codex-home\}"/);
  assert.match(entrypoint, /if \[ "\$codex_home" != "\/var\/lib\/codeops-agent\/codex-home" \]/);
  assert.doesNotMatch(entrypoint, /CODEX_HOME:-\/tmp/);
  assert.match(entrypoint, /chmod 700 "\$codex_home"/);
  assert.match(entrypoint, /test -w "\$codex_home"/);
  assert.match(entrypoint, /CODEOPS_MODEL_PROXY_TOKEN_FILE/);
  assert.match(entrypoint, /short-lived model proxy token was not initialized/);
  assert.match(entrypoint, /export CODEX_API_KEY/);
  assert.doesNotMatch(entrypoint, /auth\.json/);
});
