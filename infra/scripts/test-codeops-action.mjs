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
});
