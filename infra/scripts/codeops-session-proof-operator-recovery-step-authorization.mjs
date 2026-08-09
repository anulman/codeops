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
  persistSessionProofGatewayMigrationWaitFromOperatorPacket,
  readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait.mjs";
import {
  readSessionProofGatewayApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-apply.mjs";
import {
  readSessionProofRecoveryAdmissionFromOperatorPacket,
} from "./codeops-session-proof-operator-recovery-admission.mjs";
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
    throw new Error("proof recovered sixth-step authorization path must be absolute and normalized");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(path) !==
      `${namespace}.step-07-wait-gateway-migration.recovery-authorization.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof recovered sixth-step authorization path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof recovered sixth-step authorization already exists");
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
    throw new Error("proof recovered sixth-step authorization must be one bounded private regular file");
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
      throw new Error("proof recovered sixth-step authorization changed while it was read");
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
      throw new Error("proof recovered sixth-step authorization changed while it was written");
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

function buildRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  readGatewayApplyOutputs = readSessionProofGatewayApplyOutputsFromOperatorPacket,
  readRecoveryAdmission = readSessionProofRecoveryAdmissionFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const recovery = readRecoveryAdmission(input, runner);
  const outputs = readGatewayApplyOutputs(input, runner);
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
    ],
    recoveryAdmissionSource: recovery.admissionSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
  return { authorization, gatewayApplyOutputs: outputs, recoveryAdmission: recovery };
}

export function authorizeRecoveredSixthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readGatewayApplyOutputs = readSessionProofGatewayApplyOutputsFromOperatorPacket,
  readRecoveryAdmission = readSessionProofRecoveryAdmissionFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  return buildRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
    readGatewayApplyOutputs,
    readRecoveryAdmission,
    authorizeStep,
  ).authorization;
}

export function persistRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  authorizeStep = authorizeRecoveredSixthSessionProofStepFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertAuthorizationPath(
    input.recoveredSixthAuthorizationPath,
    input.packetPath,
    namespace,
    true,
  );
  const authorization = authorizeStep(input, runner);
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.namespace.name !== namespace ||
    authorization.stepId !== "wait-gateway-migration" ||
    authorization.admission?.apiVersion !==
      "codeops.renoconcierge.ca/session-proof-recovery-admission/v1"
  ) {
    throw new Error("proof recovered sixth-step authorization drifted from the operator packet");
  }
  writePrivateAuthorization(
    input.recoveredSixthAuthorizationPath,
    `${JSON.stringify(authorization, null, 2)}\n`,
  );
  return authorization;
}

export function readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  buildAuthorization = buildRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertAuthorizationPath(
    input.recoveredSixthAuthorizationPath,
    input.packetPath,
    namespace,
    false,
  );
  const authorizationBytes = readPrivateAuthorization(
    input.recoveredSixthAuthorizationPath,
  );
  let authorization;
  try {
    authorization = JSON.parse(authorizationBytes);
  } catch {
    throw new Error("proof recovered sixth-step authorization must be valid JSON");
  }
  verifySessionProofStepAuthorization(authorization);
  const result = buildAuthorization({
    ...input,
    observedAt: authorization.authorizedAt,
  }, runner);
  const expected = result.authorization;
  if (
    expected.namespace.name !== namespace ||
    expected.stepId !== "wait-gateway-migration" ||
    expected.admission?.apiVersion !==
      "codeops.renoconcierge.ca/session-proof-recovery-admission/v1"
  ) {
    throw new Error("proof recovered sixth-step authorization drifted from the operator packet");
  }
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (!authorizationBytes.equals(Buffer.from(expectedSource))) {
    throw new Error("proof recovered sixth-step authorization is not the exact persisted artifact");
  }
  return {
    authorization: expected,
    authorizationSource: expectedSource,
    gatewayApplyOutputs: result.gatewayApplyOutputs,
    recoveryAdmission: result.recoveryAdmission,
  };
}

export function readRecoveredSixthSessionProofStepAuthorizationFromVerifiedGatewayApplyOutputs(
  input,
  runner,
  gatewayApplyOutputs,
  buildAuthorization = buildRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket,
) {
  return readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
    (received, runnerArgument) => buildAuthorization(
      received,
      runnerArgument,
      () => gatewayApplyOutputs,
    ),
  );
}

export function waitForRecoveredSessionProofGatewayMigrationFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGatewayMigration = waitForSessionProofGatewayMigration,
  readAuthorization = readRecoveredSixthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, gatewayApplyOutputs } = readAuthorization(input, runner);
  return waitForGatewayMigration({
    authorization,
    gatewayApplyReceiptSource: gatewayApplyOutputs.fifthStepReceiptSource,
    gatewayApplyEvidenceSource: gatewayApplyOutputs.fifthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}

export function persistRecoveredSessionProofGatewayMigrationWaitFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGatewayMigration = waitForSessionProofGatewayMigration,
  persistWait = persistSessionProofGatewayMigrationWaitFromOperatorPacket,
) {
  return persistWait(
    input,
    runner,
    waitForGatewayMigration,
    waitForRecoveredSessionProofGatewayMigrationFromOperatorPacket,
  );
}

export function readRecoveredSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
  readOutputs = readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
) {
  return readOutputs(
    input,
    runner,
    readRecoveredSixthSessionProofStepAuthorizationFromVerifiedGatewayApplyOutputs,
  );
}
