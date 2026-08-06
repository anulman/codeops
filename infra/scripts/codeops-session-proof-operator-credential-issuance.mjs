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
  issueFirstSessionProofCredentialsFromOperatorPacket,
} from "./codeops-session-proof-credential-issuer.mjs";
import {
  readSessionProofOperatorCreationReceipt,
} from "./codeops-session-proof-operator-namespace-create.mjs";

function assertOutputPath(path, packetPath, namespace, suffix, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof first-step output path must be absolute and normalized");
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
    throw new Error("proof first-step output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof first-step output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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
    throw new Error("proof first-step output must be one bounded private regular file");
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
      throw new Error("proof first-step output changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
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
    throw new Error("proof first-step output changed while it was written");
  }
}

export function persistFirstSessionProofCredentialIssuanceFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const operatorInput = readSessionProofOperatorCreationReceipt(input);
  const namespace = operatorInput.creationReceipt.namespace.name;
  assertOutputPath(
    input.evidencePath,
    input.packetPath,
    namespace,
    "step-02-issue-broker-capabilities.evidence.json",
    true,
  );
  assertOutputPath(
    input.stepReceiptPath,
    input.packetPath,
    namespace,
    "step-02-issue-broker-capabilities.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.evidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.evidencePath);
    receiptDescriptor = reservePrivateOutput(input.stepReceiptPath);
    syncParent(input.stepReceiptPath);
    const result = issueFirstSessionProofCredentialsFromOperatorPacket(input, runner);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.evidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.stepReceiptPath, receiptSource);
    syncParent(input.evidencePath);
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

export function readFirstSessionProofCredentialOutputsFromOperatorPacket(input) {
  const operatorInput = readSessionProofOperatorCreationReceipt(input);
  const namespace = operatorInput.creationReceipt.namespace.name;
  assertOutputPath(
    input.evidencePath,
    input.packetPath,
    namespace,
    "step-02-issue-broker-capabilities.evidence.json",
    false,
  );
  assertOutputPath(
    input.stepReceiptPath,
    input.packetPath,
    namespace,
    "step-02-issue-broker-capabilities.receipt.json",
    false,
  );
  return {
    ...operatorInput,
    evidenceSource: readPrivateOutput(input.evidencePath).toString("utf8"),
    stepReceiptSource: readPrivateOutput(input.stepReceiptPath).toString("utf8"),
  };
}
