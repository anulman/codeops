#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const CODEOPS_LICENSE = "Apache-2.0";
const ALLOWED_JAVASCRIPT_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND MIT",
  "(Apache-2.0 AND MIT)",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LicenseRef-Apache-2.0",
  "MIT",
  "Python-2.0",
  "Unlicense",
]);
const APPROVED_COPYLEFT_JAVASCRIPT_EXCEPTIONS = new Map([
  ["lightningcss@1.32.0", "MPL-2.0"],
  ["lightningcss-linux-x64-gnu@1.32.0", "MPL-2.0"],
  ["lightningcss@1.33.0", "MPL-2.0"],
  ["lightningcss-linux-x64-gnu@1.33.0", "MPL-2.0"],
  ["web-push@3.6.7", "MPL-2.0"],
]);
const REJECTED_LICENSE_PATTERN = /(?:BUSL|SSPL|Elastic-License|Commons-Clause|PolyForm|Proprietary|UNLICENSED|SEE LICENSE)/i;
const LICENSE_OVERRIDES_PATH = join(
  process.cwd(),
  "infra/license-policy/npm-license-overrides.json",
);

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertFile(path, expectedText) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`required license artifact is missing: ${path}`);
  }
  const content = readFileSync(path, "utf8");
  if (expectedText && !content.includes(expectedText)) {
    fail(`license artifact does not contain its required identity: ${path}`);
  }
}

function ownPackageManifests(root) {
  const manifests = [join(root, "package.json")];
  for (const directory of ["packages", "services", "sites"]) {
    const parent = join(root, directory);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(parent, entry.name, "package.json");
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests.sort();
}

function installedPackageRoots(root) {
  const store = join(root, "node_modules", ".nub");
  if (!existsSync(store)) {
    fail("node_modules/.nub is missing; run nub install --frozen-lockfile first");
  }
  const roots = [];
  for (const stored of readdirSync(store, { withFileTypes: true })) {
    if (!stored.isDirectory()) continue;
    const modules = join(store, stored.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scope = join(modules, entry.name);
        for (const scoped of readdirSync(scope, { withFileTypes: true })) {
          if (scoped.isDirectory()) roots.push(join(scope, scoped.name));
        }
      } else {
        roots.push(join(modules, entry.name));
      }
    }
  }
  return roots;
}

function packageLicense(packageRoot, manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) {
    return manifest.license.trim();
  }
  if (manifest.name === "unionfs" && manifest.version === "4.6.0") {
    const licensePath = join(packageRoot, "LICENSE");
    assertFile(licensePath, "released into the public domain");
    const text = readFileSync(licensePath, "utf8");
    if (!text.includes("https://unlicense.org")) {
      fail("unionfs 4.6.0 does not contain the reviewed Unlicense text");
    }
    return "Unlicense";
  }
  return null;
}

function approvedJavascriptLicense(key, license) {
  return ALLOWED_JAVASCRIPT_LICENSES.has(license)
    || APPROVED_COPYLEFT_JAVASCRIPT_EXCEPTIONS.get(key) === license;
}

function checkWorkspace() {
  const root = process.cwd();
  for (const manifestPath of ownPackageManifests(root)) {
    const manifest = readJson(manifestPath);
    if (manifest.license !== CODEOPS_LICENSE) {
      fail(`${manifestPath} must declare license ${CODEOPS_LICENSE}`);
    }
  }

  assertFile(join(root, "LICENSE"), "Apache License");
  assertFile(join(root, "CONTRIBUTING.md"), "license that contribution under Apache-2.0");
  assertFile(join(root, "LICENSE_POLICY.md"), "Do not copy, adapt, link, vendor");
  assertFile(join(root, "THIRD_PARTY_NOTICES.md"), "Bundled Helm chart dependencies");
  assertFile(join(root, "infra/charts/codeops/LICENSE"), "Apache License");
  assertFile(join(root, "infra/charts/codeops/THIRD_PARTY_NOTICES.md"), "NATS Helm chart");
  assertFile(join(root, "infra/charts/codeops/licenses/NATS-CHART-APACHE-2.0.txt"), "Apache License");
  assertFile(join(root, "infra/charts/codeops/licenses/TEMPORAL-CHART-MIT.txt"), "The MIT License");
  assertFile(join(root, "infra/charts/codeops/licenses/PLANE-CHART-AGPL-3.0.txt"), "AGPL-3.0-only");
  assertFile(join(root, "sites/agents-ui/src/components/AppShell.tsx"), "Legal &amp; source");
  assertFile(join(root, "config/project-context/AGENTS.md"), "Do not copy, adapt, link, vendor");
  assertFile(join(root, "infra/charts/codeops/files/project-context/AGENTS.md"), "Do not copy, adapt, link, vendor");

  const chart = readFileSync(join(root, "infra/charts/codeops/Chart.yaml"), "utf8");
  if (!chart.includes("artifacthub.io/license: Apache-2.0")) {
    fail("the Helm chart must declare Apache-2.0");
  }

  const packages = new Map();
  for (const packageRoot of installedPackageRoots(root)) {
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!manifest.name || !manifest.version) continue;
    const key = `${manifest.name}@${manifest.version}`;
    const license = packageLicense(packageRoot, manifest);
    if (!license) fail(`JavaScript dependency has no reviewed license: ${key}`);
    if (!approvedJavascriptLicense(key, license)) {
      fail(`JavaScript dependency uses an unapproved license: ${key} (${license})`);
    }
    packages.set(key, license);
  }
  if (packages.size === 0) fail("the installed JavaScript dependency inventory is empty");

  process.stdout.write(`license policy passed for ${ownPackageManifests(root).length} CodeOps packages and ${packages.size} installed JavaScript dependencies\n`);
}

function npmPackage(pkg) {
  return (pkg.externalRefs ?? []).some(
    (reference) => reference.referenceLocator?.startsWith("pkg:npm/"),
  );
}

function loadLicenseOverrides() {
  const document = readJson(LICENSE_OVERRIDES_PATH);
  if (document.schema !== "codeops.npm-license-overrides/v1") {
    fail("npm license overrides use an unsupported schema");
  }
  const overrides = new Map();
  for (const [key, value] of Object.entries(document.packages ?? {})) {
    if (!key.includes("@") || !value || typeof value.license !== "string" || typeof value.evidence !== "string") {
      fail(`npm license override is malformed: ${key}`);
    }
    if (!ALLOWED_JAVASCRIPT_LICENSES.has(value.license)) {
      fail(`npm license override uses an unapproved license: ${key} (${value.license})`);
    }
    overrides.set(key, value);
  }
  if (overrides.size === 0) fail("npm license override inventory is empty");
  return overrides;
}

function derivedSubpathLicense(pkg, npmPackages) {
  if (pkg.versionInfo !== "UNKNOWN" || pkg.name?.startsWith("@") || !pkg.name?.includes("/")) {
    return null;
  }
  const parentName = pkg.name.split("/", 1)[0];
  const parents = npmPackages.filter(
    (candidate) => candidate.name === parentName && ALLOWED_JAVASCRIPT_LICENSES.has(candidate.licenseDeclared),
  );
  if (parents.length !== 1) return null;
  return {
    license: parents[0].licenseDeclared,
    evidence: `${parents[0].name}@${parents[0].versionInfo}`,
  };
}

function checkSbom(sbomPath, reportPath, subject) {
  const bytes = readFileSync(sbomPath);
  const sbom = JSON.parse(bytes.toString("utf8"));
  if (sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.packages) || sbom.packages.length === 0) {
    fail("license policy requires a non-empty SPDX 2.3 JSON SBOM");
  }

  const rejected = [];
  const javascript = sbom.packages.filter(npmPackage);
  const overrides = loadLicenseOverrides();
  const appliedOverrides = [];
  const derivedSubpaths = [];
  const licenses = new Map();
  for (const pkg of sbom.packages) {
    const declared = pkg.licenseDeclared ?? "NOASSERTION";
    licenses.set(declared, (licenses.get(declared) ?? 0) + 1);
    if (REJECTED_LICENSE_PATTERN.test(declared)) {
      rejected.push(`${pkg.name}@${pkg.versionInfo ?? "unknown"} (${declared})`);
    }
    if (!npmPackage(pkg)) continue;
    const key = `${pkg.name}@${pkg.versionInfo ?? "UNKNOWN"}`;
    let effective = declared;
    if (declared === "NOASSERTION") {
      const override = overrides.get(key);
      const derived = derivedSubpathLicense(pkg, javascript);
      if (override) {
        effective = override.license;
        appliedOverrides.push({ package: key, license: override.license, evidence: override.evidence });
      } else if (derived) {
        effective = derived.license;
        derivedSubpaths.push({ package: key, license: derived.license, evidence: derived.evidence });
      }
    }
    if (!approvedJavascriptLicense(key, effective)) {
      rejected.push(`${key} (${declared})`);
    }
    if (pkg.name?.startsWith("@codeops/") && declared !== CODEOPS_LICENSE) {
      rejected.push(`${key} must declare ${CODEOPS_LICENSE}`);
    }
  }
  if (javascript.length === 0) fail("image SBOM contains no JavaScript package inventory");
  if (rejected.length > 0) {
    fail(`image license policy rejected:\n${[...new Set(rejected)].sort().join("\n")}`);
  }

  const report = {
    schema: "codeops.license-policy-report/v1",
    subject,
    sbom: basename(sbomPath),
    sbomSha256: sha256(bytes),
    packageCount: sbom.packages.length,
    javascriptPackageCount: javascript.length,
    declaredLicenses: Object.fromEntries([...licenses.entries()].sort(([a], [b]) => a.localeCompare(b))),
    appliedOverrides: appliedOverrides.sort((a, b) => a.package.localeCompare(b.package)),
    derivedSubpaths: derivedSubpaths.sort((a, b) => a.package.localeCompare(b.package)),
    policy: {
      codeopsLicense: CODEOPS_LICENSE,
      rejectedLicensePattern: REJECTED_LICENSE_PATTERN.source,
      javascriptLicenseAllowlist: [...ALLOWED_JAVASCRIPT_LICENSES].sort(),
      approvedCopyleftJavascriptExceptions: Object.fromEntries(APPROVED_COPYLEFT_JAVASCRIPT_EXCEPTIONS),
      result: "pass",
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`license policy passed for ${subject}: ${report.packageCount} packages, ${report.javascriptPackageCount} JavaScript packages\n`);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--workspace") {
  checkWorkspace();
} else if (args.length === 6 && args[0] === "--sbom" && args[2] === "--report" && args[4] === "--subject") {
  checkSbom(resolve(args[1]), resolve(args[3]), args[5]);
} else {
  fail("usage: check-codeops-license-policy.mjs --workspace | --sbom <spdx.json> --report <report.json> --subject <name>");
}
