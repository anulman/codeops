import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const path = ".github/workflows/codeops-ci.yml";
const workflow = parse(await readFile(path, "utf8"));

assert.equal(workflow.name, "CodeOps CI");
assert.ok(workflow.on?.pull_request?.paths);
assert.ok(workflow.on?.push?.paths);
assert.deepEqual(workflow.permissions, { contents: "read" });
assert.equal(Object.keys(workflow.jobs).length, 1);

const contracts = workflow.jobs.contracts;
assert.equal(contracts["runs-on"], "ubuntu-latest");
assert.equal(contracts.permissions, undefined);
assert.ok(Array.isArray(contracts.steps));
assert.deepEqual(contracts.steps[0]?.with, {
  "fetch-depth": 2,
  "persist-credentials": false,
});
assert.ok(contracts.steps.some((step) => step.run === "nub install --frozen-lockfile"));
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts test",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts typecheck",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts build",
  ),
);
assert.ok(contracts.steps.some((step) => step.run === "git diff --check HEAD^ HEAD"));

function inspect(value, path = []) {
  if (typeof value === "string") {
    assert.equal(value.includes("secrets."), false, `secret context at ${path.join(".")}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, [...path, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "permissions") {
        assert.equal(typeof child, "object", `shorthand permissions at ${path.join(".")}`);
        for (const permission of Object.values(child ?? {})) {
          assert.notEqual(permission, "write", `write permission at ${path.join(".")}`);
        }
      }
      inspect(child, [...path, key]);
    }
  }
}

inspect(workflow);

console.log(`${path} is valid, read-only, and secret-free.`);
