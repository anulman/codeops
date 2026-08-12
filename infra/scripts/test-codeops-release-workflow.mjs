import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const expectedImages = [
  "acceptance-runner", "agent", "agents-ui", "control-gateway", "model-proxy", "orchestrator",
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
  assert.equal(build.with.load, "${{ needs.validate.outputs.publish != 'true' }}");
  assert.equal(build.with.provenance, "${{ needs.validate.outputs.publish == 'true' && 'mode=max' || 'false' }}");
  assert.equal(build.with.sbom, "${{ needs.validate.outputs.publish == 'true' }}");
  assert.equal(build.with.tags, "ghcr.io/anulman/codeops/${{ matrix.image }}:sha-${{ github.sha }}");
  const syftInstall = workflow.jobs.images.steps.find(
    ({ name }) => name === "Install checksum-verified Syft",
  );
  assert.match(syftInstall.run, /SYFT_VERSION/);
  assert.match(syftInstall.run, /--retry 5 --retry-all-errors/);
  assert.match(syftInstall.run, /sha256sum --check --strict/);
  const imageSbom = workflow.jobs.images.steps.find(
    ({ name }) => name === "Generate exact image SPDX SBOM",
  );
  assert.equal(
    imageSbom.env.IMAGE_SOURCE,
    "${{ needs.validate.outputs.publish == 'true' && 'registry' || 'docker' }}",
  );
  assert.match(imageSbom.run, /syft scan "\$\{IMAGE_SOURCE\}:\$\{image\}"/);
  const imageLicensePolicy = workflow.jobs.images.steps.find(
    ({ name }) => name === "Enforce exact image license policy",
  );
  assert.match(imageLicensePolicy.run, /check-codeops-license-policy\.mjs/);
  assert.equal(workflow.jobs.chart.if, "needs.validate.outputs.publish == 'true'");
  assert.deepEqual(workflow.jobs.chart.needs, ["validate", "images"]);
  assert.equal(workflow.jobs.chart.permissions.actions, "read");
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
  assert.equal(registryInstall.permissions.actions, "read");
  assert.equal(registryInstall.permissions.packages, undefined);
  assert.equal(
    registryInstall.steps.some(({ uses }) => uses === "actions/checkout@v4"),
    false,
  );
  assert.equal(
    registryInstall.steps.some(({ name }) => name === "Authenticate to private GHCR"),
    false,
  );
  const anonymousAccess = registryInstall.steps.find(
    ({ name }) => name === "Verify anonymous registry access",
  );
  assert.match(anonymousAccess.run, /HELM_REGISTRY_CONFIG/);
  assert.match(anonymousAccess.run, /DOCKER_CONFIG/);
  assert.match(anonymousAccess.run, /release-manifest\.json/);
  assert.match(anonymousAccess.run, /ghcr\.io\/token/);
  assert.match(anonymousAccess.run, /\.images \| to_entries/);
  const install = registryInstall.steps.find(
    ({ name }) => name === "Install only from the OCI registry",
  );
  const quickstartValues = registryInstall.steps.find(
    ({ name }) => name === "Create isolated quickstart values",
  );
  const kindInstall = registryInstall.steps.find(({ name }) => name === "Install kind");
  assert.match(kindInstall.run, /curl -fsSLo \/tmp\/kind-linux-amd64/);
  assert.match(kindInstall.run, /sha256sum --check kind\.sha256sum/);
  assert.match(install.run, /helm pull oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(install.run, /helm install codeops oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(install.env.HELM_REGISTRY_CONFIG, /codeops-anonymous-home/);
  assert.match(install.env.DOCKER_CONFIG, /codeops-anonymous-docker/);
  assert.match(install.run, /--wait-for-jobs/);
  assert.match(install.run, /sourceCheckout:false/);
  assert.match(install.run, /kubectl wait --namespace codeops --for=condition=Available deployment --all/);
  assert.match(install.run, /session-control-gateway/);
  assert.match(install.run, /map\(sub\("@sha256:/);
  assert.match(install.run, /helm uninstall codeops/);
  assert.match(quickstartValues.run, /profile: "custom"/);
  assert.doesNotMatch(quickstartValues.run, /GHCR_TOKEN/);
  assert.doesNotMatch(quickstartValues.run, /registry:/);
  assert.match(quickstartValues.run, /temporal: \{ enabled: false, driver: "none", deployment: "none" \}/);
  assert.match(quickstartValues.run, /jetstream: \{ enabled: false, driver: "none", deployment: "none" \}/);
  assert.match(quickstartValues.run, /deployment: "none"/);
  assert.match(quickstartValues.run, /adapter: \{ enabled: false, onboardingRequired: false \}/);
  const diagnostics = registryInstall.steps.find(
    ({ name }) => name === "Capture registry-install diagnostics",
  );
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /helm status codeops/);
  assert.match(diagnostics.run, /kubectl get deployment,statefulset,job,pod,pvc/);
  const serialized = JSON.stringify(workflow);
  assert.match(serialized, /Reject artifact identity reuse/);
  assert.match(serialized, /refs\/remotes\/origin\/main/);
  assert.match(serialized, /refusing to overwrite existing image identity/);
  assert.match(serialized, /refusing to overwrite existing chart version/);
  assert.match(serialized, /refusing to overwrite existing GitHub Release/);
  assert.match(serialized, /oci:\/\/ghcr\.io\/anulman\/codeops\/charts/);
  assert.match(serialized, /codeops-release-images\.mjs/);
  assert.match(serialized, /codeops-release-chart\.mjs/);
  assert.match(serialized, /nub run prepare:chart/);
  const dependencyResolver = await readFile(
    new URL("./prepare-codeops-chart-dependencies.mjs", import.meta.url),
    "utf8",
  );
  assert.match(dependencyResolver, /helmWithRetry/);
  assert.match(dependencyResolver, /attempts = 5/);
  assert.match(serialized, /helm package \.release\/chart/);
  assert.match(serialized, /release-manifest\.json/);
  assert.match(serialized, /values\.release\.yaml/);
  assert.match(serialized, /Download exact image license evidence/);
  assert.match(serialized, /Verify complete image license evidence/);
  assert.match(serialized, /sbom-\$\{\{ matrix\.image \}\}\.spdx\.json/);
  assert.match(serialized, /license-policy-\$\{\{ matrix\.image \}\}\.json/);
  assert.match(serialized, /sha256sum/);
  const githubRelease = workflow.jobs["github-release"];
  assert.equal(githubRelease.if, "needs.validate.outputs.publish == 'true'");
  assert.deepEqual(githubRelease.needs, ["validate", "registry-install"]);
  assert.equal(githubRelease.permissions.contents, "write");
  assert.equal(githubRelease.permissions.actions, "read");
  const downloadRelease = githubRelease.steps.find(
    ({ name }) => name === "Download exact release evidence",
  );
  assert.equal(downloadRelease.uses, "actions/download-artifact@v4");
  const publishRelease = githubRelease.steps.find(
    ({ name }) => name === "Publish durable GitHub Release",
  );
  assert.match(publishRelease.run, /gh release create/);
  assert.match(publishRelease.run, /--target "\$SOURCE_SHA"/);
  assert.doesNotMatch(publishRelease.run, /--prerelease/);
  assert.match(publishRelease.run, /release\/\*/);
  assert.doesNotMatch(serialized, /example-repository\/example-repository-codeops/);
});
