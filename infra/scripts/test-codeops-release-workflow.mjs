import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const expectedImages = [
  "agent", "agents-ui", "control-gateway", "model-proxy", "orchestrator",
  "plane-controller", "session-control-gateway", "session-gateway",
  "session-runtime-worker",
];

test("release stays explicit and publishes one exact immutable bundle", async () => {
  const source = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const workspace = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const workflow = parse(source);
  assert.match(workspace.scripts.test, /codeops-contracts test/);
  assert.match(workspace.scripts.test, /agents-ui test/);
  assert.match(workspace.scripts.test, /--filter '\.\/services\/\*'/);
  assert.doesNotMatch(workspace.scripts.test, /--filter '\.\/packages\/\*'/);
  assert.doesNotMatch(workspace.scripts.test, /--filter '\.\/sites\/\*'/);
  assert.deepEqual(Object.keys(workflow.on), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  assert.ok(workflow.on.push.paths.includes("infra/charts/codeops/**"));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(workflow.jobs.images.strategy.matrix.image, expectedImages);
  const build = workflow.jobs.images.steps.find(({ name }) => name === "Build exact image");
  assert.equal(build.with.push, "${{ needs.validate.outputs.publish == 'true' }}");
  assert.equal(build.with.tags, "ghcr.io/anulman/codeops/${{ matrix.image }}:sha-${{ github.sha }}");
  assert.equal(workflow.jobs.chart.if, "needs.validate.outputs.publish == 'true'");
  assert.deepEqual(workflow.jobs.chart.needs, ["validate", "images"]);
  const chartDockerLogin = workflow.jobs.chart.steps.find(
    ({ name }) => name === "Authenticate Docker to GHCR",
  );
  assert.equal(chartDockerLogin.uses, "docker/login-action@v3");
  const chartAttestation = workflow.jobs.chart.steps.find(
    ({ name }) => name === "Attest packaged chart",
  );
  assert.equal(chartAttestation.if, "${{ !github.event.repository.private }}");
  const registryInstall = workflow.jobs["registry-install"];
  assert.equal(registryInstall.if, "needs.validate.outputs.publish == 'true'");
  assert.deepEqual(registryInstall.needs, ["validate", "chart"]);
  assert.equal(registryInstall.permissions.packages, "read");
  assert.equal(
    registryInstall.steps.some(({ uses }) => uses === "actions/checkout@v4"),
    false,
  );
  const install = registryInstall.steps.find(
    ({ name }) => name === "Install only from the OCI registry",
  );
  assert.match(install.run, /helm pull oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(install.run, /helm install codeops oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(install.run, /sourceCheckout:false/);
  assert.match(install.run, /kubectl wait --namespace codeops --for=condition=Available deployment --all/);
  assert.match(install.run, /helm uninstall codeops/);
  const serialized = JSON.stringify(workflow);
  assert.match(serialized, /Reject artifact identity reuse/);
  assert.match(serialized, /refs\/remotes\/origin\/main/);
  assert.match(serialized, /refusing to overwrite existing image identity/);
  assert.match(serialized, /refusing to overwrite existing chart version/);
  assert.match(serialized, /oci:\/\/ghcr\.io\/anulman\/codeops\/charts/);
  assert.match(serialized, /codeops-release-images\.mjs/);
  assert.match(serialized, /codeops-release-chart\.mjs/);
  assert.match(serialized, /nub run prepare:chart/);
  assert.match(serialized, /helm package \.release\/chart/);
  assert.match(serialized, /release-manifest\.json/);
  assert.match(serialized, /values\.release\.yaml/);
  assert.doesNotMatch(serialized, /renoconcierge\/renoconcierge-codeops/);
});
