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
import { issueSessionProofCredentials } from "./codeops-session-proof-credential-issuer.mjs";
import {
  readSecondSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-next-step-authorization.mjs";

function assertOutputPath(path, packetPath, namespace, suffix) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof second-step output path must be absolute and normalized");
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
    throw new Error("proof second-step output path must derive exactly from the packet Namespace");
  }
  try {
    lstatSync(path);
    throw new Error("proof second-step output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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
    throw new Error("proof second-step output changed while it was written");
  }
}

export function issueSecondSessionProofCredentialsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const { authorization } = readSecondSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  return issueSessionProofCredentials({
    authorization,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    registryConfigFile: input.registryConfigFile,
    repositoryTokenFile: input.repositoryTokenFile,
  }, runner);
}

export function persistSecondSessionProofCredentialIssuanceFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const { authorization } = readSecondSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.secondEvidencePath,
    input.packetPath,
    namespace,
    "step-03-issue-runtime-capabilities.evidence.json",
  );
  assertOutputPath(
    input.secondStepReceiptPath,
    input.packetPath,
    namespace,
    "step-03-issue-runtime-capabilities.receipt.json",
  );

  const evidenceDescriptor = reservePrivateOutput(input.secondEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.secondEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.secondStepReceiptPath);
    syncParent(input.secondStepReceiptPath);
    const result = issueSecondSessionProofCredentialsFromOperatorPacket(input, runner);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.secondEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.secondStepReceiptPath, receiptSource);
    syncParent(input.secondEvidencePath);
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
