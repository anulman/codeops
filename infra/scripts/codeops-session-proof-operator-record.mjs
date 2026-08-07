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
import {
  readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-record-authorization.mjs";
import { verifySessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";
import { completeSessionProofRecording } from "./codeops-session-proof-record.mjs";
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
    throw new Error("proof recording output path must be absolute and normalized");
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
    throw new Error("proof recording output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof recording output already exists");
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

function readPrivateOutput(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof recording output must be one bounded private regular file");
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
      throw new Error("proof recording output changed while it was read");
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
    throw new Error("proof recording output changed while it was written");
  }
}

export function completeSessionProofRecordingFromOperatorPacket(
  input,
  runner = execFileSync,
  record = completeSessionProofRecording,
  readAuthorization = readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeWaitOutputs } = readAuthorization(input, runner);
  return record({
    authorization,
    runtimeReadinessReceiptSource: runtimeWaitOutputs.sixteenthStepReceiptSource,
    runtimeReadinessEvidenceSource: runtimeWaitOutputs.sixteenthEvidenceSource,
    captureDirectory: input.captureDirectory,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    completedAt: input.completedAt,
    inspection: input.inspection,
  }, runner);
}

export function persistSessionProofRecordingFromOperatorPacket(
  input,
  runner = execFileSync,
  complete = completeSessionProofRecordingFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.seventeenthEvidencePath,
    input.packetPath,
    namespace,
    "step-21-record-proof.evidence.json",
    true,
  );
  assertOutputPath(
    input.seventeenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-21-record-proof.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.seventeenthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.seventeenthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.seventeenthStepReceiptPath);
    syncParent(input.seventeenthStepReceiptPath);
    const result = complete(input, runner);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.seventeenthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.seventeenthStepReceiptPath, receiptSource);
    syncParent(input.seventeenthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofRecordingOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
  readAuthorization = readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeWaitOutputs } = readAuthorization(input, runner);
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.seventeenthEvidencePath,
    input.packetPath,
    namespace,
    "step-21-record-proof.evidence.json",
    false,
  );
  assertOutputPath(
    input.seventeenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-21-record-proof.receipt.json",
    false,
  );
  const seventeenthEvidenceSource = readPrivateOutput(input.seventeenthEvidencePath)
    .toString("utf8");
  const seventeenthStepReceiptSource = readPrivateOutput(input.seventeenthStepReceiptPath)
    .toString("utf8");
  const evidence = parseJson(seventeenthEvidenceSource, "proof recording evidence");
  const receipt = parseJson(seventeenthStepReceiptSource, "proof recording receipt");
  verifySessionProofRecordEvidence(authorization, evidence);
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof recording output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: seventeenthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (seventeenthStepReceiptSource !== expectedSource) {
    throw new Error("proof recording receipt is not the exact persisted artifact");
  }
  return {
    ...runtimeWaitOutputs,
    seventeenthAuthorization: authorization,
    seventeenthEvidenceSource,
    seventeenthStepReceiptSource,
  };
}
