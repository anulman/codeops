#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

export const CODEOPS_RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]*[A-Za-z][0-9A-Za-z-]*)\.(?:0|[1-9][0-9]*))?$/;

export function validateCodeOpsReleaseVersion(version) {
  if (
    typeof version !== "string" ||
    !CODEOPS_RELEASE_VERSION_PATTERN.test(version)
  ) {
    throw new Error(
      "release version must be stable SemVer or use a <channel>.<sequence> prerelease suffix",
    );
  }
  return version;
}

export function isCodeOpsPrereleaseVersion(version) {
  validateCodeOpsReleaseVersion(version);
  return version.includes("-");
}

async function main() {
  const [version, ...extra] = process.argv.slice(2);
  if (version === undefined || extra.length !== 0) {
    throw new Error("usage: codeops-release-version <version>");
  }
  validateCodeOpsReleaseVersion(version);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
