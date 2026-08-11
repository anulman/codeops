import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTwoRepositoryRegistryFixture } from "../fixtures/repository-registry/two-repository.mjs";
import { validateRepositoryRegistry } from "./validate-codeops-repository-registry.mjs";
import { projectContextDocumentPaths } from "../../services/codeops-plane-controller/dist/project-context.js";

const validatorPath = path.resolve("infra/scripts/validate-codeops-repository-registry.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-registry-"));
  const manifest = createTwoRepositoryRegistryFixture(root);
  const manifestPath = path.join(root, "registry.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  let credential = 0;
  for (const repository of manifest.repositories) {
    for (const filePath of [
      repository.readTokenFile,
      repository.writeTokenFile,
      repository.githubWebhookSecretFile,
      repository.githubSteeringTokenFile,
      repository.plane.apiKeyFile,
      repository.plane.webhookSecretFile,
    ]) {
      credential += 1;
      await writeFile(filePath, `fixture-${String(credential).padStart(2, "0")}-${"x".repeat(32)}`);
    }
    for (const documentPath of projectContextDocumentPaths) {
      const filePath = path.join(repository.policy.projectContextRoot, documentPath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `# ${repository.repository} ${documentPath}\n`);
    }
  }
  return { root, manifest, manifestPath };
}

test("validates one complete two-repository authority manifest offline", async (t) => {
  const input = await fixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const result = await validateRepositoryRegistry(input.manifestPath);
  assert.equal(result.version, "codeops.repository-registry-validation/v1");
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    result.repositories.map(({ repository }) => repository),
    ["example-org/example-repository", "anulman/codeops"],
  );
  assert.equal(result.repositories.every(({ authorityClasses }) => authorityClasses.length === 9), true);
  assert.equal(JSON.stringify(result).includes("fixture-"), false);
});

test("exposes the offline validator as a credential-safe command", async (t) => {
  const input = await fixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [validatorPath, input.manifestPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    JSON.parse(result.stdout).repositories.map(({ repository }) => repository),
    ["example-org/example-repository", "anulman/codeops"],
  );
  assert.equal(result.stdout.includes("fixture-"), false);

  const usage = spawnSync(process.execPath, [validatorPath], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: validate-codeops-repository-registry/);
});

test("rejects missing files and inline or malformed repository authority", async (t) => {
  const input = await fixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await rm(input.manifest.repositories[0].readTokenFile);
  await assert.rejects(validateRepositoryRegistry(input.manifestPath), /ENOENT/);

  const inline = createTwoRepositoryRegistryFixture(input.root);
  inline.repositories[0].readToken = "x".repeat(32);
  await writeFile(input.manifestPath, JSON.stringify(inline));
  await assert.rejects(validateRepositoryRegistry(input.manifestPath));

  delete inline.repositories[0].readToken;
  inline.repositories[0].repositoryUrl = "https://github.example.com/example-org/example-repository";
  await writeFile(input.manifestPath, JSON.stringify(inline));
  await assert.rejects(validateRepositoryRegistry(input.manifestPath), /GitHub HTTPS URL/);
});

test("rejects credential reuse across different authority classes", async (t) => {
  const input = await fixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const reused = "cross-authority-reuse-value-xxxxxxxxxxxxxxxx";
  await writeFile(input.manifest.repositories[0].readTokenFile, reused);
  await writeFile(input.manifest.repositories[1].plane.apiKeyFile, reused);
  await assert.rejects(
    validateRepositoryRegistry(input.manifestPath),
    /credential values must be authority-scoped/,
  );
});
