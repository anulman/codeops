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
import { waitForSessionProofGatewayMigration } from "./codeops-session-proof-gateway-wait.mjs";
import {
  readSessionProofGatewayApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-apply.mjs";
import {
  readSixthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait-authorization.mjs";
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
    throw new Error("proof gateway readiness output path must be absolute and normalized");
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
    throw new Error("proof gateway readiness output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof gateway readiness output already exists");
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
    throw new Error("proof gateway readiness output must be one bounded private regular file");
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
      throw new Error("proof gateway readiness output changed while it was read");
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
    throw new Error("proof gateway readiness output changed while it was written");
  }
}

export function waitForSessionProofGatewayMigrationFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGatewayMigration = waitForSessionProofGatewayMigration,
) {
  const { authorization } = readSixthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofGatewayApplyOutputsFromOperatorPacket(input, runner);
  return waitForGatewayMigration({
    authorization,
    gatewayApplyReceiptSource: outputs.fifthStepReceiptSource,
    gatewayApplyEvidenceSource: outputs.fifthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}

export function persistSessionProofGatewayMigrationWaitFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGatewayMigration = waitForSessionProofGatewayMigration,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.sixthEvidencePath,
    input.packetPath,
    namespace,
    "step-07-wait-gateway-migration.evidence.json",
    true,
  );
  assertOutputPath(
    input.sixthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-07-wait-gateway-migration.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.sixthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.sixthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.sixthStepReceiptPath);
    syncParent(input.sixthStepReceiptPath);
    const result = waitForSessionProofGatewayMigrationFromOperatorPacket(
      input,
      runner,
      waitForGatewayMigration,
    );
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.sixthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.sixthStepReceiptPath, receiptSource);
    syncParent(input.sixthEvidencePath);
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

export function readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const priorOutputs = readSessionProofGatewayApplyOutputsFromOperatorPacket(input, runner);
  const { authorization } = readSixthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.sixthEvidencePath,
    input.packetPath,
    namespace,
    "step-07-wait-gateway-migration.evidence.json",
    false,
  );
  assertOutputPath(
    input.sixthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-07-wait-gateway-migration.receipt.json",
    false,
  );
  const sixthEvidenceSource = readPrivateOutput(input.sixthEvidencePath).toString("utf8");
  const sixthStepReceiptSource = readPrivateOutput(input.sixthStepReceiptPath).toString("utf8");
  const evidence = parseJson(sixthEvidenceSource, "proof gateway readiness evidence");
  const receipt = parseJson(sixthStepReceiptSource, "proof gateway readiness receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof gateway readiness output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: sixthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (sixthStepReceiptSource !== expectedSource) {
    throw new Error("proof gateway readiness receipt is not the exact persisted artifact");
  }
  return {
    ...priorOutputs,
    sixthAuthorization: authorization,
    sixthEvidenceSource,
    sixthStepReceiptSource,
  };
}
