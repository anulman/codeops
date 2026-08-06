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
import { waitForSessionProofGrants } from "./codeops-session-proof-grant-wait.mjs";
import {
  readSessionProofGrantApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-apply.mjs";
import {
  readEighthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait-authorization.mjs";
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
    throw new Error("proof grant completion output path must be absolute and normalized");
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
    throw new Error("proof grant completion output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof grant completion output already exists");
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
    throw new Error("proof grant completion output must be one bounded private regular file");
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
      throw new Error("proof grant completion output changed while it was read");
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
    throw new Error("proof grant completion output changed while it was written");
  }
}

export function waitForSessionProofGrantsFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGrants = waitForSessionProofGrants,
) {
  const { authorization } = readEighthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofGrantApplyOutputsFromOperatorPacket(input, runner);
  return waitForGrants({
    authorization,
    grantApplyReceiptSource: outputs.seventhStepReceiptSource,
    grantApplyEvidenceSource: outputs.seventhEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}

export function persistSessionProofGrantWaitFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGrants = waitForSessionProofGrants,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.eighthEvidencePath,
    input.packetPath,
    namespace,
    "step-09-wait-grants.evidence.json",
    true,
  );
  assertOutputPath(
    input.eighthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-09-wait-grants.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.eighthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.eighthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.eighthStepReceiptPath);
    syncParent(input.eighthStepReceiptPath);
    const result = waitForSessionProofGrantsFromOperatorPacket(input, runner, waitForGrants);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.eighthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.eighthStepReceiptPath, receiptSource);
    syncParent(input.eighthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofGrantWaitOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const priorOutputs = readSessionProofGrantApplyOutputsFromOperatorPacket(input, runner);
  const { authorization } = readEighthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.eighthEvidencePath,
    input.packetPath,
    namespace,
    "step-09-wait-grants.evidence.json",
    false,
  );
  assertOutputPath(
    input.eighthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-09-wait-grants.receipt.json",
    false,
  );
  const eighthEvidenceSource = readPrivateOutput(input.eighthEvidencePath).toString("utf8");
  const eighthStepReceiptSource = readPrivateOutput(input.eighthStepReceiptPath).toString("utf8");
  const evidence = parseJson(eighthEvidenceSource, "proof grant completion evidence");
  const receipt = parseJson(eighthStepReceiptSource, "proof grant completion receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof grant completion output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: eighthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (eighthStepReceiptSource !== expectedSource) {
    throw new Error("proof grant completion receipt is not the exact persisted artifact");
  }
  return {
    ...priorOutputs,
    eighthAuthorization: authorization,
    eighthEvidenceSource,
    eighthStepReceiptSource,
  };
}
