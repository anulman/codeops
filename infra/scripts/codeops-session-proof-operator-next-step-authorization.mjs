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
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  readFirstSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-step-authorization.mjs";
import {
  readFirstSessionProofCredentialOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-credential-issuance.mjs";
import {
  authorizeSessionProofStep,
  completeSessionProofStep,
} from "./codeops-session-proof-step-receipts.mjs";

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function assertAuthorizationPath(path, packetPath, namespace, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof second-step authorization path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.step-03-issue-runtime-capabilities.authorization.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof second-step authorization path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof second-step authorization already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readPrivateAuthorization(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof second-step authorization must be one bounded private regular file");
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
      throw new Error("proof second-step authorization changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateAuthorization(path, source) {
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
      throw new Error("proof second-step authorization changed while it was written");
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

function readAndVerifyFirstCredentialOutputs(input, runner) {
  const outputs = readFirstSessionProofCredentialOutputsFromOperatorPacket(input);
  const { authorization } = readFirstSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const evidence = parseJson(outputs.evidenceSource, "proof first-step evidence");
  const receipt = parseJson(outputs.stepReceiptSource, "proof first-step receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof first-step output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: outputs.evidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (outputs.stepReceiptSource !== expectedSource) {
    throw new Error("proof first-step receipt is not the exact persisted artifact");
  }
  return outputs;
}

export function authorizeSecondSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readAndVerifyFirstCredentialOutputs(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  return authorizeSessionProofStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [outputs.stepReceiptSource],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}

export function persistSecondSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readFirstSessionProofCredentialOutputsFromOperatorPacket(input);
  assertAuthorizationPath(
    input.secondAuthorizationPath,
    input.packetPath,
    outputs.creationReceipt.namespace.name,
    true,
  );
  const authorization = authorizeSecondSessionProofStepFromOperatorPacket(input, runner);
  writePrivateAuthorization(
    input.secondAuthorizationPath,
    `${JSON.stringify(authorization, null, 2)}\n`,
  );
  return authorization;
}

export function readSecondSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readFirstSessionProofCredentialOutputsFromOperatorPacket(input);
  assertAuthorizationPath(
    input.secondAuthorizationPath,
    input.packetPath,
    outputs.creationReceipt.namespace.name,
    false,
  );
  const authorizationBytes = readPrivateAuthorization(input.secondAuthorizationPath);
  let authorization;
  try {
    authorization = JSON.parse(authorizationBytes);
  } catch {
    throw new Error("proof second-step authorization must be valid JSON");
  }
  const expected = authorizeSecondSessionProofStepFromOperatorPacket({
    ...input,
    observedAt: authorization.authorizedAt,
  }, runner);
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (!authorizationBytes.equals(Buffer.from(expectedSource))) {
    throw new Error("proof second-step authorization is not the exact persisted artifact");
  }
  return { authorization: expected, authorizationSource: expectedSource };
}
