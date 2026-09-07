import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalJsonText,
  checkpointDescriptorSchema,
  restoreReceiptSchema,
  sha256CanonicalJsonDigest,
  workspaceManifestSchema,
  type CheckpointDescriptor,
  type WorkspaceManifest,
} from "@codeops/codeops-contracts";
import { captureWorkspaceCheckpointArtifacts } from "./acp-workspace.js";
import type {
  WorkspaceCheckpointArtifact,
  WorkspaceCheckpointArtifactReader,
} from "./workspace-artifacts.js";

const execFileAsync = promisify(execFile);

/** The builder mounts only this private PVC subtree, never worker state/secrets. */
export async function createWorkspaceRecoveryRoot(backing: string): Promise<string> {
  const stat = await lstat(backing);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 || await realpath(backing) !== path.resolve(backing)) {
    throw new Error("workspace recovery backing is not a private plain directory");
  }
  return mkdtemp(path.join(backing, ".codeops-recovery-"));
}

function exactDigest(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000 ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("restored checkpoint contains an unsafe path");
  }
  return value;
}

async function exactArtifact(
  store: WorkspaceCheckpointArtifactReader,
  descriptor: CheckpointDescriptor,
  expected: { readonly artifactId: string; readonly bytes: number; readonly digest: string },
): Promise<WorkspaceCheckpointArtifact> {
  const artifact = await store.get(expected.artifactId);
  if (artifact === null || artifact.sessionId !== descriptor.manifest.binding.sessionId ||
      artifact.generation !== descriptor.manifest.binding.generation ||
      artifact.checkpointId !== descriptor.manifest.checkpointId ||
      artifact.content.byteLength !== expected.bytes || artifact.digest !== expected.digest ||
      exactDigest(artifact.content) !== expected.digest) {
    throw new Error("checkpoint artifact readback does not match its exact descriptor");
  }
  return artifact;
}

async function rejectNonRegularTree(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    const target = path.join(root, name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("restored workspace contains a symlink or special file");
    }
    if (stat.isDirectory()) await rejectNonRegularTree(target);
  }
}

function scratchEntries(content: Buffer): { path: string; content?: Buffer; executable?: boolean }[] {
  if (content.byteLength > 16_000_000) throw new Error("scratch checkpoint artifact exceeds its encoded byte bound");
  const text = content.toString("utf8");
  if (!Buffer.from(text).equals(content)) throw new Error("scratch checkpoint encoding is invalid");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("scratch checkpoint artifact is corrupt"); }
  if (raw === null || typeof raw !== "object" ||
      (raw as { version?: unknown }).version !== "codeops.scratch-artifact/v1" ||
      !Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new Error("scratch checkpoint artifact version is unsupported");
  }
  const entries = (raw as { entries: Record<string, unknown>[] }).entries;
  if (entries.length > 10_000 || entries[0]?.path !== "." || entries[0]?.type !== "directory") {
    throw new Error("scratch checkpoint artifact manifest is invalid");
  }
  const seen = new Set<string>();
  const directories = new Set(["."]);
  let decodedBytes = 0;
  let pathBytes = 1;
  return entries.slice(1).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("scratch checkpoint entry is invalid");
    const relative = safeRelativePath(entry.path);
    pathBytes += Buffer.byteLength(relative);
    if (pathBytes > 2_000_000) throw new Error("scratch checkpoint paths exceed their aggregate byte bound");
    if (seen.has(relative) || !directories.has(path.posix.dirname(relative))) {
      throw new Error("scratch checkpoint path is duplicated or has an unsafe parent");
    }
    seen.add(relative);
    if (entry.type === "directory") { directories.add(relative); return { path: relative }; }
    if (entry.type !== "file" || typeof entry.contentBase64 !== "string" ||
        typeof entry.executable !== "boolean") throw new Error("scratch checkpoint contains a non-regular entry");
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (bytes.toString("base64") !== entry.contentBase64) throw new Error("scratch checkpoint encoding is invalid");
    decodedBytes += bytes.byteLength;
    if (decodedBytes > 10_000_000) throw new Error("scratch checkpoint content exceeds its aggregate byte bound");
    if (entry.bytes !== bytes.byteLength || entry.digest !== exactDigest(bytes)) {
      throw new Error("scratch checkpoint path bytes or digest drifted");
    }
    return { path: relative, content: bytes, executable: entry.executable };
  });
}

async function restoreScratch(entries: ReturnType<typeof scratchEntries>, target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  for (const entry of entries) {
    const destination = path.join(target, ...entry.path.split("/"));
    if (entry.content === undefined) await mkdir(destination, { mode: 0o700 });
    else await writeFile(destination, entry.content, { flag: "wx", mode: entry.executable ? 0o700 : 0o600 });
  }
}

function privateGitEnvironment(home: string) {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    XDG_CONFIG_HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
}

/** Restore is deliberately a library operation owned by the existing runtime.
 * The caller supplies the existing trusted base materializer; this code creates
 * no service, controller, worker, volume, or provider effect. */
export async function restoreVerifiedWorkspaceCheckpoint(input: {
  readonly descriptor: unknown;
  readonly workspaceManifest: WorkspaceManifest;
  readonly artifacts: WorkspaceCheckpointArtifactReader;
  readonly privateRoot: string;
  readonly restoreOperationId: string;
  readonly restoredWorkspaceJobUid: string;
  readonly restoredResourceConfigurationDigest: string;
  readonly restoredWorkspaceConfigurationDigest: string;
  readonly restoredGeneration: number;
  readonly restoredAt: string;
  readonly materializeBase: (input: {
    readonly source: WorkspaceManifest["sources"][number];
    readonly target: string;
  }) => Promise<void>;
}): Promise<{ readonly workspace: string; readonly receipt: ReturnType<typeof restoreReceiptSchema.parse> }> {
  const descriptor = checkpointDescriptorSchema.parse(input.descriptor);
  if (descriptor.manifestDigest !== sha256CanonicalJsonDigest(descriptor.manifest)) {
    throw new Error("checkpoint descriptor manifest digest is corrupt");
  }
  const workspaceManifest = workspaceManifestSchema.parse(input.workspaceManifest);
  const manifestDigest = sha256CanonicalJsonDigest(workspaceManifest);
  if (manifestDigest !== descriptor.manifest.binding.workspaceManifestDigest ||
      !/^sha256:[0-9a-f]{64}$/.test(
        input.restoredResourceConfigurationDigest,
      ) ||
      input.restoredWorkspaceConfigurationDigest !==
        descriptor.manifest.binding.workspaceConfigurationDigest ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.restoredWorkspaceJobUid) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.restoreOperationId) ||
      !Number.isSafeInteger(input.restoredGeneration) ||
      input.restoredGeneration <= descriptor.manifest.binding.generation) {
    throw new Error("restore workspace identity or configuration does not match the checkpoint");
  }
  const expectedSources = descriptor.manifest.sourcePatches;
  if (canonicalJsonText(workspaceManifest.sources.map((source) => ({
    catalogKey: source.catalogKey, repository: source.repository,
    checkoutPath: source.checkoutPath, baseSha: source.resolvedSha,
  }))) !== canonicalJsonText(expectedSources.map((source) => ({
    catalogKey: source.catalogKey, repository: source.repository,
    checkoutPath: source.checkoutPath, baseSha: source.baseSha,
  })))) {
    throw new Error("restore repository or base identity does not match the checkpoint");
  }
  const scratch = await exactArtifact(input.artifacts, descriptor, descriptor.manifest.scratchArtifact);
  if (scratch.kind !== "scratch-bundle") throw new Error("scratch checkpoint kind does not match its descriptor");
  const scratchPaths = scratchEntries(scratch.content);
  const privateRootStat = await lstat(input.privateRoot);
  const privateRoot = await realpath(input.privateRoot);
  if (privateRoot !== path.resolve(input.privateRoot) ||
      privateRootStat.uid !== process.getuid?.() || !privateRootStat.isDirectory() || privateRootStat.isSymbolicLink() ||
      (privateRootStat.mode & 0o077) !== 0) {
    throw new Error("restore requires an authenticated private root");
  }
  const root = await mkdtemp(path.join(privateRoot,
    `.codeops-restore-${input.restoreOperationId}-`));
  await chmod(root, 0o700);
  try {
    const exactRoot = await realpath(root);
    if (path.dirname(exactRoot) !== privateRoot) {
      throw new Error("restore workspace escaped its authenticated private root");
    }
    await mkdir(path.join(root, "sources"), { mode: 0o700 });
    for (const [index, source] of workspaceManifest.sources.entries()) {
      const expected = expectedSources[index]!;
      const artifact = await exactArtifact(input.artifacts, descriptor, expected);
      if (artifact.kind !== "source-patch" || artifact.catalogKey !== source.catalogKey ||
          artifact.content.byteLength > 2_000_000 ||
          /(?:^|\n)(?:new file mode|old mode|new mode) (?:120000|160000)(?:\n|$)/.test(
            artifact.content.toString("utf8"))) {
        throw new Error("source checkpoint contains a symlink or special file mode");
      }
      const target = path.join(root, ...source.checkoutPath.split("/"));
      await input.materializeBase({ source, target });
      const targetStat = await lstat(target);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error("restored source is a symlink or special file");
      }
      await rejectNonRegularTree(target);
      const exactTarget = await realpath(target);
      if (!exactTarget.startsWith(`${exactRoot}${path.sep}`)) {
        throw new Error("restored source escaped its fresh private workspace");
      }
      const git = path.join(target, ".git");
      if (!(await lstat(git)).isDirectory()) {
        throw new Error("restored source does not have a private Git directory");
      }
      // Sanitize before even read-only Git commands: status can invoke configured filters.
      await writeFile(path.join(git, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\thooksPath = /dev/null\n", { mode: 0o600 });
      await rm(path.join(git, "hooks"), { recursive: true, force: true });
      await rm(path.join(git, "objects", "info", "alternates"), { force: true });
      await rm(path.join(git, "objects", "info", "http-alternates"), { force: true });
      const env = privateGitEnvironment(root);
      const exactBase = (await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], {
        env, encoding: "utf8",
      })).stdout.trim();
      const dirty = (await execFileAsync("git", ["-C", target, "status",
        "--porcelain=v1", "--untracked-files=all"], { env, encoding: "utf8",
      })).stdout;
      if (exactBase !== source.resolvedSha || dirty !== "") {
        throw new Error("restored source is not the exact clean private base");
      }
      if (artifact.content.byteLength > 0) {
        const patchFile = path.join(root, `.patch-${index}`);
        await writeFile(patchFile, artifact.content, { mode: 0o600, flag: "wx" });
        await execFileAsync("git", ["-C", target, "apply", "--check", "--binary", patchFile], { env });
        await execFileAsync("git", ["-C", target, "apply", "--binary", patchFile], { env });
        await rm(patchFile);
      }
    }
    await restoreScratch(scratchPaths, path.join(root, workspaceManifest.scratchPath));
    await rejectNonRegularTree(root);
    const recaptured = await captureWorkspaceCheckpointArtifacts(
      root, workspaceManifest, input.privateRoot,
    );
    const actualSources = recaptured.sourcePatches.map((source) => ({
      catalogKey: source.catalogKey,
      repository: source.repository,
      checkoutPath: workspaceManifest.sources.find(({ catalogKey }) =>
        catalogKey === source.catalogKey)!.checkoutPath,
      baseSha: source.baseSha,
      bytes: source.content.byteLength,
      digest: source.patchDigest,
    }));
    const exact = canonicalJsonText(actualSources) === canonicalJsonText(
      expectedSources.map(({ artifactId: _artifactId, ...source }) => source),
    ) && recaptured.scratch.content.byteLength === descriptor.manifest.scratchArtifact.bytes &&
      recaptured.scratch.digest === descriptor.manifest.scratchArtifact.digest &&
      recaptured.pathSet.length === descriptor.manifest.pathCount &&
      sha256CanonicalJsonDigest(recaptured.pathSet) === descriptor.manifest.pathSetDigest &&
      recaptured.workspaceManifestDigest === descriptor.manifest.binding.workspaceManifestDigest;
    if (!exact) throw new Error("restored workspace recapture is not exactly equal to its checkpoint");
    const receipt = restoreReceiptSchema.parse({
      version: "codeops.restore-receipt/v1",
      checkpointId: descriptor.manifest.checkpointId,
      binding: descriptor.manifest.binding,
      descriptorDigest: sha256CanonicalJsonDigest(descriptor),
      manifestDigest: descriptor.manifestDigest,
      restoreOperationId: input.restoreOperationId,
      restoredWorkspaceJobUid: input.restoredWorkspaceJobUid,
      restoredResourceConfigurationDigest: input.restoredResourceConfigurationDigest,
      restoredGeneration: input.restoredGeneration,
      restoredPathSetDigest: descriptor.manifest.pathSetDigest,
      restoredAt: input.restoredAt,
    });
    return { workspace: root, receipt };
  } catch (error) {
    // Preserve incomplete restore evidence. Workspace deletion belongs to COAUTO-15.
    throw error;
  }
}

/** Reuse the existing materialized object's exact base with a private Git
 * directory, as captureWorkspacePatch does. No clone URL, repository config,
 * hooks, templates, alternates, or inherited Git environment is consulted. */
export async function materializeCheckpointBase(input: {
  readonly materializedWorkspace: string;
  readonly source: WorkspaceManifest["sources"][number];
  readonly target: string;
}): Promise<void> {
  const sourceRoot = path.join(input.materializedWorkspace, input.source.checkoutPath);
  if (await realpath(sourceRoot) !== path.resolve(sourceRoot)) {
    throw new Error("base materializer source is not an isolated plain directory");
  }
  const objects = path.join(sourceRoot, ".git", "objects");
  if (await realpath(objects) !== path.resolve(objects)) {
    throw new Error("base materializer object directory is not private");
  }
  await rejectNonRegularTree(objects);
  for (const name of ["alternates", "http-alternates"]) {
    try { await lstat(path.join(objects, "info", name)); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("base materializer object alternates are forbidden");
  }
  const parent = path.dirname(input.target);
  if (await realpath(parent) !== path.resolve(parent)) throw new Error("base target parent escaped");
  await mkdir(input.target, { mode: 0o700 });
  const git = path.join(input.target, ".git");
  await mkdir(git, { mode: 0o700 });
  await cp(objects, path.join(git, "objects"), { recursive: true, dereference: false,
    force: false, errorOnExist: true });
  await rejectNonRegularTree(input.target);
  await mkdir(path.join(git, "refs"));
  await writeFile(path.join(git, "HEAD"), input.source.resolvedSha + "\n", { flag: "wx" });
  await writeFile(path.join(git, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\thooksPath = /dev/null\n", { flag: "wx" });
  const env = privateGitEnvironment(input.target);
  const tree = (await execFileAsync("git", ["-C", input.target, "ls-tree", "-rlz",
    input.source.resolvedSha], { env, encoding: "utf8", maxBuffer: 24_000_000 })).stdout;
  let checkoutBytes = 0n;
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob [0-9a-f]{40} +([0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("base tree contains a symlink or special file");
    checkoutBytes += BigInt(match[2]!);
    safeRelativePath(match[3]);
  }
  // The copied object database already occupies the same workspace PVC.
  // Check full base checkout size, not just the bounded checkpoint patch.
  const capacity = await statfs(input.target, { bigint: true });
  if (capacity.bavail * capacity.bsize < checkoutBytes) {
    throw new Error("workspace recovery backing has insufficient base checkout capacity");
  }
  await execFileAsync("git", ["-C", input.target, "read-tree", "--reset", "-u",
    input.source.resolvedSha], { env });
  await rejectNonRegularTree(input.target);
}
