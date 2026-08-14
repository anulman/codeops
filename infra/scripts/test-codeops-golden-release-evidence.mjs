import assert from "node:assert/strict";
import test from "node:test";
import { buildGoldenReleaseEvidence } from "./codeops-golden-release-evidence.mjs";

const sourceSha = "a".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const names = [
  "acceptance-runner", "agent", "agents-ui", "control-gateway", "model-proxy",
  "orchestrator", "plane-controller", "session-control-gateway", "session-gateway",
  "session-runtime-worker",
];
const deployed = ["agents-ui", "control-gateway", "model-proxy", "session-control-gateway"];
const scenarioIds = [
  "launch-exact-source", "work-item-read-search", "github-bounded-reads",
  "checkpoint-resume", "plane-steering", "approved-mutation", "permission-denial",
  "stale-write-recovery", "validation-recovery", "cleanup-isolation",
  "notification-delivery",
];
const images = Object.fromEntries(names.map((name, index) => {
  const repository = `ghcr.io/anulman/codeops/${name}`;
  const imageDigest = digest((index + 1).toString(16));
  return [name, {
    repository,
    sourceRef: `${repository}:sha-${sourceSha}`,
    digest: imageDigest,
    immutableRef: `${repository}@${imageDigest}`,
  }];
}));

function fixture() {
  return {
    goldenSourceReport: {
      version: "codeops.golden-dogfood-report/v1",
      adapterMode: "fake",
      telemetry: "operational-only",
      passed: true,
      sourceSha,
      scenarioCount: scenarioIds.length,
      scenarios: scenarioIds.map((id, index) => ({ id, status: "passed", durationMs: index + 1 })),
    },
    releaseManifest: {
      version: "codeops.release-images/v1",
      sourceSha,
      images,
      values: {},
      chart: {
        repository: "oci://ghcr.io/anulman/codeops/charts/codeops",
        version: "0.5.0",
        digest: digest("b"),
        immutableRef: `oci://ghcr.io/anulman/codeops/charts/codeops@${digest("b")}`,
      },
    },
    registryAccessEvidence: {
      version: "codeops.registry-access/v1",
      sourceSha,
      sourceCheckout: false,
      imageCount: names.length,
      images: names.map((name) => ({ name, immutableRef: images[name].immutableRef })),
    },
    registryInstallEvidence: {
      version: "codeops.registry-install/v1",
      releaseVersion: "0.5.0",
      sourceSha,
      chartDigest: digest("b"),
      installStatus: "deployed",
      rollbackStatus: "passed",
      cleanupStatus: "passed",
      sourceCheckout: false,
    },
    liveImageEvidence: {
      version: "codeops.live-images/v1",
      sourceSha,
      release: "proof-system",
      namespace: "proof-system",
      images: deployed.map((name) => ({ name, immutableRef: images[name].immutableRef })),
    },
    smokeReport: {
      schemaVersion: "codeops.smoke/v1",
      ok: true,
      release: {
        name: "proof-system",
        namespace: "proof-system",
        status: "deployed",
        revision: "2",
        chart: "codeops-0.5.0",
        appVersion: sourceSha,
      },
      summary: { passed: 7, failed: 0, skipped: 3 },
      checks: [],
    },
  };
}

test("binds source scenarios to exact released-image cluster evidence", () => {
  const report = buildGoldenReleaseEvidence(fixture());
  assert.equal(report.version, "codeops.golden-release-report/v1");
  assert.equal(report.passed, true);
  assert.equal(report.sourceProof.scenarioCount, 11);
  assert.equal(report.artifactProof.anonymousRegistryImages, 10);
  assert.equal(report.artifactProof.deployedImages, 4);
  assert.deepEqual(report.artifactProof.images.map(({ name }) => name), names);
  assert.equal(report.artifactProof.images.find(({ name }) => name === "agents-ui").liveDeployment, true);
  assert.equal(report.artifactProof.images.find(({ name }) => name === "agent").liveDeployment, false);
  assert.equal(report.artifactProof.images[0].immutableRef, images["acceptance-runner"].immutableRef);
  assert.equal(report.artifactProof.sourceCheckout, false);
  for (const forbidden of ["prompt", "body", "diff", "log", "attachment", "token", "credential", "secret"]) {
    assert.equal(JSON.stringify(report).toLowerCase().includes(forbidden), false);
  }
});

test("rejects failed scenarios and source, chart, image, or smoke drift", () => {
  const failed = fixture();
  failed.goldenSourceReport.scenarios[0].status = "failed";
  assert.throws(() => buildGoldenReleaseEvidence(failed), /scenario did not pass/);

  const sourceDrift = fixture();
  sourceDrift.registryInstallEvidence.sourceSha = "b".repeat(40);
  assert.throws(() => buildGoldenReleaseEvidence(sourceDrift), /install evidence/);

  const chartDrift = fixture();
  chartDrift.registryInstallEvidence.chartDigest = digest("c");
  assert.throws(() => buildGoldenReleaseEvidence(chartDrift), /install evidence/);

  const chartRepositoryDrift = fixture();
  chartRepositoryDrift.releaseManifest.chart.repository = "oci://ghcr.io/example/codeops";
  assert.throws(() => buildGoldenReleaseEvidence(chartRepositoryDrift), /chart identity/);

  const imageDrift = fixture();
  imageDrift.liveImageEvidence.images[0].immutableRef = `${images.agent.repository}@${images.agent.digest}`;
  assert.throws(() => buildGoldenReleaseEvidence(imageDrift), /live image drifted/);

  const smokeFailure = fixture();
  smokeFailure.smokeReport.ok = false;
  smokeFailure.smokeReport.summary.failed = 1;
  assert.throws(() => buildGoldenReleaseEvidence(smokeFailure), /smoke did not pass/);
});

test("rejects retained source, incomplete cleanup, and unsupported evidence fields", () => {
  const retainedSource = fixture();
  retainedSource.registryAccessEvidence.sourceCheckout = true;
  assert.throws(() => buildGoldenReleaseEvidence(retainedSource), /registry access evidence/);

  const incompleteCleanup = fixture();
  incompleteCleanup.registryInstallEvidence.cleanupStatus = "pending";
  assert.throws(() => buildGoldenReleaseEvidence(incompleteCleanup), /install, rollback, and cleanup/);

  const unsupported = fixture();
  unsupported.goldenSourceReport.prompt = "must not pass";
  assert.throws(() => buildGoldenReleaseEvidence(unsupported), /unsupported fields/);
});
