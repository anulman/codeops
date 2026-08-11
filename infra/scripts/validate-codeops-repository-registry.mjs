#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadRepositoryPlaneRegistryFile } from "../../services/codeops-plane-controller/dist/repository-plane.js";
import { loadGitHubWebhookRegistryFile } from "../../services/codeops-plane-controller/dist/repository-webhooks.js";
import { loadProjectContextDocuments } from "../../services/codeops-plane-controller/dist/project-context.js";
import { loadRepositoryRegistryFile } from "../../services/codeops-control-gateway/dist/repository-registry.js";
import { loadGitHubSteeringRegistryFile } from "../../services/codeops-control-gateway/dist/repository-steering.js";

const authorityClasses = [
  "github.read",
  "github.write",
  "github.webhook",
  "github.steering",
  "plane.api",
  "plane.webhook",
  "plane.project",
  "plane.policy",
  "project-context.read",
];

function sameRepositories(expected, candidate) {
  return (
    expected.length === candidate.length &&
    expected.every((repository, index) => repository === candidate[index])
  );
}

export async function validateRepositoryRegistry(manifestPath) {
  const exactManifestPath = path.resolve(manifestPath);
  const snapshots = new Map();
  const readSnapshot = async (filePath) => {
    const cached = snapshots.get(filePath);
    if (cached !== undefined) return cached;
    const value = await readFile(filePath, "utf8");
    snapshots.set(filePath, value);
    return value;
  };

  const [runtime, steering, webhooks, plane] = await Promise.all([
    loadRepositoryRegistryFile(exactManifestPath, readSnapshot),
    loadGitHubSteeringRegistryFile(exactManifestPath, readSnapshot),
    loadGitHubWebhookRegistryFile(exactManifestPath, readSnapshot),
    loadRepositoryPlaneRegistryFile(exactManifestPath, readSnapshot),
  ]);
  for (const candidate of [steering, webhooks, plane]) {
    if (!sameRepositories(runtime.repositories, candidate.repositories)) {
      throw new Error("repository registry projections do not contain the same ordered identities");
    }
  }
  await Promise.all(
    plane.repositories.map((repository) =>
      loadProjectContextDocuments(
        plane.resolve(repository).policy.projectContextRoot,
      ),
    ),
  );

  const credentials = new Map();
  for (const [filePath, rawValue] of snapshots) {
    if (filePath === exactManifestPath) continue;
    const value = rawValue.trim();
    const priorPath = credentials.get(value);
    if (priorPath !== undefined && priorPath !== filePath) {
      throw new Error("repository registry credential values must be authority-scoped");
    }
    credentials.set(value, filePath);
  }

  const manifest = snapshots.get(exactManifestPath);
  if (manifest === undefined) {
    throw new Error("repository registry manifest was not read");
  }
  return {
    version: "codeops.repository-registry-validation/v1",
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    repositories: runtime.repositories.map((repository) => ({
      repository,
      authorityClasses,
    })),
  };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2]?.trim() === "") {
    throw new Error("usage: validate-codeops-repository-registry <manifest-path>");
  }
  process.stdout.write(`${JSON.stringify(await validateRepositoryRegistry(process.argv[2]), null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
