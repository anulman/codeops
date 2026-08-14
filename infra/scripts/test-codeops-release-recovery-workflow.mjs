import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("release recovery retries only one validated immutable failed run", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/release-recovery.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "runId",
    "tag",
    "sourceSha",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const job = workflow.jobs["rerun-failed-release-jobs"];
  assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
  assert.equal(job["timeout-minutes"], 5);
  const checkout = job.steps.find(
    ({ uses }) => uses === "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  const setupNode = job.steps.find(
    ({ uses }) => uses === "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  );
  assert.equal(setupNode.with["node-version"], "24");

  const validate = job.steps.find(
    ({ name }) => name === "Validate immutable release recovery request",
  );
  assert.equal(validate.env.GH_TOKEN, "${{ github.token }}");
  assert.match(validate.run, /git rev-parse "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(validate.run, /codeops-release-version\.mjs/);
  assert.match(validate.run, /\.event/);
  assert.match(validate.run, /\.status/);
  assert.match(validate.run, /\.conclusion/);
  assert.match(validate.run, /\.head_branch/);
  assert.match(validate.run, /\.head_sha/);
  assert.match(validate.run, /\.github\/workflows\/release\.yml/);

  const retry = job.steps.find(({ name }) => name === "Retry only failed release jobs");
  assert.equal(retry.env.GH_TOKEN, "${{ github.token }}");
  assert.match(retry.run, /rerun-failed-jobs/);
  assert.match(retry.run, /RUN_ID/);
  assert.doesNotMatch(source, /packages:\s*write/);
});
