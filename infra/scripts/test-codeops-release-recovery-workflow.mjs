import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("release recovery retries only one validated immutable failed run", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/release-recovery.yml", import.meta.url),
    "utf8",
  );
  const request = JSON.parse(
    await readFile(new URL("../../.github/release-recovery.json", import.meta.url), "utf8"),
  );
  const workflow = parse(source);

  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, [
    ".github/release-recovery.json",
    ".github/workflows/release-recovery.yml",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const job = workflow.jobs["rerun-failed-release-jobs"];
  assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
  assert.equal(job["timeout-minutes"], 5);
  const checkout = job.steps.find(({ uses }) => uses === "actions/checkout@v4");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);

  const validate = job.steps.find(
    ({ name }) => name === "Validate immutable release recovery request",
  );
  assert.equal(validate.env.GH_TOKEN, "${{ github.token }}");
  assert.match(validate.run, /git rev-parse "refs\/tags\/\$\{tag\}"/);
  assert.match(validate.run, /\.event/);
  assert.match(validate.run, /\.status/);
  assert.match(validate.run, /\.conclusion/);
  assert.match(validate.run, /\.head_branch/);
  assert.match(validate.run, /\.head_sha/);
  assert.match(validate.run, /\.github\/workflows\/release\.yml/);

  const retry = job.steps.find(({ name }) => name === "Retry only failed release jobs");
  assert.equal(retry.env.GH_TOKEN, "${{ github.token }}");
  assert.match(retry.run, /rerun-failed-jobs/);
  assert.doesNotMatch(source, /packages:\s*write/);
  assert.deepEqual(request, {
    runId: 31625101787,
    tag: "v0.2.0",
    sourceSha: "7c4b91db930444b3bb364967a6c7a9f790d8bc93",
  });
});
