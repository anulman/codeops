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
  assert.ok(workflow.on.push.paths.includes("infra/scripts/codeopsctl.mjs"));
  assert.ok(workflow.on.push.paths.includes("infra/scripts/codeops-golden-release-evidence.mjs"));
  assert.ok(workflow.on.push.paths.includes("infra/scripts/codeops-agent-execution-proof.mjs"));
  assert.ok(workflow.on.push.paths.includes("infra/scripts/test-codeops-agent-execution-proof.mjs"));
  assert.ok(workflow.on.push.paths.includes("services/codeops-acceptance-runner/src/golden-dogfood.mjs"));
  assert.ok(workflow.on.push.paths.includes(".github/actions/codeops/action.yml"));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  const releaseIdentity = workflow.jobs.validate.steps.find(
    ({ name }) => name === "Validate release identity",
  );
  assert.match(releaseIdentity.run, /codeops-release-version\.mjs/);
  const goldenSource = workflow.jobs.validate.steps.find(
    ({ name }) => name === "Write exact golden source report",
  );
  assert.equal(goldenSource.if, "steps.release_identity.outputs.publish == 'true'");
  assert.match(goldenSource.run, /node services\/codeops-acceptance-runner\/src\/golden-dogfood\.mjs/);
  assert.match(goldenSource.run, /sourceSha/);
  assert.match(goldenSource.run, /codeops\.golden-dogfood-report\/v2/);
  assert.match(goldenSource.run, /simulated-provider/);
  const retainedGoldenSource = workflow.jobs.validate.steps.find(
    ({ name }) => name === "Retain exact golden source report",
  );
  assert.equal(
    retainedGoldenSource.uses,
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  );
  assert.equal(retainedGoldenSource.with.name, "codeops-golden-source-${{ github.sha }}");
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
  assert.equal(
    chartDockerLogin.uses,
    "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
  );
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
    registryInstall.steps.some(({ uses }) => uses?.startsWith("actions/checkout@")),
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
  assert.match(
    anonymousAccess.run,
    /\.sourceSha == \$sourceSha and \(\.images \| length\) == 10/,
  );
  assert.doesNotMatch(anonymousAccess.run, /if \. then empty/);
  assert.match(anonymousAccess.run, /codeops\.registry-access\/v1/);
  assert.match(anonymousAccess.run, /sourceCheckout:false/);
  const downloadGoldenSource = registryInstall.steps.find(
    ({ name }) => name === "Download exact golden source report",
  );
  assert.equal(
    downloadGoldenSource.with.name,
    "codeops-golden-source-${{ github.sha }}",
  );
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
  assert.match(install.run, /codeopsctl\.mjs deploy/);
  assert.match(install.run, /codeops-consumer-lock\.json/);
  assert.match(install.run, /codeops-consumer-policy\.json/);
  assert.match(install.env.HELM_REGISTRY_CONFIG, /codeops-anonymous-home/);
  assert.match(install.env.DOCKER_CONFIG, /codeops-anonymous-docker/);
  assert.equal(install.env.KUBECONFIG, "/home/runner/.kube/config");
  const operatorSource = await readFile(
    new URL("./codeopsctl.mjs", import.meta.url),
    "utf8",
  );
  assert.match(operatorSource, /--wait-for-jobs/);
  assert.match(operatorSource, /--atomic/);
  assert.match(install.run, /sourceCheckout:false/);
  assert.match(install.run, /kubectl wait --namespace proof-system --for=condition=Available deployment --all/);
  assert.match(install.run, /session-control-gateway/);
  assert.match(install.run, /map\(sub\("@sha256:/);
  assert.match(install.run, /--release proof-system/);
  assert.match(install.run, /--namespace proof-system/);
  assert.match(install.run, /post-deploy failure proof unexpectedly passed/);
  assert.match(install.run, /helm list --namespace proof-system --filter/);
  assert.match(install.run, /\.app_version/);
  assert.match(install.run, /codeops-\$\{RELEASE_VERSION\}/);
  assert.doesNotMatch(install.run, /\.chart\.metadata/);
  assert.match(install.run, /helm uninstall proof-system/);
  assert.match(install.run, /codeopsctl\.mjs smoke/);
  assert.match(install.run, /codeops\.live-images\/v1/);
  assert.match(install.run, /codeops\.registry-install\/v1/);
  assert.match(install.run, /rollbackStatus:"passed"/);
  assert.match(install.run, /cleanupStatus:"passed"/);
  assert.match(install.run, /codeops-golden-release-evidence\.mjs/);
  assert.match(install.run, /golden-release-report\.json/);
  assert.ok(
    install.run.indexOf("helm uninstall proof-system") <
      install.run.indexOf("codeops-golden-release-evidence.mjs"),
  );
  const agentExecution = registryInstall.steps.find(
    ({ name }) => name === "Prove provider-free Agent execution",
  );
  assert.match(agentExecution.run, /codeops-agent-execution-proof\.mjs/);
  assert.match(agentExecution.run, /release-manifest\.json/);
  assert.match(agentExecution.run, /agent-execution-proof\.json/);
  assert.ok(
    registryInstall.steps.indexOf(agentExecution) <
      registryInstall.steps.findIndex(({ name }) => name === "Retain registry-install evidence"),
  );
  assert.match(quickstartValues.run, /profile: "custom"/);
  assert.match(quickstartValues.run, /renoconcierge\.ca\/codeops/);
  assert.doesNotMatch(quickstartValues.run, /GHCR_TOKEN/);
  assert.doesNotMatch(quickstartValues.run, /registry:/);
  assert.match(quickstartValues.run, /temporal: \{ enabled: false, driver: "none", deployment: "none" \}/);
  assert.match(quickstartValues.run, /jetstream: \{ enabled: false, driver: "none", deployment: "none" \}/);
  assert.match(quickstartValues.run, /deployment: "none"/);
  assert.match(quickstartValues.run, /adapter: \{ enabled: false, onboardingRequired: false \}/);
  assert.match(quickstartValues.run, /codeops\.consumer-policy\/v1/);
  const diagnostics = registryInstall.steps.find(
    ({ name }) => name === "Capture registry-install diagnostics",
  );
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /helm status proof-system/);
  assert.match(diagnostics.run, /kubectl get deployment,statefulset,job,pod,pvc/);
  const serialized = JSON.stringify(workflow);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
    }
  }
  assert.match(serialized, /dd263aba5655a47d9e287cfff96775a856200f0ba20b916fc2919219a33db0dd/);
  assert.doesNotMatch(serialized, /install\.sh.*\|\s*bash/);
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
  assert.match(serialized, /codeops-release-consumer-lock\.mjs/);
  assert.match(
    serialized,
    /cp infra\/scripts\/codeops-release-version\.mjs.*\.release\/evidence\/codeops-release-version\.mjs/s,
  );
  assert.match(
    serialized,
    /cp infra\/scripts\/codeops-agent-execution-proof\.mjs.*\.release\/evidence\/codeops-agent-execution-proof\.mjs/s,
  );
  assert.match(serialized, /codeops-consumer-lock\.json/);
  assert.match(serialized, /codeopsctl\.mjs/);
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
  assert.equal(
    downloadRelease.uses,
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  );
  const downloadGoldenRelease = githubRelease.steps.find(
    ({ name }) => name === "Download exact golden released-image evidence",
  );
  assert.equal(
    downloadGoldenRelease.with.name,
    "codeops-registry-install-${{ needs.validate.outputs.release_version }}-${{ github.sha }}",
  );
  const bindGoldenRelease = githubRelease.steps.find(
    ({ name }) => name === "Bind golden released-image evidence to the release",
  );
  assert.match(bindGoldenRelease.run, /codeops\.golden-release-report\/v2/);
  assert.match(bindGoldenRelease.run, /sourceProof\.evidence/);
  assert.match(bindGoldenRelease.run, /artifactProof\.evidence/);
  assert.match(bindGoldenRelease.run, /simulated-provider/);
  assert.match(bindGoldenRelease.run, /released-image/);
  assert.match(bindGoldenRelease.run, /browser-acceptance/);
  assert.match(bindGoldenRelease.run, /live-provider/);
  assert.match(bindGoldenRelease.run, /golden-release-report\.json >> SHA256SUMS/);
  const publishRelease = githubRelease.steps.find(
    ({ name }) => name === "Publish durable GitHub Release",
  );
  assert.match(publishRelease.run, /gh release create/);
  assert.match(publishRelease.run, /--target "\$SOURCE_SHA"/);
  assert.match(publishRelease.run, /RELEASE_VERSION.*== \*-\*/s);
  assert.match(publishRelease.run, /--prerelease/);
  assert.match(publishRelease.run, /release\/\*/);
  assert.doesNotMatch(serialized, /example-repository\/example-repository-codeops/);
});
