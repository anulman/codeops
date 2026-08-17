#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateCodeOpsReleaseVersion } from "./codeops-release-version.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeConsumerLock({
  releaseRepository,
  releaseTag,
  chartPath,
  releaseManifestPath,
  outputPath,
}) {
  const [chartBytes, manifestBytes] = await Promise.all([
    readFile(chartPath),
    readFile(releaseManifestPath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== "codeops.release-images/v1") {
    throw new Error("release manifest schema is not supported");
  }
  if (!releaseTag.startsWith("v")) {
    throw new Error("release tag must have a v prefix");
  }
  validateCodeOpsReleaseVersion(releaseTag.slice(1));
  if (releaseTag !== `v${manifest.chart.version}`) {
    throw new Error("release tag and chart version differ");
  }
  const lock = {
    schemaVersion: "codeops.consumer-lock/v1",
    release: {
      repository: releaseRepository,
      tag: releaseTag,
      sourceSha: manifest.sourceSha,
      manifestAsset: "release-manifest.json",
      manifestSha256: sha256(manifestBytes),
    },
    chart: {
      repository: manifest.chart.repository,
      version: manifest.chart.version,
      digest: manifest.chart.digest,
      asset: `codeops-${manifest.chart.version}.tgz`,
      packageSha256: sha256(chartBytes),
    },
  };
  await writeFile(outputPath, `${JSON.stringify(lock, null, 2)}\n`, {
    flag: "wx",
  });
  return lock;
}

async function main() {
  const [chartPath, releaseManifestPath, outputPath] = process.argv.slice(2);
  if (!chartPath || !releaseManifestPath || !outputPath) {
    throw new Error(
      "usage: codeops-release-consumer-lock <chart.tgz> <release-manifest.json> <output.json>",
    );
  }
  const releaseRepository = process.env.GITHUB_REPOSITORY ?? "anulman/codeops";
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag) throw new Error("RELEASE_TAG is required");
  const lock = await writeConsumerLock({
    releaseRepository,
    releaseTag,
    chartPath,
    releaseManifestPath,
    outputPath,
  });
  process.stdout.write(`${JSON.stringify(lock)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
