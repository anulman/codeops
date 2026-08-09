import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { replaceSessionProofCodexSmoke } from "./codeops-session-proof-codex-smoke-replace.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofCodexLoginWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait.mjs";
import {
  readEleventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-step-authorization.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function assertOutputPath(path, packetPath, namespace, suffix, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof Codex smoke replacement output path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.${suffix}` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof Codex smoke replacement output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof Codex smoke replacement output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function reservePrivateOutput(path) {
  return openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
}

function reopenPrivateReservation(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size !== 0
  ) {
    throw new Error("proof Codex smoke replacement reservation is not one empty private regular file");
  }
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  const after = lstatSync(path);
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== 0 ||
    after.ctimeMs !== before.ctimeMs ||
    after.mtimeMs !== before.mtimeMs ||
    (after.mode & 0o777) !== 0o600
  ) {
    closeSync(descriptor);
    throw new Error("proof Codex smoke replacement reservation changed while it was reopened");
  }
  return descriptor;
}

function readPrivateOutput(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof Codex smoke replacement output must be one bounded private regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const source = readFileSync(descriptor);
    const opened = fstatSync(descriptor);
    const after = lstatSync(path);
    if (
      source.length !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      (after.mode & 0o777) !== 0o600
    ) {
      throw new Error("proof Codex smoke replacement output changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function syncParent(path) {
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function writePrivateOutput(descriptor, path, source) {
  writeFileSync(descriptor, source);
  fsyncSync(descriptor);
  const opened = fstatSync(descriptor);
  const linked = lstatSync(path);
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    opened.dev !== linked.dev ||
    opened.ino !== linked.ino ||
    opened.size !== Buffer.byteLength(source) ||
    linked.size !== opened.size ||
    (linked.mode & 0o777) !== 0o600
  ) {
    throw new Error("proof Codex smoke replacement output changed while it was written");
  }
}

export function replaceSessionProofCodexSmokeFromOperatorPacket(
  input,
  runner = execFileSync,
  replace = replaceSessionProofCodexSmoke,
) {
  const { authorization } = readEleventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofCodexLoginWaitOutputsFromOperatorPacket(input, runner);
  const manifestSource = readSessionProofOperatorArtifact(input, "codex-smoke");
  return replace({
    authorization,
    manifestSource,
    loginCompletionReceiptSource: outputs.tenthStepReceiptSource,
    loginCompletionEvidenceSource: outputs.tenthEvidenceSource,
    resumeAfterLoginDeletion: input.resumeAfterLoginDeletion,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, { runner });
}

export async function persistSessionProofCodexSmokeReplacementFromOperatorPacket(
  input,
  runner = execFileSync,
  replace = replaceSessionProofCodexSmoke,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.eleventhEvidencePath,
    input.packetPath,
    namespace,
    "step-12-codex-smoke.evidence.json",
    input.resumeInterruptedReservation !== true,
  );
  assertOutputPath(
    input.eleventhStepReceiptPath,
    input.packetPath,
    namespace,
    "step-12-codex-smoke.receipt.json",
    input.resumeInterruptedReservation !== true,
  );

  const openOutput = input.resumeInterruptedReservation === true
    ? reopenPrivateReservation
    : reservePrivateOutput;
  const evidenceDescriptor = openOutput(input.eleventhEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.eleventhEvidencePath);
    receiptDescriptor = openOutput(input.eleventhStepReceiptPath);
    syncParent(input.eleventhStepReceiptPath);
    const result = await replaceSessionProofCodexSmokeFromOperatorPacket(
      input,
      runner,
      replace,
    );
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.eleventhEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.eleventhStepReceiptPath, receiptSource);
    syncParent(input.eleventhEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofCodexSmokeReplacementOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const priorOutputs = readSessionProofCodexLoginWaitOutputsFromOperatorPacket(input, runner);
  const { authorization } = readEleventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.eleventhEvidencePath,
    input.packetPath,
    namespace,
    "step-12-codex-smoke.evidence.json",
    false,
  );
  assertOutputPath(
    input.eleventhStepReceiptPath,
    input.packetPath,
    namespace,
    "step-12-codex-smoke.receipt.json",
    false,
  );
  const eleventhEvidenceSource = readPrivateOutput(input.eleventhEvidencePath).toString("utf8");
  const eleventhStepReceiptSource = readPrivateOutput(input.eleventhStepReceiptPath)
    .toString("utf8");
  const evidence = parseJson(eleventhEvidenceSource, "proof Codex smoke replacement evidence");
  const receipt = parseJson(eleventhStepReceiptSource, "proof Codex smoke replacement receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof Codex smoke replacement output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: eleventhEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (eleventhStepReceiptSource !== expectedSource) {
    throw new Error("proof Codex smoke replacement receipt is not the exact persisted artifact");
  }
  return {
    ...priorOutputs,
    eleventhAuthorization: authorization,
    eleventhEvidenceSource,
    eleventhStepReceiptSource,
  };
}
