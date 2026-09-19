import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        licenseDeclared: "Apache-2.0",
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

test("accepts npm's declared Artistic-2.0 license", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sbomPath = path.join(directory, "sbom.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(sbomPath, JSON.stringify(sbom("Artistic-2.0", {
    name: "npm",
    versionInfo: "11.17.0",
  })));
  await execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.policy.javascriptLicenseAllowlist.includes("Artistic-2.0"), true);
  assert.equal(report.declaredLicenses["Artistic-2.0"], 1);
});

test("rejects missing, copyleft, and source-available JavaScript licenses", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const license of [
    "NOASSERTION",
    "GPL-2.0-only",
    "LGPL-3.0-only",
    "AGPL-3.0-only",
    "MPL-2.0",
    "EPL-2.0",
    "CDDL-1.0",
    "BUSL-1.1",
  ]) {
    const sbomPath = path.join(directory, `${license}.json`);
    await writeFile(sbomPath, JSON.stringify(sbom(license)));
    await assert.rejects(
      execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", `${sbomPath}.report`, "--subject", "example"]),
      /image license policy rejected/,
    );
  }
});

test("accepts only exact reviewed MPL exceptions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const acceptedPath = path.join(directory, "accepted.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(acceptedPath, JSON.stringify(sbom("MPL-2.0", {
    name: "lightningcss",
    versionInfo: "1.33.0",
  })));
  await execute(process.execPath, [policy.pathname, "--sbom", acceptedPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.policy.approvedCopyleftJavascriptExceptions["lightningcss@1.33.0"], "MPL-2.0");
  assert.equal(report.policy.approvedCopyleftJavascriptExceptions["lightningcss@1.32.0"], undefined);
  assert.equal(report.policy.approvedCopyleftJavascriptExceptions["web-push@3.6.7"], "MPL-2.0");

  const rejectedPath = path.join(directory, "rejected.json");
  await writeFile(rejectedPath, JSON.stringify(sbom("MPL-2.0", {
    name: "lightningcss",
    versionInfo: "1.34.0",
  })));
  await assert.rejects(
    execute(process.execPath, [policy.pathname, "--sbom", rejectedPath, "--report", `${rejectedPath}.report`, "--subject", "example"]),
    /lightningcss@1\.34\.0 \(MPL-2\.0\)/,
  );
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

test("normalizes an exact reviewed non-SPDX license alias", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-license-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sbomPath = path.join(directory, "sbom.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(sbomPath, JSON.stringify(sbom("BSD", { name: "css-mediaquery", versionInfo: "0.1.2" })));
  await execute(process.execPath, [policy.pathname, "--sbom", sbomPath, "--report", reportPath, "--subject", "example"]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.appliedOverrides, [
    { package: "css-mediaquery@0.1.2", license: "BSD-3-Clause", evidence: "LICENSE file in the distributed package" },
  ]);
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


test("workspace missing licenses require an exact reviewed override", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-workspace-license-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["packages", "services", "sites"]) {
    await mkdir(path.join(directory, name), { recursive: true });
  }
  for (const file of [
    "package.json", "LICENSE", "CONTRIBUTING.md", "LICENSE_POLICY.md",
    "THIRD_PARTY_NOTICES.md", "infra/charts/codeops/LICENSE",
    "infra/charts/codeops/THIRD_PARTY_NOTICES.md",
    "infra/charts/codeops/licenses/NATS-CHART-APACHE-2.0.txt",
    "infra/charts/codeops/licenses/TEMPORAL-CHART-MIT.txt",
    "infra/charts/codeops/licenses/PLANE-CHART-AGPL-3.0.txt",
    "sites/agents-ui/src/components/AppShell.tsx", "config/project-context/AGENTS.md",
    "infra/charts/codeops/files/project-context/AGENTS.md",
    "infra/charts/codeops/Chart.yaml", "infra/license-policy/npm-license-overrides.json",
  ]) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(file));
  }
  const manifest = path.join(directory, "node_modules/.nub/sdk/node_modules/@get-bb/plugin-sdk/package.json");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: "@get-bb/plugin-sdk", version: "0.4.87" }));
  await execute(process.execPath, [policy.pathname, "--workspace"], { cwd: directory });
  await writeFile(manifest, JSON.stringify({ name: "@get-bb/plugin-sdk", version: "0.4.88" }));
  await assert.rejects(execute(process.execPath, [policy.pathname, "--workspace"], { cwd: directory }),
    /JavaScript dependency has no reviewed license: @get-bb\/plugin-sdk@0\.4\.88/);
});
