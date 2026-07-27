import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
  connectSocket,
} from "../dist/index.js";

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
  assert.equal(requireAgentRole("coding-agent"), "coding-agent");
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
    schemaVersion: 2,
    runId: "research-1",
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
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
