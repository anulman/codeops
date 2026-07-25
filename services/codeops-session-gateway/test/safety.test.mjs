import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedText,
  redactSecrets,
  requireLowerHex,
  requireRunId,
} from "../dist/safety.js";

test("redacts common API and bearer credential shapes", () => {
  assert.equal(
    redactSecrets(
      "sk-1234567890 ghp_1234567890 github_pat_1234567890 Bearer abcdefghijklmnop",
    ),
    "[REDACTED] [REDACTED] [REDACTED] [REDACTED]",
  );
});

test("bounds retained agent text after redaction", () => {
  assert.equal(boundedText("abc", 3), "abc");
  assert.equal(boundedText("abcdef", 3), "abc\n[TRUNCATED]");
});

test("validates run and immutable source identities", () => {
  assert.equal(requireRunId("routing-matrix-2fdebb4c"), "routing-matrix-2fdebb4c");
  assert.equal(
    requireLowerHex("base", "a".repeat(40), 40),
    "a".repeat(40),
  );
  for (const runId of ["", "-bad", "UPPER", "a".repeat(41)]) {
    assert.throws(() => requireRunId(runId));
  }
  for (const sha of ["", "abc", "A".repeat(40), "a".repeat(39)]) {
    assert.throws(() => requireLowerHex("base", sha, 40));
  }
});
