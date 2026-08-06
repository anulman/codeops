import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { readSessionProofOperatorCreationReceipt } from "./codeops-session-proof-operator-namespace-create.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

function assertAuthorizationPath(path, packetPath, namespace) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof first-step authorization path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !== `${namespace}.step-02-issue-broker-capabilities.authorization.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof first-step authorization path must derive exactly from the packet Namespace");
  }
  try {
    lstatSync(path);
    throw new Error("proof first-step authorization already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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
      throw new Error("proof first-step authorization changed while it was written");
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

function authorizeFirstSessionProofStep(operatorInput, input, runner) {
  if (operatorInput.creationReceipt.proceed !== true) {
    throw new Error("proof Namespace creation did not admit the first intermediate step");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    operatorInput.creationReceipt.namespace.name,
    runner,
  );
  return authorizeSessionProofStep({
    planSource: operatorInput.planSource,
    creationReceiptSource: operatorInput.creationReceiptSource,
    priorReceiptSources: [],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}

export function authorizeFirstSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  return authorizeFirstSessionProofStep(
    readSessionProofOperatorCreationReceipt(input),
    input,
    runner,
  );
}

export function persistFirstSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const operatorInput = readSessionProofOperatorCreationReceipt(input);
  assertAuthorizationPath(
    input.authorizationPath,
    input.packetPath,
    operatorInput.creationReceipt.namespace.name,
  );
  const authorization = authorizeFirstSessionProofStep(operatorInput, input, runner);
  writePrivateAuthorization(
    input.authorizationPath,
    `${JSON.stringify(authorization, null, 2)}\n`,
  );
  return authorization;
}
