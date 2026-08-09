import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_CONTROL_SECRET_NAMES,
  validateSessionControlSecrets,
} from "../dist/session-control-config.js";

function secrets() {
  return Object.fromEntries(
    SESSION_CONTROL_SECRET_NAMES.map((name, index) => [
      name,
      `${index}`.repeat(32),
    ]),
  );
}

test("accepts only bounded and mutually distinct session authorities", () => {
  assert.deepEqual(validateSessionControlSecrets(secrets()), secrets());
  for (const patch of [
    { readToken: "short" },
    { writeToken: "x".repeat(4_097) },
    { workerToken: "0".repeat(32) },
    { initializationToken: "1".repeat(32) },
  ]) {
    assert.throws(() =>
      validateSessionControlSecrets({ ...secrets(), ...patch }),
    );
  }
});

test("standalone entrypoint does not import broader controller authorities", async () => {
  const { readFile } = await import("node:fs/promises");
  const sources = await Promise.all(
    [
      "session-control-main.ts",
      "session-broker-command.ts",
      "session-broker-http.ts",
      "session-broker-runtime-http.ts",
      "session-job-initialization.ts",
    ].map((name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")),
  );
  const source = sources.join("\n");
  for (const forbidden of [
    "./core.js",
    "./kubernetes.js",
    "./publication.js",
    "./runtime.js",
    "./github-stacks.js",
    "CODEOPS_DISPATCH_TOKEN_FILE",
    "CODEOPS_PUBLICATION_TOKEN_FILE",
    "CODEOPS_REPOSITORY_READ_TOKEN_FILE",
    "CODEOPS_REPOSITORY_WRITE_TOKEN_FILE",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
