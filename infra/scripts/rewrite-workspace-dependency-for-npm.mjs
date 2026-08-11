import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const dependencyName = "@codeops/codeops-contracts";
const workspaceSpecifier = "workspace:*";
const npmSpecifier = "file:../../packages/codeops-contracts";

export async function rewriteWorkspaceDependencyForNpm(packagePath) {
  const source = await readFile(packagePath, "utf8");
  const manifest = JSON.parse(source);
  const current = manifest.dependencies?.[dependencyName];

  if (current !== workspaceSpecifier) {
    throw new Error(
      `${packagePath}: expected ${dependencyName}=${workspaceSpecifier}, got ${String(current)}`,
    );
  }

  manifest.dependencies[dependencyName] = npmSpecifier;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packagePath = process.argv[2];
  if (!packagePath || process.argv.length !== 3) {
    throw new Error("usage: rewrite-workspace-dependency-for-npm.mjs <package.json>");
  }
  await rewriteWorkspaceDependencyForNpm(packagePath);
}
