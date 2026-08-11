import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const issue = new URL("./issue-codeops-session-proof-runtime-credentials.sh", import.meta.url);
const revoke = new URL("./revoke-codeops-session-proof-runtime-credentials.sh", import.meta.url);

test("scripts are valid shell and reject an unscoped namespace", () => {
  for (const script of [issue, revoke]) assert.equal(spawnSync("bash", ["-n", script.pathname]).status, 0);
  for (const script of [issue, revoke]) {
    const result = spawnSync("bash", [script.pathname, "--namespace", "example-repository"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /codeops-session-proof/);
  }
});

test("dry-run reports only the exact two runtime credential identities", () => {
  const result = spawnSync("bash", [issue.pathname, "--namespace", "codeops-session-proof-video-1", "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim()), [
    "codeops-registry",
    "codeops-agent-source-credentials",
  ]);
  assert.equal(/token value|dockerconfigjson/.test(result.stdout), false);
});

test("issuer validates inputs, normalizes the token, rolls back, and creates no updates", async () => {
  const source = await readFile(issue, "utf8");
  assert.match(source, /! -L .* -s/);
  assert.match(source, /registry_size >= 32.*registry_size <= 65536.*repository_size >= 20.*repository_size <= 257/s);
  assert.match(source, /Object\.keys\(value\.auths\)\.length !== 1/);
  assert.match(source, /typeof entry\.auth !== "string"/);
  assert.match(source, /credsStore.*credHelpers/s);
  assert.match(source, /wc -l.*<= 1/s);
  assert.match(source, /tr -d '\\r\\n'/);
  assert.match(source, /mktemp -d/);
  assert.match(source, /chmod 700/);
  assert.match(source, /created=\(\)/);
  assert.match(source, /delete secret.*--ignore-not-found/s);
  assert.match(source, /create secret generic codeops-registry/);
  assert.match(source, /--type=kubernetes\.io\/dockerconfigjson/);
  assert.match(source, /create secret generic codeops-agent-source-credentials/);
  assert.equal(source.includes("kubectl apply"), false);
  assert.equal(source.includes("kubectl patch"), false);
});

test("revoker names only the two proof runtime credentials", async () => {
  const source = await readFile(revoke, "utf8");
  const block = source.match(/kubectl -n .*? --ignore-not-found/s)?.[0] ?? "";
  assert.match(block, /codeops-registry/);
  assert.match(block, /codeops-agent-source-credentials/);
  assert.equal(block.includes("codeops-session-broker"), false);
  assert.equal(block.includes("codeops-codex-auth"), false);
});
