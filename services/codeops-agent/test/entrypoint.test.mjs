import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypointUrl = new URL("../entrypoint.sh", import.meta.url);
const entrypoint = await readFile(entrypointUrl, "utf8");

test("entrypoint rejects persistent Codex homes and isolates temporary state", () => {
  execFileSync("/bin/sh", ["-n", entrypointUrl.pathname]);
  assert.match(entrypoint, /codex_home="\$\{CODEX_HOME:-\/tmp\/codex-home\}"/);
  assert.match(entrypoint, /if \[ "\$codex_home" != "\/tmp\/codex-home" \]/);
  assert.match(entrypoint, /chmod 700 "\$codex_home"/);
  assert.match(entrypoint, /CODEOPS_MODEL_PROXY_TOKEN_FILE/);
  assert.match(entrypoint, /short-lived model proxy token was not initialized/);
  assert.match(entrypoint, /export CODEX_API_KEY/);
  assert.doesNotMatch(entrypoint, /auth\.json|persistent Kubernetes volume/);
});
