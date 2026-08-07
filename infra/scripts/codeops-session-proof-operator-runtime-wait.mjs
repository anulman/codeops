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
  readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait-authorization.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  verifySessionProofRuntimeReadinessEvidence,
} from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import { waitForSessionProofRuntime } from "./codeops-session-proof-runtime-wait.mjs";
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
    throw new Error("proof runtime readiness output path must be absolute and normalized");
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
    throw new Error("proof runtime readiness output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof runtime readiness output already exists");
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
    throw new Error("proof runtime readiness output must be one bounded private regular file");
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
      throw new Error("proof runtime readiness output changed while it was read");
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
    throw new Error("proof runtime readiness output changed while it was written");
  }
}

export function waitForSessionProofRuntimeFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForRuntime = waitForSessionProofRuntime,
  readAuthorization = readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeApplyOutputs } = readAuthorization(input, runner);
  return waitForRuntime({
    authorization,
    runtimeApplyReceiptSource: runtimeApplyOutputs.fifteenthStepReceiptSource,
    runtimeApplyEvidenceSource: runtimeApplyOutputs.fifteenthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}

export function persistSessionProofRuntimeWaitFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForRuntime = waitForSessionProofRuntime,
  readAuthorization = readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.sixteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-20-wait-runtime.evidence.json",
    true,
  );
  assertOutputPath(
    input.sixteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-20-wait-runtime.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.sixteenthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.sixteenthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.sixteenthStepReceiptPath);
    syncParent(input.sixteenthStepReceiptPath);
    const result = waitForSessionProofRuntimeFromOperatorPacket(
      input,
      runner,
      waitForRuntime,
      readAuthorization,
    );
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.sixteenthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.sixteenthStepReceiptPath, receiptSource);
    syncParent(input.sixteenthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofRuntimeWaitOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
  readAuthorization = readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeApplyOutputs } = readAuthorization(input, runner);
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.sixteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-20-wait-runtime.evidence.json",
    false,
  );
  assertOutputPath(
    input.sixteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-20-wait-runtime.receipt.json",
    false,
  );
  const sixteenthEvidenceSource = readPrivateOutput(input.sixteenthEvidencePath)
    .toString("utf8");
  const sixteenthStepReceiptSource = readPrivateOutput(input.sixteenthStepReceiptPath)
    .toString("utf8");
  const evidence = parseJson(sixteenthEvidenceSource, "proof runtime readiness evidence");
  const receipt = parseJson(sixteenthStepReceiptSource, "proof runtime readiness receipt");
  verifySessionProofRuntimeReadinessEvidence(authorization, evidence);
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof runtime readiness output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: sixteenthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (sixteenthStepReceiptSource !== expectedSource) {
    throw new Error("proof runtime readiness receipt is not the exact persisted artifact");
  }
  return {
    ...runtimeApplyOutputs,
    sixteenthAuthorization: authorization,
    sixteenthEvidenceSource,
    sixteenthStepReceiptSource,
  };
}
