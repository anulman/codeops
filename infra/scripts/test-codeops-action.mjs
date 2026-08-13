import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("reusable Action is a thin wrapper around the same operator CLI", async () => {
  const source = await readFile(
    new URL("../../.github/actions/codeops/action.yml", import.meta.url),
    "utf8",
  );
  const action = parse(source);
  assert.equal(action.runs.using, "composite");
  assert.deepEqual(Object.keys(action.inputs), [
    "command",
    "lock",
    "values",
    "policy",
    "release",
    "namespace",
  ]);
  const run = action.runs.steps.find(({ name }) => name === "Run the pinned CodeOps operator");
  assert.match(run.run, /infra\/scripts\/codeopsctl\.mjs/);
  assert.match(run.run, /args=\(/);
  assert.doesNotMatch(source, /GH_TOKEN|password|secret/i);
  for (const step of action.runs.steps) {
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }
});

test("pins every GitHub Action to an immutable commit", async () => {
  for (const relativePath of [
    "../../.github/actions/codeops/action.yml",
    "../../.github/workflows/ci.yml",
    "../../.github/workflows/release.yml",
    "../../.github/workflows/release-recovery.yml",
  ]) {
    const document = parse(
      await readFile(new URL(relativePath, import.meta.url), "utf8"),
    );
    const serialized = JSON.stringify(document);
    const uses = [...serialized.matchAll(/\"uses\":\"([^\"]+)\"/g)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${relativePath} must contain Actions`);
    for (const value of uses) assert.match(value, /@[0-9a-f]{40}$/);
  }
});
