import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";

const ARTIFACTS = new Map([
  ["browser/video/raw.webm", 1_500_000_000],
  ["browser/trace.zip", 256_000_000],
  ["session/export.json", 32_000_000],
  ["assertions.json", 1_000_000],
]);
const DIRECTORIES = new Set(["browser", "browser/video", "session"]);

function readAndVerifyLiveIdentity(authorization, observedAt, runner) {
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(authorization.namespace.name, runner);
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId,
    namespaceResource,
    operator,
    target,
    observedAt,
  });
  return { namespaceResource, operator, target };
}

function assertStableFile(before, after, path) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`proof recording artifact changed while reading: ${path}`);
  }
}

function inspectTree(root, relativeDirectory = "") {
  const entries = readdirSync(join(root, relativeDirectory), { withFileTypes: true });
  const files = [];
  const directories = [];
  for (const entry of entries) {
    const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`proof recording artifact tree contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      directories.push(path);
      const nested = inspectTree(root, path);
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`proof recording artifact tree contains a non-file entry: ${path}`);
    }
  }
  return { directories, files };
}

function readArtifacts(captureDirectory) {
  if (!isAbsolute(captureDirectory ?? "")) {
    throw new Error("proof recording capture directory must be absolute");
  }
  const root = resolve(captureDirectory);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("proof recording capture directory must be a real directory");
  }
  const tree = inspectTree(root);
  if (
    JSON.stringify(tree.directories.sort()) !== JSON.stringify([...DIRECTORIES].sort()) ||
    JSON.stringify(tree.files.sort()) !== JSON.stringify([...ARTIFACTS.keys()].sort())
  ) {
    throw new Error("proof recording artifact tree is incomplete or contains extras");
  }

  const artifacts = {};
  for (const [path, maxBytes] of ARTIFACTS) {
    const absolutePath = join(root, path);
    const realPath = realpathSync(absolutePath);
    const withinRoot = relative(root, realPath);
    if (withinRoot.startsWith(`..${sep}`) || withinRoot === ".." || isAbsolute(withinRoot)) {
      throw new Error(`proof recording artifact escapes capture directory: ${path}`);
    }
    const descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
        throw new Error(`proof recording artifact size or type drifted: ${path}`);
      }
      const source = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      assertStableFile(before, after, path);
      if (BigInt(source.length) !== before.size) {
        throw new Error(`proof recording artifact read was incomplete: ${path}`);
      }
      artifacts[path] = source;
    } finally {
      closeSync(descriptor);
    }
  }
  return artifacts;
}

export function completeSessionProofRecording(input, runner = execFileSync) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "record-proof" ||
    authorization.action !== "operator-record-and-export-evidence" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not the exact recording/export action");
  }

  const artifacts = readArtifacts(input.captureDirectory);
  const evidence = buildSessionProofRecordEvidence({
    authorization,
    runtimeReadinessReceiptSource: input.runtimeReadinessReceiptSource,
    runtimeReadinessEvidenceSource: input.runtimeReadinessEvidenceSource,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    observedAt: input.completedAt,
    inspection: input.inspection,
    artifacts,
  });
  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
