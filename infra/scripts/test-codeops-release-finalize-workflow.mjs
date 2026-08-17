import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("release finalization consumes one exact failed immutable run", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/release-finalize.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  const releaseWorkflow = parse(await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "runId",
    "tag",
    "sourceSha",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency.group, "release-finalize-${{ inputs.tag }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const validate = workflow.jobs.validate;
  assert.deepEqual(validate.permissions, { actions: "read", contents: "read" });
  assert.equal(validate.outputs.release_version, "${{ steps.request.outputs.release_version }}");
  const request = validate.steps.find(
    ({ name }) => name === "Validate immutable finalization request",
  );
  assert.equal(request.env.GH_TOKEN, "${{ github.token }}");
  assert.match(request.run, /git rev-parse "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(request.run, /GITHUB_REF_NAME.*default_branch/);
  assert.match(request.run, /\.conclusion.*failure/s);
  assert.match(request.run, /\.head_branch/);
  assert.match(request.run, /\.head_sha/);
  assert.match(request.run, /\.github\/workflows\/release\.yml/);
  assert.match(request.run, /codeops-release-\$\{release_version\}-\$\{SOURCE_SHA\}/);
  assert.match(request.run, /codeops-golden-source-\$\{SOURCE_SHA\}/);
  assert.match(request.run, /expired == false/);
  assert.match(request.run, /refusing to overwrite existing GitHub Release/);

  const registryInstall = workflow.jobs["registry-install"];
  const expectedRegistryInstall = JSON.parse(JSON.stringify(
    releaseWorkflow.jobs["registry-install"],
  ).replaceAll("${{ github.sha }}", "${{ inputs.sourceSha }}"));
  delete expectedRegistryInstall.if;
  expectedRegistryInstall.needs = "validate";
  for (const stepName of [
    "Download exact release manifest",
    "Download exact golden source report",
  ]) {
    const step = expectedRegistryInstall.steps.find(({ name }) => name === stepName);
    Object.assign(step.with, {
      repository: "${{ github.repository }}",
      "run-id": "${{ inputs.runId }}",
      "github-token": "${{ github.token }}",
    });
  }
  assert.deepEqual(registryInstall, expectedRegistryInstall);
  assert.equal(registryInstall.needs, "validate");
  assert.deepEqual(registryInstall.permissions, { actions: "read", contents: "read" });
  assert.equal(
    registryInstall.steps.some(({ uses }) => uses?.startsWith("actions/checkout@")),
    false,
  );
  for (const stepName of [
    "Download exact release manifest",
    "Download exact golden source report",
  ]) {
    const step = registryInstall.steps.find(({ name }) => name === stepName);
    assert.equal(step.with.repository, "${{ github.repository }}");
    assert.equal(step.with["run-id"], "${{ inputs.runId }}");
    assert.equal(step.with["github-token"], "${{ github.token }}");
  }
  const anonymousAccess = registryInstall.steps.find(
    ({ name }) => name === "Verify anonymous registry access",
  );
  assert.equal(anonymousAccess.env.SOURCE_SHA, "${{ inputs.sourceSha }}");
  assert.doesNotMatch(anonymousAccess.run, /if \. then empty/);
  const install = registryInstall.steps.find(
    ({ name }) => name === "Install only from the OCI registry",
  );
  assert.equal(install.env.SOURCE_SHA, "${{ inputs.sourceSha }}");
  assert.match(install.run, /rollbackStatus:"passed"/);
  assert.match(install.run, /cleanupStatus:"passed"/);

  const githubRelease = workflow.jobs["github-release"];
  const expectedGithubRelease = JSON.parse(JSON.stringify(
    releaseWorkflow.jobs["github-release"],
  ).replaceAll("${{ github.sha }}", "${{ inputs.sourceSha }}"));
  delete expectedGithubRelease.if;
  const expectedReleaseEvidence = expectedGithubRelease.steps.find(
    ({ name }) => name === "Download exact release evidence",
  );
  Object.assign(expectedReleaseEvidence.with, {
    repository: "${{ github.repository }}",
    "run-id": "${{ inputs.runId }}",
    "github-token": "${{ github.token }}",
  });
  assert.deepEqual(githubRelease, expectedGithubRelease);
  assert.deepEqual(githubRelease.needs, ["validate", "registry-install"]);
  assert.deepEqual(githubRelease.permissions, { actions: "read", contents: "write" });
  const releaseEvidence = githubRelease.steps.find(
    ({ name }) => name === "Download exact release evidence",
  );
  assert.equal(releaseEvidence.with["run-id"], "${{ inputs.runId }}");
  const registryEvidence = githubRelease.steps.find(
    ({ name }) => name === "Download exact golden released-image evidence",
  );
  assert.equal(registryEvidence.with["run-id"], undefined);
  const publish = githubRelease.steps.find(
    ({ name }) => name === "Publish durable GitHub Release",
  );
  assert.equal(publish.env.SOURCE_SHA, "${{ inputs.sourceSha }}");
  assert.match(publish.run, /gh release create/);
  assert.match(publish.run, /--prerelease/);

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
    }
  }
  assert.doesNotMatch(source, /packages:\s*write/);
  assert.doesNotMatch(source, /rerun-failed-jobs/);
});
