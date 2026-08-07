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
import { applySessionProofRuntime } from "./codeops-session-proof-runtime-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readFifteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-step-authorization.mjs";
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
    throw new Error("proof runtime apply output path must be absolute and normalized");
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
    throw new Error("proof runtime apply output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof runtime apply output already exists");
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
    throw new Error("proof runtime apply output must be one bounded private regular file");
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
      throw new Error("proof runtime apply output changed while it was read");
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
    throw new Error("proof runtime apply output changed while it was written");
  }
}

export function applySessionProofRuntimeFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofRuntime,
) {
  const { authorization } =
    readFifteenthSessionProofStepAuthorizationFromOperatorPacket(input, runner);
  const manifestSource = readSessionProofOperatorArtifact(input, "runtime");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}

export function persistSessionProofRuntimeApplyFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofRuntime,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.fifteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-18-start-runtime.evidence.json",
    true,
  );
  assertOutputPath(
    input.fifteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-18-start-runtime.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.fifteenthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.fifteenthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.fifteenthStepReceiptPath);
    syncParent(input.fifteenthStepReceiptPath);
    const result = applySessionProofRuntimeFromOperatorPacket(input, runner, apply);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.fifteenthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.fifteenthStepReceiptPath, receiptSource);
    syncParent(input.fifteenthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofRuntimeApplyOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
  readAuthorization = readFifteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, uiReadinessOutputs } =
    readAuthorization(input, runner);
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.fifteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-18-start-runtime.evidence.json",
    false,
  );
  assertOutputPath(
    input.fifteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-18-start-runtime.receipt.json",
    false,
  );
  const fifteenthEvidenceSource = readPrivateOutput(input.fifteenthEvidencePath)
    .toString("utf8");
  const fifteenthStepReceiptSource = readPrivateOutput(input.fifteenthStepReceiptPath)
    .toString("utf8");
  const evidence = parseJson(fifteenthEvidenceSource, "proof runtime apply evidence");
  const receipt = parseJson(fifteenthStepReceiptSource, "proof runtime apply receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof runtime apply output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: fifteenthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (fifteenthStepReceiptSource !== expectedSource) {
    throw new Error("proof runtime apply receipt is not the exact persisted artifact");
  }
  return {
    ...uiReadinessOutputs,
    fifteenthAuthorization: authorization,
    fifteenthEvidenceSource,
    fifteenthStepReceiptSource,
  };
}
