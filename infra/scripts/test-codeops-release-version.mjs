import assert from "node:assert/strict";
import test from "node:test";
import {
  isCodeOpsPrereleaseVersion,
  validateCodeOpsReleaseVersion,
} from "./codeops-release-version.mjs";

test("accepts stable and structured prerelease versions", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha.0",
    "1.2.3-foo.1",
    "1.2.3-bar.0",
    "1.2.3-release-candidate.12",
  ]) {
    assert.equal(validateCodeOpsReleaseVersion(version), version);
  }
  assert.equal(isCodeOpsPrereleaseVersion("1.2.3"), false);
  assert.equal(isCodeOpsPrereleaseVersion("1.2.3-alpha.0"), true);
});

test("rejects malformed and ambiguous prerelease versions", () => {
  for (const version of [
    "v1.2.3",
    "01.2.3",
    "1.2.3-alpha",
    "1.2.3-alpha.01",
    "1.2.3-1.0",
    "1.2.3--.0",
    "1.2.3-alpha.0.extra",
    "1.2.3+build.1",
    "1.2.3-alpha_1.0",
  ]) {
    assert.throws(() => validateCodeOpsReleaseVersion(version), /release version/);
  }
});
