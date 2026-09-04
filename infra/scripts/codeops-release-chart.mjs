#!/usr/bin/env node

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const allowedLeafPaths = new Set([
  "agentsUi.image.repository",
  "agentsUi.image.digest",
  "gateway.image.repository",
  "gateway.image.digest",
  "controlGateway.image.repository",
  "controlGateway.image.digest",
  "lifecycleRelay.image.repository",
  "lifecycleRelay.image.digest",
  "modelProxy.image.repository",
  "modelProxy.image.digest",
  "orchestrator.image.repository",
  "orchestrator.image.digest",
  "githubController.image.repository",
  "githubController.image.digest",
  "githubController.controlPlaneSha",
  "postgresql.image.repository",
  "postgresql.image.digest",
  "runtime.workerImage.repository",
  "runtime.workerImage.digest",
  "runtime.agentImage.repository",
  "runtime.agentImage.digest",
  "runtime.sessionGatewayImage.repository",
  "runtime.sessionGatewayImage.digest",
  "runtime.releaseDigest",
]);

function leaves(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`release chart value path does not exist: ${dottedPath}`);
    }
    cursor = next;
  }
  const leaf = parts.at(-1);
  if (!(leaf in cursor)) {
    throw new Error(`release chart value path does not exist: ${dottedPath}`);
  }
  cursor[leaf] = value;
}

export async function prepareCodeOpsReleaseChart({ chartRoot, releaseValuesPath, outputRoot }) {
  const outputExists = await stat(outputRoot).then(() => true, () => false);
  if (outputExists) throw new Error("release chart output already exists");
  const [sourceValues, releaseValues] = await Promise.all([
    readFile(path.join(chartRoot, "values.yaml"), "utf8").then(parse),
    readFile(releaseValuesPath, "utf8").then(parse),
  ]);
  const releaseLeaves = leaves(releaseValues);
  const releasePaths = new Set(releaseLeaves.map(([leafPath]) => leafPath));
  if (
    releasePaths.size !== allowedLeafPaths.size ||
    [...releasePaths].some((leafPath) => !allowedLeafPaths.has(leafPath))
  ) {
    throw new Error("release chart values must contain only the exact immutable release identity");
  }
  for (const [leafPath, value] of releaseLeaves) setPath(sourceValues, leafPath, value);

  await mkdir(path.dirname(outputRoot), { recursive: true });
  await cp(chartRoot, outputRoot, { recursive: true, errorOnExist: true });
  await writeFile(path.join(outputRoot, "values.yaml"), stringify(sourceValues), { flag: "w" });
  return { outputRoot, embeddedPaths: [...releasePaths].sort() };
}

async function main() {
  const [chartRoot, releaseValuesPath, outputRoot] = process.argv.slice(2);
  if (!chartRoot || !releaseValuesPath || !outputRoot) {
    throw new Error("usage: codeops-release-chart <chart-root> <release-values.yaml> <output-root>");
  }
  process.stdout.write(`${JSON.stringify(await prepareCodeOpsReleaseChart({ chartRoot, releaseValuesPath, outputRoot }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
