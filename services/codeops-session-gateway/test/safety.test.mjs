import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  boundedText,
  redactSecrets,
  requireAgentRole,
  requireLowerHex,
  requireRunId,
} from "../dist/safety.js";
import {
  createCheckpointLogRecord,
  createPatchLogRecords,
  capturePatch,
  connectSocket,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("waits boundedly for the pod-local ACP socket", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-acp-socket-"));
  const socketPath = path.join(directory, "agent.sock");
  const server = net.createServer((socket) => socket.end());
  const listening = new Promise((resolve, reject) => {
    setTimeout(() => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    }, 50);
  });
  try {
    const socket = await connectSocket(socketPath, {
      timeoutMs: 1_000,
      retryIntervalMs: 10,
    });
    socket.destroy();
    await listening;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

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
  assert.equal(boundedText("abcdef", 3), "\n[T");
  assert.equal(boundedText("a".repeat(501), 500).length, 500);
  assert.equal(boundedText("a".repeat(2_001), 2_000).length, 2_000);
  assert.equal(boundedText("a".repeat(20_001)).length, 20_001);
  assert.equal(boundedText("a".repeat(128_001)).length, 128_000);
});

test("captures staged, unstaged, and non-ignored new files from the exact checkout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-workspace-"));
  try {
    await execFileAsync("git", ["init", "--quiet", directory]);
    await writeFile(path.join(directory, "tracked.txt"), "before\n");
    await writeFile(path.join(directory, "staged.txt"), "before staged\n");
    await writeFile(path.join(directory, ".gitignore"), "ignored.txt\n");
    await execFileAsync("git", [
      "-C",
      directory,
      "add",
      "tracked.txt",
      "staged.txt",
      ".gitignore",
    ]);
    await execFileAsync("git", [
      "-C",
      directory,
      "-c",
      "user.name=CodeOps Test",
      "-c",
      "user.email=codeops@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    await writeFile(path.join(directory, "tracked.txt"), "after\n");
    await writeFile(path.join(directory, "staged.txt"), "after staged\n");
    await execFileAsync("git", ["-C", directory, "add", "staged.txt"]);
    await writeFile(path.join(directory, "new file.txt"), "new\n");
    await writeFile(path.join(directory, "ignored.txt"), "ignored\n");
    const patch = await capturePatch(directory);
    const text = patch.toString("utf8");
    assert.match(text, /-before\n\+after/);
    assert.match(text, /-before staged\n\+after staged/);
    assert.match(text, /diff --git a\/new file\.txt b\/new file\.txt/);
    assert.match(text, /\+new/);
    assert.doesNotMatch(text, /ignored\.txt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  assert.equal(requireAgentRole("coding-agent"), "coding-agent");
  assert.equal(requireAgentRole("critic-agent"), "critic-agent");
  assert.equal(
    requireAgentRole("qa-contract-researcher"),
    "qa-contract-researcher",
  );
  for (const role of ["", "researcher", "admin", undefined]) {
    assert.throws(() => requireAgentRole(role));
  }
});

test("emits one digest-bound checkpoint record for trusted reconciliation", () => {
  const checkpoint = {
    schemaVersion: 3,
    runId: "research-1",
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest: `sha256:${"b".repeat(64)}`,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: "research result",
    events: [],
    patch: {
      path: "changes.patch",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    },
  };
  const record = createCheckpointLogRecord(checkpoint);
  assert.equal(record.type, "codeops.checkpoint");
  assert.match(record.checkpointDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(record.checkpoint, checkpoint);
});

test("emits ordered digest-bound patch chunks including an empty patch", () => {
  const empty = createPatchLogRecords("research-1", new Uint8Array());
  assert.equal(empty.length, 1);
  assert.equal(empty[0].sequence, 1);
  assert.equal(empty[0].total, 1);
  assert.equal(empty[0].dataBase64, "");
  assert.equal(
    empty[0].patchDigest,
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  const patch = Buffer.alloc(96_001, 0x61);
  const records = createPatchLogRecords("coding-1", patch);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2, 3],
  );
  assert.equal(
    Buffer.concat(records.map((record) => Buffer.from(record.dataBase64, "base64"))).equals(
      patch,
    ),
    true,
  );
  assert.equal(new Set(records.map((record) => record.patchDigest)).size, 1);
});
