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
import { waitForSessionProofCodexSmoke } from "./codeops-session-proof-codex-smoke-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  readTwelfthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-wait-authorization.mjs";
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
    throw new Error("proof Codex smoke completion output path must be absolute and normalized");
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
    throw new Error("proof Codex smoke completion output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof Codex smoke completion output already exists");
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
    throw new Error("proof Codex smoke completion output must be one bounded private regular file");
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
      throw new Error("proof Codex smoke completion output changed while it was read");
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
    throw new Error("proof Codex smoke completion output changed while it was written");
  }
}

export function waitForSessionProofCodexSmokeFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForSmoke = waitForSessionProofCodexSmoke,
) {
  const { authorization, replacementOutputs } =
    readTwelfthSessionProofStepAuthorizationFromOperatorPacket(input, runner);
  return waitForSmoke({
    authorization,
    smokeReplacementReceiptSource: replacementOutputs.eleventhStepReceiptSource,
    smokeReplacementEvidenceSource: replacementOutputs.eleventhEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}

export function persistSessionProofCodexSmokeWaitFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForSmoke = waitForSessionProofCodexSmoke,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.twelfthEvidencePath,
    input.packetPath,
    namespace,
    "step-13-wait-codex-smoke.evidence.json",
    true,
  );
  assertOutputPath(
    input.twelfthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-13-wait-codex-smoke.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.twelfthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.twelfthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.twelfthStepReceiptPath);
    syncParent(input.twelfthStepReceiptPath);
    const result = waitForSessionProofCodexSmokeFromOperatorPacket(
      input,
      runner,
      waitForSmoke,
    );
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.twelfthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.twelfthStepReceiptPath, receiptSource);
    syncParent(input.twelfthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofCodexSmokeWaitOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const { authorization, replacementOutputs } =
    readTwelfthSessionProofStepAuthorizationFromOperatorPacket(input, runner);
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.twelfthEvidencePath,
    input.packetPath,
    namespace,
    "step-13-wait-codex-smoke.evidence.json",
    false,
  );
  assertOutputPath(
    input.twelfthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-13-wait-codex-smoke.receipt.json",
    false,
  );
  const twelfthEvidenceSource = readPrivateOutput(input.twelfthEvidencePath).toString("utf8");
  const twelfthStepReceiptSource = readPrivateOutput(input.twelfthStepReceiptPath)
    .toString("utf8");
  const evidence = parseJson(twelfthEvidenceSource, "proof Codex smoke completion evidence");
  const receipt = parseJson(twelfthStepReceiptSource, "proof Codex smoke completion receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof Codex smoke completion output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: twelfthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (twelfthStepReceiptSource !== expectedSource) {
    throw new Error("proof Codex smoke completion receipt is not the exact persisted artifact");
  }
  return {
    ...replacementOutputs,
    twelfthAuthorization: authorization,
    twelfthEvidenceSource,
    twelfthStepReceiptSource,
  };
}
