import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { applySessionProofDatabase } from "./codeops-session-proof-database-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readThirdSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-database-step-authorization.mjs";
import {
  readSessionProofOperatorCreationReceipt,
} from "./codeops-session-proof-operator-namespace-create.mjs";

function assertOutputPath(path, packetPath, namespace, suffix, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof database output path must be absolute and normalized");
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
    throw new Error("proof database output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof database output already exists");
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
    throw new Error("proof database output changed while it was written");
  }
}

export function applySessionProofDatabaseFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofDatabase,
) {
  const { authorization } = readThirdSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "database");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}

export function persistSessionProofDatabaseApplyFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofDatabase,
) {
  const operatorInput = readSessionProofOperatorCreationReceipt(input);
  const namespace = operatorInput.creationReceipt.namespace.name;
  assertOutputPath(
    input.thirdEvidencePath,
    input.packetPath,
    namespace,
    "step-04-start-database.evidence.json",
    true,
  );
  assertOutputPath(
    input.thirdStepReceiptPath,
    input.packetPath,
    namespace,
    "step-04-start-database.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.thirdEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.thirdEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.thirdStepReceiptPath);
    syncParent(input.thirdStepReceiptPath);
    const result = applySessionProofDatabaseFromOperatorPacket(input, runner, apply);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.thirdEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.thirdStepReceiptPath, receiptSource);
    syncParent(input.thirdEvidencePath);
    return {
      evidenceSource: result.evidenceSource,
      receiptSource,
      receipt: result.receipt,
    };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}
