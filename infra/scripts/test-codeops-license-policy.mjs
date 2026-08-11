import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const policy = new URL("./check-codeops-license-policy.mjs", import.meta.url);

function sbom(license, dependency = { name: "dependency", versionInfo: "1.0.0" }) {
  return {
    spdxVersion: "SPDX-2.3",
    packages: [
      {
        name: "@codeops/example",
        versionInfo: "0.1.0",
        licenseDeclared: "AGPL-3.0-only",
        externalRefs: [{ referenceCategory: "PACKAGE_MANAGER", referenceType: "purl", referenceLocator: "pkg:npm/%40codeops/example@0.1.0" }],
      },
      {
        name: dependency.name,
        versionInfo: dependency.versionInfo,
        licenseDeclared: license,
        externalRefs: [{ referenceCategory: "PACKAGE_MANAGER", referenceType: "purl", referenceLocator: "pkg:npm/dependency@1.0.0" }],
      },
    ],
  };
}

test("writes one exact passing SPDX license-policy report", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sbomPath = path.join(directory, "sbom.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(sbomPath, JSON.stringify(sbom("MIT")));
  await execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schema, "codeops.license-policy-report/v1");
  assert.equal(report.subject, "example");
  assert.equal(report.packageCount, 2);
  assert.equal(report.javascriptPackageCount, 2);
  assert.equal(report.policy.result, "pass");
  assert.match(report.sbomSha256, /^[0-9a-f]{64}$/);
});

test("rejects missing and source-available JavaScript license identities", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const license of ["NOASSERTION", "BUSL-1.1"]) {
    const sbomPath = path.join(directory, `${license}.json`);
    await writeFile(sbomPath, JSON.stringify(sbom(license)));
    await assert.rejects(
      execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", `${sbomPath}.report`, "--subject", "example"]),
      /image license policy rejected/,
    );
  }
});

test("uses only an exact reviewed override for an unresolved package", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const acceptedPath = path.join(directory, "accepted.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(acceptedPath, JSON.stringify(sbom("NOASSERTION", { name: "semver", versionInfo: "7.8.5" })));
  await execute(process.execPath, [policy.pathname, "--sbom", acceptedPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.appliedOverrides, [
    { package: "semver@7.8.5", license: "ISC", evidence: "npm registry metadata" },
  ]);

  const rejectedPath = path.join(directory, "rejected.json");
  await writeFile(rejectedPath, JSON.stringify(sbom("NOASSERTION", { name: "semver", versionInfo: "7.8.6" })));
  await assert.rejects(
    execute(process.execPath, [policy.pathname, "--sbom", rejectedPath, "--report", `${rejectedPath}.report`, "--subject", "example"]),
    /semver@7\.8\.6 \(NOASSERTION\)/,
  );
});

test("derives an unresolved package subpath only from one declared parent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sbomPath = path.join(directory, "sbom.json");
  const reportPath = path.join(directory, "report.json");
  const document = sbom("Apache-2.0", { name: "rxjs", versionInfo: "7.8.2" });
  document.packages.push({
    name: "rxjs/ajax",
    versionInfo: "UNKNOWN",
    licenseDeclared: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE_MANAGER", referenceType: "purl", referenceLocator: "pkg:npm/rxjs/ajax" }],
  });
  await writeFile(sbomPath, JSON.stringify(document));
  await execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.derivedSubpaths, [
    { package: "rxjs/ajax@UNKNOWN", license: "Apache-2.0", evidence: "rxjs@7.8.2" },
  ]);
});
