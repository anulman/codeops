import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const issue = new URL("./issue-codeops-session-proof-secrets.sh", import.meta.url);
const revoke = new URL("./revoke-codeops-session-proof-secrets.sh", import.meta.url);

test("scripts are valid shell and reject an unscoped namespace", () => {
  for (const script of [issue, revoke]) {
    assert.equal(spawnSync("bash", ["-n", script.pathname]).status, 0);
    const result = spawnSync("bash", [script.pathname, "--namespace", "example-repository"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /codeops-session-proof/);
  }
});

test("dry-run reports only the exact seven Secret identities", () => {
  const result = spawnSync("bash", [issue.pathname, "--namespace", "codeops-session-proof-video-1", "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /seven distinct/);
  for (const name of [
    "codeops-session-proof-database-owner",
    "codeops-session-broker-database",
    "codeops-session-broker-read-auth",
    "codeops-session-broker-write-auth",
    "codeops-session-runtime-worker-auth",
    "codeops-session-job-initialization-auth",
    "codeops-session-runtime-worker-database",
  ]) assert.match(result.stdout, new RegExp(`  ${name}\\n`));
  assert.equal(result.stdout.includes("postgresql://"), false);
  assert.equal(result.stdout.includes("password="), false);
});

test("issuer uses temporary files, rollback, and create-only Secrets", async () => {
  const source = await readFile(issue, "utf8");
  assert.match(source, /mktemp -d/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /create secret generic/);
  assert.equal(source.includes("kubectl apply"), false);
  assert.equal(source.includes("set -x"), false);
  assert.equal(source.includes("last-applied-configuration"), false);
});
