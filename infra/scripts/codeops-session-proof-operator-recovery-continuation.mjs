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
import { recoverSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-recovery-step-authorization.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";

function assertRecoveryContinuationPath(path, packetPath, namespace, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof recovery continuation path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.recovery-continuation.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof recovery continuation path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof recovery continuation already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function writePrivateRecoveryContinuation(path, source) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
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
      throw new Error("proof recovery continuation changed while it was written");
    }
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function readPrivateRecoveryContinuation(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof recovery continuation must be one bounded private regular file");
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
      throw new Error("proof recovery continuation changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
  }
}

export function authorizeSessionProofRecoveryContinuationFromOperatorPacket(
  input,
  runner = execFileSync,
  readGatewayMigrationWaitOutputs =
    readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
  recoverAdmission = recoverSessionProofAdmission,
) {
  // The default reader canonically replays the recovered step-7 authorization,
  // its exact predecessor chain, and its completed evidence and receipt.
  const outputs = readGatewayMigrationWaitOutputs(input, runner);
  if (outputs.creationReceipt?.proceed !== true) {
    throw new Error("proof Namespace creation did not complete");
  }
  const sourceAdmissionSource =
    `${JSON.stringify(outputs.creationReceipt.admission, null, 2)}\n`;
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const admission = recoverAdmission(outputs.creationReceipt.admission, {
    sourceAdmissionSource,
    predecessorStepId: "wait-gateway-migration",
    predecessorReceiptSource: outputs.sixthStepReceiptSource,
    namespaceResource,
    operator,
    target,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
  });
  if (admission.authorizedSteps?.[0] !== "grant-receipts") {
    throw new Error("proof recovery continuation did not begin at receipt grants");
  }
  return {
    admission,
    admissionSource: `${JSON.stringify(admission, null, 2)}\n`,
    gatewayMigrationWaitOutputs: outputs,
  };
}

export function persistSessionProofRecoveryContinuationFromOperatorPacket(
  input,
  runner = execFileSync,
  readGatewayMigrationWaitOutputs =
    readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
  recoverAdmission = recoverSessionProofAdmission,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertRecoveryContinuationPath(
    input.recoveryContinuationPath,
    input.packetPath,
    namespace,
    true,
  );
  const result = authorizeSessionProofRecoveryContinuationFromOperatorPacket(
    input,
    runner,
    readGatewayMigrationWaitOutputs,
    recoverAdmission,
  );
  if (result.admission.identity.namespace !== namespace) {
    throw new Error("proof recovery continuation Namespace drifted from the operator packet path");
  }
  writePrivateRecoveryContinuation(
    input.recoveryContinuationPath,
    result.admissionSource,
  );
  return result;
}

export function readSessionProofRecoveryContinuationFromOperatorPacket(
  input,
  runner = execFileSync,
  readGatewayMigrationWaitOutputs =
    readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
  recoverAdmission = recoverSessionProofAdmission,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertRecoveryContinuationPath(
    input.recoveryContinuationPath,
    input.packetPath,
    namespace,
    false,
  );
  const bytes = readPrivateRecoveryContinuation(input.recoveryContinuationPath);
  let persisted;
  try {
    persisted = JSON.parse(bytes);
  } catch {
    throw new Error("proof recovery continuation must be valid JSON");
  }
  const result = authorizeSessionProofRecoveryContinuationFromOperatorPacket({
    ...input,
    approvedAt: persisted.approvedAt,
    expiresAt: persisted.expiresAt,
  }, runner, readGatewayMigrationWaitOutputs, recoverAdmission);
  if (!bytes.equals(Buffer.from(result.admissionSource))) {
    throw new Error("proof recovery continuation is not the exact persisted artifact");
  }
  return result;
}
