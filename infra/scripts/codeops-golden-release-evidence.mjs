#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CODEOPS_RELEASE_VERSION_PATTERN } from "./codeops-release-version.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CHART_REPOSITORY = "oci://ghcr.io/anulman/codeops/charts/codeops";
const IMAGE_NAMES = Object.freeze([
  "acceptance-runner",
  "agent",
  "agents-ui",
  "control-gateway",
  "model-proxy",
  "orchestrator",
  "plane-controller",
  "session-control-gateway",
  "session-gateway",
  "session-runtime-worker",
]);
const DEPLOYED_IMAGE_NAMES = Object.freeze([
  "agents-ui",
  "control-gateway",
  "model-proxy",
  "session-control-gateway",
]);
const SCENARIO_IDS = Object.freeze([
  "launch-exact-source",
  "work-item-read-search",
  "github-bounded-reads",
  "checkpoint-resume",
  "plane-steering",
  "approved-mutation",
  "permission-denial",
  "stale-write-recovery",
  "validation-recovery",
  "cleanup-isolation",
  "lifecycle-relay",
]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  object(value, name);
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function exactArray(value, expected, name) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${name} has the wrong cardinality`);
  }
  if (value.join(",") !== expected.join(",")) {
    throw new Error(`${name} identity drifted`);
  }
}

function validateEvidenceDeclaration(value, name) {
  const evidence = object(value, name);
  switch (evidence.kind) {
    case "simulated-provider":
      exactKeys(evidence, ["kind", "providerMode"], name);
      if (evidence.providerMode !== "fake") throw new Error(`${name} is invalid`);
      break;
    case "browser-acceptance":
      exactKeys(evidence, ["kind", "providerDelivery"], name);
      if (evidence.providerDelivery !== false) throw new Error(`${name} is invalid`);
      break;
    case "released-image":
      exactKeys(evidence, ["kind", "sourceCheckout", "immutableImageRefs"], name);
      if (evidence.sourceCheckout !== false || evidence.immutableImageRefs !== true) {
        throw new Error(`${name} is invalid`);
      }
      break;
    case "live-provider":
      exactKeys(evidence, ["kind", "providerDelivery", "authorizationMode"], name);
      if (evidence.providerDelivery !== true || evidence.authorizationMode !== "explicit") {
        throw new Error(`${name} is invalid`);
      }
      break;
    default:
      throw new Error(`${name} kind is unsupported`);
  }
  return evidence;
}

function requireEvidenceKind(value, expectedKind, name) {
  const evidence = validateEvidenceDeclaration(value, name);
  if (evidence.kind !== expectedKind) {
    throw new Error(`${name} must be ${expectedKind}`);
  }
  return evidence;
}

function releaseImages(manifest) {
  if (manifest.version !== "codeops.release-images/v1" || !SHA.test(manifest.sourceSha ?? "")) {
    throw new Error("release manifest identity is invalid");
  }
  if (
    manifest.chart?.repository !== CHART_REPOSITORY ||
    !CODEOPS_RELEASE_VERSION_PATTERN.test(manifest.chart?.version ?? "") ||
    !DIGEST.test(manifest.chart?.digest ?? "") ||
    manifest.chart?.immutableRef !== `${CHART_REPOSITORY}@${manifest.chart?.digest}`
  ) {
    throw new Error("release chart identity is invalid");
  }
  const names = Object.keys(object(manifest.images, "release images")).sort();
  exactArray(names, [...IMAGE_NAMES].sort(), "release image set");
  return new Map(IMAGE_NAMES.map((name) => {
    const image = object(manifest.images[name], `${name} release image`);
    const repository = `ghcr.io/anulman/codeops/${name}`;
    if (
      image.repository !== repository ||
      image.sourceRef !== `${repository}:sha-${manifest.sourceSha}` ||
      !DIGEST.test(image.digest ?? "") ||
      image.immutableRef !== `${repository}@${image.digest}`
    ) {
      throw new Error(`${name} release image identity is invalid`);
    }
    return [name, image.immutableRef];
  }));
}

function validateGoldenSource(report, sourceSha) {
  exactKeys(
    report,
    ["version", "evidence", "telemetry", "passed", "scenarioCount", "scenarios", "sourceSha"],
    "golden source report",
  );
  if (
    report.version !== "codeops.golden-dogfood-report/v2" ||
    report.telemetry !== "operational-only" ||
    report.passed !== true ||
    report.sourceSha !== sourceSha ||
    report.scenarioCount !== SCENARIO_IDS.length
  ) {
    throw new Error("golden source report did not pass for the release source");
  }
  requireEvidenceKind(report.evidence, "simulated-provider", "golden source evidence");
  if (!Array.isArray(report.scenarios)) throw new Error("golden source scenarios are invalid");
  const ids = [];
  for (const scenario of report.scenarios) {
    exactKeys(scenario, ["id", "status", "durationMs"], "golden source scenario");
    if (
      scenario.status !== "passed" ||
      !Number.isSafeInteger(scenario.durationMs) ||
      scenario.durationMs < 0 ||
      scenario.durationMs > 60 * 60_000
    ) {
      throw new Error("golden source scenario did not pass within bounds");
    }
    ids.push(scenario.id);
  }
  exactArray(ids, SCENARIO_IDS, "golden source scenarios");
}

function validateRegistryAccess(evidence, manifest, images) {
  exactKeys(
    evidence,
    ["version", "sourceSha", "sourceCheckout", "imageCount", "images"],
    "registry access evidence",
  );
  if (
    evidence.version !== "codeops.registry-access/v1" ||
    evidence.sourceSha !== manifest.sourceSha ||
    evidence.sourceCheckout !== false ||
    evidence.imageCount !== IMAGE_NAMES.length ||
    !Array.isArray(evidence.images)
  ) {
    throw new Error("registry access evidence identity is invalid");
  }
  exactArray(evidence.images.map(({ name }) => name), IMAGE_NAMES, "registry access images");
  for (const current of evidence.images) {
    exactKeys(current, ["name", "immutableRef"], "registry access image");
    if (current.immutableRef !== images.get(current.name)) {
      throw new Error("registry access image drifted from the release manifest");
    }
  }
}

function validateInstall(evidence, manifest) {
  exactKeys(
    evidence,
    ["version", "releaseVersion", "sourceSha", "chartDigest", "installStatus", "rollbackStatus", "cleanupStatus", "sourceCheckout"],
    "registry install evidence",
  );
  if (
    evidence.version !== "codeops.registry-install/v1" ||
    evidence.releaseVersion !== manifest.chart.version ||
    evidence.sourceSha !== manifest.sourceSha ||
    evidence.chartDigest !== manifest.chart.digest ||
    evidence.installStatus !== "deployed" ||
    evidence.rollbackStatus !== "passed" ||
    evidence.cleanupStatus !== "passed" ||
    evidence.sourceCheckout !== false
  ) {
    throw new Error("registry install evidence did not prove install, rollback, and cleanup");
  }
}

function validateLiveImages(evidence, manifest, images) {
  exactKeys(evidence, ["version", "sourceSha", "release", "namespace", "images"], "live image evidence");
  if (
    evidence.version !== "codeops.live-images/v1" ||
    evidence.sourceSha !== manifest.sourceSha ||
    evidence.release !== "proof-system" ||
    evidence.namespace !== "proof-system" ||
    !Array.isArray(evidence.images)
  ) {
    throw new Error("live image evidence identity is invalid");
  }
  exactArray(evidence.images.map(({ name }) => name), DEPLOYED_IMAGE_NAMES, "live image set");
  for (const current of evidence.images) {
    exactKeys(current, ["name", "immutableRef"], "live image");
    if (current.immutableRef !== images.get(current.name)) {
      throw new Error("live image drifted from the release manifest");
    }
  }
}

function validateSmoke(smoke, manifest) {
  exactKeys(smoke, ["schemaVersion", "ok", "release", "summary", "checks"], "smoke report");
  if (
    smoke.schemaVersion !== "codeops.smoke/v1" ||
    smoke.ok !== true ||
    smoke.release?.name !== "proof-system" ||
    smoke.release?.namespace !== "proof-system" ||
    smoke.release?.status !== "deployed" ||
    smoke.release?.appVersion !== manifest.sourceSha ||
    smoke.summary?.failed !== 0 ||
    !Array.isArray(smoke.checks)
  ) {
    throw new Error("disposable-cluster smoke did not pass for the release source");
  }
}

export function buildGoldenReleaseEvidence(input) {
  const manifest = object(input.releaseManifest, "release manifest");
  const images = releaseImages(manifest);
  validateGoldenSource(object(input.goldenSourceReport, "golden source report"), manifest.sourceSha);
  validateRegistryAccess(object(input.registryAccessEvidence, "registry access evidence"), manifest, images);
  validateInstall(object(input.registryInstallEvidence, "registry install evidence"), manifest);
  validateLiveImages(object(input.liveImageEvidence, "live image evidence"), manifest, images);
  validateSmoke(object(input.smokeReport, "smoke report"), manifest);

  return Object.freeze({
    version: "codeops.golden-release-report/v2",
    passed: true,
    telemetry: "operational-only",
    sourceSha: manifest.sourceSha,
    sourceProof: {
      evidence: {
        kind: "simulated-provider",
        providerMode: "fake",
      },
      scenarioCount: SCENARIO_IDS.length,
      scenarios: input.goldenSourceReport.scenarios.map(({ id, status, durationMs }) => ({
        id,
        status,
        durationMs,
      })),
    },
    artifactProof: {
      evidence: {
        kind: "released-image",
        sourceCheckout: false,
        immutableImageRefs: true,
      },
      chartVersion: manifest.chart.version,
      chartDigest: manifest.chart.digest,
      anonymousRegistryImages: IMAGE_NAMES.length,
      deployedImages: DEPLOYED_IMAGE_NAMES.length,
      images: IMAGE_NAMES.map((name) => ({
        name,
        immutableRef: images.get(name),
        liveDeployment: DEPLOYED_IMAGE_NAMES.includes(name),
      })),
      smokeStatus: "passed",
      rollbackStatus: "passed",
      cleanupStatus: "passed",
      sourceCheckout: false,
    },
  });
}

async function main() {
  const [goldenPath, manifestPath, registryPath, installPath, livePath, smokePath, outputPath] =
    process.argv.slice(2);
  if (!goldenPath || !manifestPath || !registryPath || !installPath || !livePath || !smokePath || !outputPath) {
    throw new Error("usage: codeops-golden-release-evidence <golden.json> <manifest.json> <registry.json> <install.json> <live.json> <smoke.json> <output.json>");
  }
  const [goldenSourceReport, releaseManifest, registryAccessEvidence, registryInstallEvidence, liveImageEvidence, smokeReport] =
    await Promise.all([goldenPath, manifestPath, registryPath, installPath, livePath, smokePath].map(async (file) =>
      JSON.parse(await readFile(file, "utf8"))));
  const report = buildGoldenReleaseEvidence({
    goldenSourceReport,
    releaseManifest,
    registryAccessEvidence,
    registryInstallEvidence,
    liveImageEvidence,
    smokeReport,
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
