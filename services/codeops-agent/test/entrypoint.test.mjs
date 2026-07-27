import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypointUrl = new URL("../entrypoint.sh", import.meta.url);
const entrypoint = await readFile(entrypointUrl, "utf8");

test("entrypoint validates persistent auth access without chmodding the CSI volume root", () => {
  execFileSync("/bin/sh", ["-n", entrypointUrl.pathname]);

  const temporaryHomeBranch = entrypoint.match(
    /if \[ "\$codex_home" = "\/tmp\/codex-home" \]; then([\s\S]*?)else/,
  )?.[1];
  const persistentHomeBranch = entrypoint.match(
    /else([\s\S]*?)fi\nexport CODEX_HOME/,
  )?.[1];

  assert.match(temporaryHomeBranch ?? "", /chmod 700 "\$codex_home"/);
  assert.doesNotMatch(persistentHomeBranch ?? "", /^\s*chmod\b/m);
  assert.match(
    persistentHomeBranch ?? "",
    /test -r "\$codex_home\/auth\.json"/,
  );
  assert.match(persistentHomeBranch ?? "", /test -w "\$codex_home"/);
});
