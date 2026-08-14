import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeConsumerLock } from "./codeops-release-consumer-lock.mjs";

test("writes the small immutable downstream lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeops-consumer-lock-"));
  const chartPath = join(directory, "codeops-1.2.3.tgz");
  const manifestPath = join(directory, "release-manifest.json");
  const outputPath = join(directory, "codeops-consumer-lock.json");
  await writeFile(chartPath, "chart-bytes");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: "codeops.release-images/v1",
      sourceSha: "a".repeat(40),
      images: {},
      chart: {
        repository: "oci://ghcr.io/anulman/codeops/charts/codeops",
        version: "1.2.3",
        digest: `sha256:${"b".repeat(64)}`,
      },
    })}\n`,
  );
  const lock = await writeConsumerLock({
    releaseRepository: "anulman/codeops",
    releaseTag: "v1.2.3",
    chartPath,
    releaseManifestPath: manifestPath,
    outputPath,
  });
  assert.equal(lock.schemaVersion, "codeops.consumer-lock/v1");
  assert.equal(lock.release.sourceSha, "a".repeat(40));
  assert.match(lock.release.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(lock.chart.packageSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(lock, "images"), false);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), lock);
});

test("writes a structured prerelease downstream lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeops-consumer-lock-"));
  const version = "1.2.3-alpha.0";
  const chartPath = join(directory, `codeops-${version}.tgz`);
  const manifestPath = join(directory, "release-manifest.json");
  const outputPath = join(directory, "codeops-consumer-lock.json");
  await writeFile(chartPath, "chart-bytes");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: "codeops.release-images/v1",
      sourceSha: "a".repeat(40),
      images: {},
      chart: {
        repository: "oci://ghcr.io/anulman/codeops/charts/codeops",
        version,
        digest: `sha256:${"b".repeat(64)}`,
      },
    }),
  );
  const lock = await writeConsumerLock({
    releaseRepository: "anulman/codeops",
    releaseTag: `v${version}`,
    chartPath,
    releaseManifestPath: manifestPath,
    outputPath,
  });
  assert.equal(lock.release.tag, "v1.2.3-alpha.0");
  assert.equal(lock.chart.asset, "codeops-1.2.3-alpha.0.tgz");
});

test("rejects a tag that differs from the chart version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeops-consumer-lock-"));
  const chartPath = join(directory, "chart.tgz");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(chartPath, "chart");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: "codeops.release-images/v1",
      sourceSha: "a".repeat(40),
      chart: { version: "1.2.3" },
    }),
  );
  await assert.rejects(
    writeConsumerLock({
      releaseRepository: "anulman/codeops",
      releaseTag: "v1.2.4",
      chartPath,
      releaseManifestPath: manifestPath,
      outputPath: join(directory, "lock.json"),
    }),
    /release tag and chart version differ/,
  );
});
