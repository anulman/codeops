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
import { applySessionProofCodexLogin } from "./codeops-session-proof-codex-login-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readNinthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-step-authorization.mjs";
import {
  readSessionProofGrantWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait.mjs";
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
    throw new Error("proof Codex login output path must be absolute and normalized");
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
    throw new Error("proof Codex login output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof Codex login output already exists");
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
    throw new Error("proof Codex login output must be one bounded private regular file");
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
      throw new Error("proof Codex login output changed while it was read");
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
    throw new Error("proof Codex login output changed while it was written");
  }
}

export function applySessionProofCodexLoginFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofCodexLogin,
) {
  const { authorization } = readNinthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "codex-login");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}

export function persistSessionProofCodexLoginApplyFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofCodexLogin,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.ninthEvidencePath,
    input.packetPath,
    namespace,
    "step-10-codex-login.evidence.json",
    true,
  );
  assertOutputPath(
    input.ninthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-10-codex-login.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.ninthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.ninthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.ninthStepReceiptPath);
    syncParent(input.ninthStepReceiptPath);
    const result = applySessionProofCodexLoginFromOperatorPacket(input, runner, apply);
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.ninthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.ninthStepReceiptPath, receiptSource);
    syncParent(input.ninthEvidencePath);
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

export function readSessionProofCodexLoginApplyOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const priorOutputs = readSessionProofGrantWaitOutputsFromOperatorPacket(input, runner);
  const { authorization } = readNinthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.ninthEvidencePath,
    input.packetPath,
    namespace,
    "step-10-codex-login.evidence.json",
    false,
  );
  assertOutputPath(
    input.ninthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-10-codex-login.receipt.json",
    false,
  );
  const ninthEvidenceSource = readPrivateOutput(input.ninthEvidencePath).toString("utf8");
  const ninthStepReceiptSource = readPrivateOutput(input.ninthStepReceiptPath).toString("utf8");
  const evidence = parseJson(ninthEvidenceSource, "proof Codex login apply evidence");
  const receipt = parseJson(ninthStepReceiptSource, "proof Codex login apply receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof Codex login apply output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: ninthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (ninthStepReceiptSource !== expectedSource) {
    throw new Error("proof Codex login apply receipt is not the exact persisted artifact");
  }
  return {
    ...priorOutputs,
    ninthAuthorization: authorization,
    ninthEvidenceSource,
    ninthStepReceiptSource,
  };
}
