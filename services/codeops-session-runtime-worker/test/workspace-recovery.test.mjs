import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { captureVerifiedWorkspaceCheckpoint } from "../dist/acp-workspace.js";
import { restoreVerifiedWorkspaceCheckpoint, materializeCheckpointBase } from "../dist/workspace-recovery.js";

const execFileAsync = promisify(execFile);
const checkpointId = "22222222-2222-4222-8222-222222222222";
const workspaceJobUid = "11111111-1111-4111-8111-111111111111";
const restoredUid = "33333333-3333-4333-8333-333333333333";
const configurationDigest = `sha256:${"a".repeat(64)}`;

async function fixture(clean = false, baseBytes = 0) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codeops-capture-source-"));
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-capture-private-"));
  const restoreRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-restore-private-"));
  const source = path.join(workspace, "sources", "codeops");
  await mkdir(source, { recursive: true });
  await mkdir(path.join(workspace, "scratch", "nested"), { recursive: true });
  await execFileAsync("git", ["-C", source, "init"]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(path.join(source, "README.md"), "base\n");
  if (baseBytes > 0) await writeFile(path.join(source, "large-base.bin"), Buffer.alloc(baseBytes, 7));
  await execFileAsync("git", ["-C", source, "add", "."]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "base"]);
  const sha = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]))
    .stdout.trim();
  if (!clean) {
    await writeFile(path.join(source, "README.md"), "restored exactly\n");
    await writeFile(path.join(source, "new.bin"), Buffer.from([0, 1, 2, 255]));
  }
  await writeFile(path.join(workspace, "scratch", "nested", "notes.txt"),
    "private scratch\n", { mode: 0o600 });
  const manifest = {
    version: "codeops.workspace/v1",
    sources: [{ catalogKey: "codeops", repository: "example/codeops",
      checkoutPath: "sources/codeops", requestedRef: "main", resolvedSha: sha }],
    scratchPath: "scratch",
  };
  const captured = await captureVerifiedWorkspaceCheckpoint({
    workspaceRoot: workspace, manifest, captureRoot, checkpointId,
    sessionId: "ses_verified", generation: 1, workspaceJobUid,
    resourceConfigurationDigest: `sha256:${"e".repeat(64)}`,
    workspaceConfigurationDigest: configurationDigest,
    capturedAt: "2026-09-04T10:00:00.000Z",
  });
  const artifacts = new Map();
  for (const sourcePatch of captured.captured.sourcePatches) {
    const artifactId = `artifact:${checkpointId}:source:${sourcePatch.catalogKey}`;
    artifacts.set(artifactId, { artifactId, sessionId: "ses_verified", generation: 1,
      checkpointId, kind: "source-patch", catalogKey: sourcePatch.catalogKey,
      digest: sourcePatch.patchDigest, content: sourcePatch.content });
  }
  const scratchId = `artifact:${checkpointId}:scratch`;
  artifacts.set(scratchId, { artifactId: scratchId, sessionId: "ses_verified",
    generation: 1, checkpointId, kind: "scratch-bundle",
    digest: captured.captured.scratch.digest, content: captured.captured.scratch.content });
  const store = { get: async (artifactId) => artifacts.get(artifactId) ?? null,
    put: async () => assert.fail("restore must not write checkpoint artifacts") };
  const materializeBase = ({ source: selected, target }) => materializeCheckpointBase({
    materializedWorkspace: workspace, source: selected, target });
  return { workspace, captureRoot, restoreRoot, source, manifest,
    descriptor: captured.descriptor, artifacts, store, materializeBase };
}

test("restores into a fresh private workspace and requires exact recapture equality", async () => {
  const run = await fixture();
  const restored = await restoreVerifiedWorkspaceCheckpoint({
    descriptor: run.descriptor, workspaceManifest: run.manifest,
    artifacts: run.store, privateRoot: run.restoreRoot,
    restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
    restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
    restoredWorkspaceConfigurationDigest: configurationDigest,
    restoredGeneration: 2,
    restoredAt: "2026-09-04T10:05:00.000Z",
    materializeBase: run.materializeBase,
  });
  assert.equal((await readFile(path.join(restored.workspace,
    "sources/codeops/README.md"), "utf8")), "restored exactly\n");
  assert.deepEqual(await readFile(path.join(restored.workspace,
    "sources/codeops/new.bin")), Buffer.from([0, 1, 2, 255]));
  assert.equal(await readFile(path.join(restored.workspace,
    "scratch/nested/notes.txt"), "utf8"), "private scratch\n");
  assert.equal(restored.receipt.restoredWorkspaceJobUid, restoredUid);
  assert.equal(restored.receipt.descriptorDigest,
    sha256CanonicalJsonDigest(run.descriptor));
  const config = await readFile(path.join(restored.workspace,
    "sources/codeops/.git/config"), "utf8");
  assert.doesNotMatch(config, /remote|url|hooksPath = (?!\/dev\/null)/);
});

test("refuses path, byte, digest, base, generation, workspace, corruption, and stale readback drift", async () => {
  const mutations = [
    ["path set", (run) => { run.descriptor.manifest.pathSetDigest =
      `sha256:${"f".repeat(64)}`; }],
    ["artifact byte", (run) => { run.descriptor.manifest.sourcePatches[0].bytes += 1;
      run.descriptor.manifest.totalBytes += 1; }],
    ["artifact digest", (run) => { run.descriptor.manifest.sourcePatches[0].digest =
      `sha256:${"f".repeat(64)}`; }],
    ["base", (run) => { run.descriptor.manifest.sourcePatches[0].baseSha = "f".repeat(40); }],
    ["generation", (run) => { run.descriptor.manifest.binding.generation = 2; }],
    ["workspace", (run) => { run.descriptor.manifest.binding.workspaceConfigurationDigest = `sha256:${"f".repeat(64)}`; }],
  ];
  for (const [_name, mutate] of mutations) {
    const run = await fixture();
    mutate(run);
    run.descriptor.manifestDigest = sha256CanonicalJsonDigest(run.descriptor.manifest);
    await assert.rejects(restoreVerifiedWorkspaceCheckpoint({
      descriptor: run.descriptor, workspaceManifest: run.manifest,
      artifacts: run.store, privateRoot: run.restoreRoot,
      restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
      restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
      restoredWorkspaceConfigurationDigest: configurationDigest,
      restoredGeneration: 2,
      restoredAt: "2026-09-04T10:05:00.000Z",
      materializeBase: run.materializeBase,
    }));
  }
  const corrupt = await fixture();
  const scratch = corrupt.artifacts.get(`artifact:${checkpointId}:scratch`);
  scratch.content = Buffer.from("not JSON");
  await assert.rejects(restoreVerifiedWorkspaceCheckpoint({
    descriptor: corrupt.descriptor, workspaceManifest: corrupt.manifest,
    artifacts: corrupt.store, privateRoot: corrupt.restoreRoot,
    restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
    restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
    restoredWorkspaceConfigurationDigest: configurationDigest,
    restoredGeneration: 2,
    restoredAt: "2026-09-04T10:05:00.000Z",
    materializeBase: corrupt.materializeBase,
  }), /readback|corrupt/);
});

test("rejects an escaping materializer symlink before any destructive Git command", async () => {
  const run = await fixture();
  await assert.rejects(restoreVerifiedWorkspaceCheckpoint({
    descriptor: run.descriptor, workspaceManifest: run.manifest,
    artifacts: run.store, privateRoot: run.restoreRoot,
    restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
    restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
    restoredWorkspaceConfigurationDigest: configurationDigest,
    restoredGeneration: 2, restoredAt: "2026-09-04T10:05:00.000Z",
    materializeBase: async ({ target }) => {
      await mkdir(target, { recursive: true });
      await symlink(run.source, path.join(target, ".git"));
    },
  }), /symlink or special file/);
  assert.equal(await readFile(path.join(run.source, "README.md"), "utf8"),
    "restored exactly\n");
});

function restoreInput(run, overrides = {}) {
  return { descriptor: run.descriptor, workspaceManifest: run.manifest,
    artifacts: run.store, privateRoot: run.restoreRoot,
    restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
    restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
    restoredWorkspaceConfigurationDigest: configurationDigest,
    restoredGeneration: 2, restoredAt: "2026-09-04T10:05:00.000Z",
    materializeBase: run.materializeBase, ...overrides };
}

async function replaceScratch(run, entries) {
  const { createHash } = await import("node:crypto");
  const content = Buffer.from(JSON.stringify({ version: "codeops.scratch-artifact/v1", entries }));
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const artifact = run.artifacts.get(`artifact:${checkpointId}:scratch`);
  artifact.content = content; artifact.digest = digest;
  const manifest = run.descriptor.manifest;
  manifest.scratchArtifact = { ...manifest.scratchArtifact, digest, bytes: content.byteLength };
  manifest.totalBytes = manifest.sourcePatches.reduce((sum, source) => sum + source.bytes, 0) + content.byteLength;
  run.descriptor.manifestDigest = sha256CanonicalJsonDigest(manifest);
}

test("rejects unsafe scratch paths and every restore bound before materializing a Git base", async () => {
  const { createHash } = await import("node:crypto");
  const directory = { path: ".", type: "directory" };
  const file = (name, bytes = Buffer.alloc(0)) => ({ path: name, type: "file", executable: false,
    contentBase64: bytes.toString("base64"), bytes: bytes.byteLength,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  for (const entries of [
    [directory, file("../escaped")],
    [directory, { path: "fifo", type: "fifo" }],
    [directory, { ...file("bad", Buffer.from([0])), contentBase64: "AB==" }],
    [directory, file("large", Buffer.alloc(10_000_001))],
    [directory, ...Array.from({ length: 10_000 }, (_, i) => file(`f${i}`))],
    [directory, ...Array.from({ length: 8_100 }, (_, i) => file(`${i}-${"x".repeat(245)}`))],
    [directory, file("x"), file("x")],
    [directory, file("parent"), file("parent/child")],
  ]) {
    const run = await fixture(); await replaceScratch(run, entries);
    let calls = 0;
    await assert.rejects(restoreVerifiedWorkspaceCheckpoint(restoreInput(run, {
      materializeBase: async () => { calls++; },
    })));
    assert.equal(calls, 0);
  }
});

test("rejects a symlinked private root before any base materialization", async () => {
  const run = await fixture();
  const alias = path.join(run.captureRoot, "alias");
  await symlink(run.restoreRoot, alias);
  await assert.rejects(restoreVerifiedWorkspaceCheckpoint(restoreInput(run, {
    privateRoot: alias, materializeBase: async () => assert.fail("untrusted root reached materializer"),
  })), /authenticated private root/);
});

test("production materialization ignores repository config, remotes and hooks", async () => {
  const run = await fixture();
  // A nonexistent include must never be opened by restore; source config is
  // not copied or consulted by the existing-object materialization path.
  await writeFile(path.join(run.source, ".git", "config"),
    '[include]\n path = /does-not-exist/checkpoint-test-config\n[core]\n fsmonitor = /does-not-exist/checkpoint-test-hook\n[remote "origin"]\n url = https://invalid.example/repository\n');
  const result = await restoreVerifiedWorkspaceCheckpoint(restoreInput(run));
  assert.equal(await readFile(path.join(result.workspace, "sources/codeops/README.md"), "utf8"), "restored exactly\n");
  assert.doesNotMatch(await readFile(path.join(result.workspace, "sources/codeops/.git/config"), "utf8"), /include|fsmonitor|remote/);
});

test("restores a clean source with a zero-byte patch and nonempty scratch", async () => {
  const run = await fixture(true);
  assert.equal(run.descriptor.manifest.sourcePatches[0].bytes, 0);
  const restored = await restoreVerifiedWorkspaceCheckpoint(restoreInput(run));
  assert.equal(await readFile(path.join(restored.workspace, "sources/codeops/README.md"), "utf8"), "base\n");
  assert.equal(await readFile(path.join(restored.workspace, "scratch/nested/notes.txt"), "utf8"), "private scratch\n");
});


test("restored cwd supports a full base checkout larger than worker session-state", async () => {
  const run = await fixture(false, 20 * 1024 * 1024);
  const restored = await restoreVerifiedWorkspaceCheckpoint({
    descriptor: run.descriptor, workspaceManifest: run.manifest,
    artifacts: run.store, privateRoot: run.restoreRoot,
    restoreOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoredWorkspaceJobUid: restoredUid,
    restoredResourceConfigurationDigest: `sha256:${"f".repeat(64)}`,
    restoredWorkspaceConfigurationDigest: configurationDigest,
    restoredGeneration: 2, restoredAt: "2026-09-04T10:05:00.000Z",
    materializeBase: run.materializeBase,
  });
  const result = await execFileAsync(process.execPath, ["-e", `
    const fs = require('node:fs');
    if (fs.statSync('sources/codeops/large-base.bin').size !== 20 * 1024 * 1024) process.exit(1);
    if (fs.readFileSync('sources/codeops/README.md', 'utf8') !== 'restored exactly\\n') process.exit(2);
    fs.writeFileSync('scratch/continued.txt', 'continued');
  `], { cwd: restored.workspace });
  assert.equal(result.stderr, "");
  assert.equal(await readFile(path.join(restored.workspace, "scratch/continued.txt"), "utf8"), "continued");
});
