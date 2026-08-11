import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  persistFifteenthSessionProofStepAuthorizationFromOperatorPacket,
  readFifteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-step-authorization.mjs";

const namespace = "codeops-session-proof-runtime-auth";

function closedRunner() {
  let calls = 0;
  return {
    execute() {
      calls += 1;
      throw new Error("runner must not be reached");
    },
    get calls() {
      return calls;
    },
  };
}

test("rejects a substituted runtime authorization path before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-auth-"));
  try {
    const runner = closedRunner();
    assert.throws(() => persistFifteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath: join(root, `${namespace}.packet`),
      fifteenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-06T23:30:00Z",
    }, runner.execute), /derive exactly/);
    assert.equal(runner.calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an occupied runtime authorization path before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-auth-"));
  try {
    const runner = closedRunner();
    const authorizationPath = join(
      root,
      `${namespace}.step-17-start-runtime.authorization.json`,
    );
    writeFileSync(authorizationPath, "{}\n", { mode: 0o600 });
    assert.throws(() => persistFifteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath: join(root, `${namespace}.packet`),
      fifteenthAuthorizationPath: authorizationPath,
      observedAt: "2026-08-06T23:30:00Z",
    }, runner.execute), /already exists/);
    assert.equal(runner.calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted persisted runtime authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-auth-"));
  try {
    const runner = closedRunner();
    assert.throws(() => readFifteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath: join(root, `${namespace}.packet`),
      fifteenthAuthorizationPath: join(root, "substituted.authorization.json"),
    }, runner.execute), /derive exactly/);
    assert.equal(runner.calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects weakened runtime authorization permissions before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-runtime-auth-"));
  try {
    const runner = closedRunner();
    const authorizationPath = join(
      root,
      `${namespace}.step-17-start-runtime.authorization.json`,
    );
    writeFileSync(authorizationPath, "{}\n", { mode: 0o644 });
    assert.throws(() => readFifteenthSessionProofStepAuthorizationFromOperatorPacket({
      packetPath: join(root, `${namespace}.packet`),
      fifteenthAuthorizationPath: authorizationPath,
    }, runner.execute), /bounded private regular file/);
    assert.equal(runner.calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
