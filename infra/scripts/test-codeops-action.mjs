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

test("browser acceptance bounds Ubuntu mirror failures", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  const browserJob = workflow.jobs["agents-ui-browser-acceptance"];
  const install = browserJob.steps.find(
    ({ name }) => name === "Install the exact Chromium runtime",
  );

  assert.equal(browserJob["timeout-minutes"], 20);
  assert.match(install.run, /azure\.archive\.ubuntu\.com/);
  assert.match(install.run, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
  assert.match(install.run, /Acquire::Retries "3"/);
  assert.match(install.run, /Acquire::https::Timeout "20"/);
  assert.match(install.run, /timeout --signal=TERM --kill-after=30s 10m/);
  assert.match(install.run, /install --with-deps chromium/);
});

test("CI installs Nub from the exact immutable release artifact", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);

  for (const jobName of ["verify", "agents-ui-browser-acceptance"]) {
    const install = workflow.jobs[jobName].steps.find(
      ({ name }) => name === "Install Nub",
    );
    assert.match(
      install.run,
      /github\.com\/nubjs\/nub\/releases\/download\/v0\.1\.11\/nub-linux-x64\.tar\.gz/,
    );
    assert.match(
      install.run,
      /d227290e3a45c05ff20508a961f01950c50a138b08caf76d59f403e8a721330d/,
    );
    assert.doesNotMatch(install.run, /nubjs\.com\/install\.sh/);
  }
});
