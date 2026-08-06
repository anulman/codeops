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
import { applySessionProofGrants } from "./codeops-session-proof-grant-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readSeventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-step-authorization.mjs";
import {
  readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait.mjs";
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
    throw new Error("proof grant output path must be absolute and normalized");
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
    throw new Error("proof grant output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof grant output already exists");
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
    throw new Error("proof grant output must be one bounded private regular file");
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
      throw new Error("proof grant output changed while it was read");
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
    throw new Error("proof grant output changed while it was written");
  }
}

export function applySessionProofGrantsFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofGrants,
) {
  const { authorization } = readSeventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "grants");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}

export function persistSessionProofGrantApplyFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofGrants,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.seventhEvidencePath,
    input.packetPath,
    namespace,
    "step-08-grant-receipts.evidence.json",
    true,
  );
  assertOutputPath(
    input.seventhStepReceiptPath,
    input.packetPath,
    namespace,
    "step-08-grant-receipts.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.seventhEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.seventhEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.seventhStepReceiptPath);
    syncParent(input.seventhStepReceiptPath);
    const result = applySessionProofGrantsFromOperatorPacket(input, runner, apply);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.seventhEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.seventhStepReceiptPath, receiptSource);
    syncParent(input.seventhEvidencePath);
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

export function readSessionProofGrantApplyOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const priorOutputs = readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
    input,
    runner,
  );
  const { authorization } = readSeventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.seventhEvidencePath,
    input.packetPath,
    namespace,
    "step-08-grant-receipts.evidence.json",
    false,
  );
  assertOutputPath(
    input.seventhStepReceiptPath,
    input.packetPath,
    namespace,
    "step-08-grant-receipts.receipt.json",
    false,
  );
  const seventhEvidenceSource = readPrivateOutput(input.seventhEvidencePath).toString("utf8");
  const seventhStepReceiptSource = readPrivateOutput(input.seventhStepReceiptPath).toString("utf8");
  const evidence = parseJson(seventhEvidenceSource, "proof grant apply evidence");
  const receipt = parseJson(seventhStepReceiptSource, "proof grant apply receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof grant apply output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: seventhEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (seventhStepReceiptSource !== expectedSource) {
    throw new Error("proof grant apply receipt is not the exact persisted artifact");
  }
  return {
    ...priorOutputs,
    seventhAuthorization: authorization,
    seventhEvidenceSource,
    seventhStepReceiptSource,
  };
}
