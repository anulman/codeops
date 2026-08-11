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
  readSessionProofRuntimeStopOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-stop.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  authorizeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";

function assertAuthorizationPath(path, packetPath, namespace, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof nineteenth-step authorization path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.step-23-revoke-capabilities.authorization.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof nineteenth-step authorization path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof nineteenth-step authorization already exists");
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
    throw new Error("proof nineteenth-step authorization must be one bounded private regular file");
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
      throw new Error("proof nineteenth-step authorization changed while it was read");
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
      throw new Error("proof nineteenth-step authorization changed while it was written");
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

function buildNineteenthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  readRuntimeStopOutputs = readSessionProofRuntimeStopOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRuntimeStopOutputs(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const authorization = authorizeStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [
      outputs.stepReceiptSource,
      outputs.secondStepReceiptSource,
      outputs.thirdStepReceiptSource,
      outputs.fourthStepReceiptSource,
      outputs.fifthStepReceiptSource,
      outputs.sixthStepReceiptSource,
      outputs.seventhStepReceiptSource,
      outputs.eighthStepReceiptSource,
      outputs.ninthStepReceiptSource,
      outputs.tenthStepReceiptSource,
      outputs.eleventhStepReceiptSource,
      outputs.twelfthStepReceiptSource,
      outputs.thirteenthStepReceiptSource,
      outputs.fourteenthStepReceiptSource,
      outputs.fifteenthStepReceiptSource,
      outputs.sixteenthStepReceiptSource,
      outputs.seventeenthStepReceiptSource,
      outputs.eighteenthStepReceiptSource,
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
  return { authorization, runtimeStopOutputs: outputs };
}

export function authorizeNineteenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readRuntimeStopOutputs = readSessionProofRuntimeStopOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  return buildNineteenthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
    readRuntimeStopOutputs,
    authorizeStep,
  ).authorization;
}

export function persistNineteenthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  authorizeStep = authorizeNineteenthSessionProofStepFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertAuthorizationPath(
    input.nineteenthAuthorizationPath,
    input.packetPath,
    namespace,
    true,
  );
  const authorization = authorizeStep(input, runner);
  verifySessionProofStepAuthorization(authorization);
  if (authorization.namespace.name !== namespace) {
    throw new Error("proof nineteenth-step authorization Namespace drifted from the operator packet path");
  }
  writePrivateAuthorization(
    input.nineteenthAuthorizationPath,
    `${JSON.stringify(authorization, null, 2)}\n`,
  );
  return authorization;
}

export function readNineteenthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  buildAuthorization = buildNineteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertAuthorizationPath(
    input.nineteenthAuthorizationPath,
    input.packetPath,
    namespace,
    false,
  );
  const authorizationBytes = readPrivateAuthorization(input.nineteenthAuthorizationPath);
  let authorization;
  try {
    authorization = JSON.parse(authorizationBytes);
  } catch {
    throw new Error("proof nineteenth-step authorization must be valid JSON");
  }
  verifySessionProofStepAuthorization(authorization);
  const { authorization: expected, runtimeStopOutputs } = buildAuthorization({
    ...input,
    observedAt: authorization.authorizedAt,
  }, runner);
  if (expected.namespace.name !== namespace) {
    throw new Error("proof nineteenth-step authorization Namespace drifted from the operator packet path");
  }
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (!authorizationBytes.equals(Buffer.from(expectedSource))) {
    throw new Error("proof nineteenth-step authorization is not the exact persisted artifact");
  }
  return {
    authorization: expected,
    authorizationSource: expectedSource,
    runtimeStopOutputs,
  };
}
