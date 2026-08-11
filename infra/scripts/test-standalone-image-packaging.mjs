import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { rewriteWorkspaceDependencyForNpm } from "./rewrite-workspace-dependency-for-npm.mjs";

const dependencyName = "@codeops/codeops-contracts";
const dockerfiles = [
  "codeops-control-gateway.Dockerfile",
  "codeops-session-control-gateway.Dockerfile",
  "codeops-session-runtime-worker.Dockerfile",
  "codeops-plane-controller.Dockerfile",
  "codeops-orchestrator.Dockerfile",
];

test("packages the standalone browser acceptance runner", async () => {
  const filename = "codeops-acceptance-runner.Dockerfile";
  const source = await readFile(new URL(`../docker/${filename}`, import.meta.url), "utf8");
  const dockerignore = await readFile(
    new URL(`../docker/${filename}.dockerignore`, import.meta.url),
    "utf8",
  );
  assert.match(source, /mcr\.microsoft\.com\/playwright:v1\.61\.1-noble/);
  assert.match(source, /services\/codeops-acceptance-runner\/package-lock\.json/);
  assert.match(source, /ENTRYPOINT \["node", "src\/agents-ui-smoke\.mjs"\]/);
  assert.match(dockerignore, /^!services\/codeops-acceptance-runner\/src\/\*\*$/m);
});

test("rewrites only the exact workspace contract for isolated npm image installs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codeops-image-package-"));
  const packagePath = path.join(directory, "package.json");
  try {
    await writeFile(
      packagePath,
      JSON.stringify({ dependencies: { [dependencyName]: "workspace:*", zod: "4.1.5" } }),
    );
    await rewriteWorkspaceDependencyForNpm(packagePath);
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(
      manifest.dependencies[dependencyName],
      "file:../../packages/codeops-contracts",
    );
    assert.equal(manifest.dependencies.zod, "4.1.5");

    await assert.rejects(
      () => rewriteWorkspaceDependencyForNpm(packagePath),
      /expected @codeops\/codeops-contracts=workspace:\*/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packages the Agents UI from the frozen standalone workspace", async () => {
  const filename = "codeops-agents-ui.Dockerfile";
  const source = await readFile(new URL(`../docker/${filename}`, import.meta.url), "utf8");
  const dockerignore = await readFile(
    new URL(`../docker/${filename}.dockerignore`, import.meta.url),
    "utf8",
  );
  assert.match(source, /nub install --frozen-lockfile/);
  assert.match(source, /nub run --filter @codeops\/agents-ui build/);
  assert.match(source, /sites\/agents-ui\/\.output\/server\/index\.mjs/);
  assert.match(dockerignore, /^!lock\.yaml$/m);
  assert.match(dockerignore, /^!sites\/agents-ui\/src\/\*\*$/m);
});

test("rewrites every isolated npm service manifest before npm ci", async () => {
  for (const filename of dockerfiles) {
    const source = await readFile(new URL(`../docker/${filename}`, import.meta.url), "utf8");
    const dockerignore = await readFile(
      new URL(`../docker/${filename}.dockerignore`, import.meta.url),
      "utf8",
    );
    const rewrite = source.indexOf("rewrite-workspace-dependency-for-npm.mjs services/");
    const install = source.indexOf("npm ci --ignore-scripts --prefix services/");
    assert.notEqual(rewrite, -1, `${filename} must rewrite the workspace dependency`);
    assert.notEqual(install, -1, `${filename} must install the isolated service`);
    assert.ok(rewrite < install, `${filename} must rewrite before npm ci`);
    assert.match(
      dockerignore,
      /^!infra\/scripts\/rewrite-workspace-dependency-for-npm\.mjs$/m,
      `${filename} must include the rewrite helper in its build context`,
    );
  }
});
