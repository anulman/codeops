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
import { readSessionProofGatewayApplyOutputsFromOperatorPacket } from "./codeops-session-proof-operator-gateway-apply.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";

function assertRecoveryAdmissionPath(path, packetPath, namespace, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof recovery admission path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.recovery-admission.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof recovery admission path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof recovery admission already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function writePrivateRecoveryAdmission(path, source) {
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
      throw new Error("proof recovery admission changed while it was written");
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

function readPrivateRecoveryAdmission(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof recovery admission must be one bounded private regular file");
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
      throw new Error("proof recovery admission changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function buildRecoveryAdmission(input, runner, readOutputs) {
  // The default reader canonically replays creation plus all five completed
  // step receipts through start-gateway before returning these bytes.
  const outputs = readOutputs(input, runner);
  if (outputs.creationReceipt?.proceed !== true) {
    throw new Error("proof Namespace creation did not complete");
  }
  const sourceAdmissionSource = `${JSON.stringify(outputs.creationReceipt.admission, null, 2)}\n`;
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  return recoverSessionProofAdmission(outputs.creationReceipt.admission, {
    sourceAdmissionSource,
    predecessorStepId: "start-gateway",
    predecessorReceiptSource: outputs.fifthStepReceiptSource,
    namespaceResource,
    operator,
    target,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
  });
}

export function persistSessionProofRecoveryAdmissionFromOperatorPacket(
  input,
  runner = execFileSync,
  readOutputs = readSessionProofGatewayApplyOutputsFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertRecoveryAdmissionPath(
    input.recoveryAdmissionPath,
    input.packetPath,
    namespace,
    true,
  );
  const admission = buildRecoveryAdmission(input, runner, readOutputs);
  if (admission.identity.namespace !== namespace) {
    throw new Error("proof recovery admission Namespace drifted from the operator packet path");
  }
  const source = `${JSON.stringify(admission, null, 2)}\n`;
  writePrivateRecoveryAdmission(input.recoveryAdmissionPath, source);
  return { admission, admissionSource: source };
}

export function readSessionProofRecoveryAdmissionFromOperatorPacket(
  input,
  runner = execFileSync,
  readOutputs = readSessionProofGatewayApplyOutputsFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertRecoveryAdmissionPath(
    input.recoveryAdmissionPath,
    input.packetPath,
    namespace,
    false,
  );
  const bytes = readPrivateRecoveryAdmission(input.recoveryAdmissionPath);
  let persisted;
  try {
    persisted = JSON.parse(bytes);
  } catch {
    throw new Error("proof recovery admission must be valid JSON");
  }
  const admission = buildRecoveryAdmission({
    ...input,
    approvedAt: persisted.approvedAt,
    expiresAt: persisted.expiresAt,
  }, runner, readOutputs);
  const source = `${JSON.stringify(admission, null, 2)}\n`;
  if (!bytes.equals(Buffer.from(source))) {
    throw new Error("proof recovery admission is not the exact persisted artifact");
  }
  return { admission, admissionSource: source };
}
