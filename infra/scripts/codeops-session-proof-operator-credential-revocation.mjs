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
  readNineteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-credential-revocation-authorization.mjs";
import {
  verifySessionProofCredentialRevocationEvidence,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { revokeSessionProofCredentials } from "./codeops-session-proof-credential-revoker.mjs";
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
    throw new Error("proof credential revocation output path must be absolute and normalized");
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
    throw new Error("proof credential revocation output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof credential revocation output already exists");
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
    throw new Error("proof credential revocation output must be one bounded private regular file");
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
      throw new Error("proof credential revocation output changed while it was read");
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
    throw new Error("proof credential revocation output changed while it was written");
  }
}

function priorReceiptSources(outputs) {
  return [
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
  ];
}

export async function revokeSessionProofCredentialsFromOperatorPacket(
  input,
  runner = execFileSync,
  revokeCredentials = revokeSessionProofCredentials,
  readAuthorization = readNineteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeStopOutputs } = readAuthorization(input, runner);
  return revokeCredentials({
    authorization,
    priorReceiptSources: priorReceiptSources(runtimeStopOutputs),
    issuanceEvidenceSources: [
      runtimeStopOutputs.evidenceSource,
      runtimeStopOutputs.secondEvidenceSource,
    ],
    runtimeStopEvidenceSource: runtimeStopOutputs.eighteenthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, { runner });
}

export async function persistSessionProofCredentialRevocationFromOperatorPacket(
  input,
  runner = execFileSync,
  revokeCredentials = revokeSessionProofCredentials,
  readAuthorization = readNineteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  assertOutputPath(
    input.nineteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-23-revoke-capabilities.evidence.json",
    true,
  );
  assertOutputPath(
    input.nineteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-23-revoke-capabilities.receipt.json",
    true,
  );

  const evidenceDescriptor = reservePrivateOutput(input.nineteenthEvidencePath);
  let receiptDescriptor;
  try {
    syncParent(input.nineteenthEvidencePath);
    receiptDescriptor = reservePrivateOutput(input.nineteenthStepReceiptPath);
    syncParent(input.nineteenthStepReceiptPath);
    const result = await revokeSessionProofCredentialsFromOperatorPacket(
      input,
      runner,
      revokeCredentials,
      readAuthorization,
    );
    const receiptSource = `${JSON.stringify(result.receipt, null, 2)}\n`;
    writePrivateOutput(evidenceDescriptor, input.nineteenthEvidencePath, result.evidenceSource);
    writePrivateOutput(receiptDescriptor, input.nineteenthStepReceiptPath, receiptSource);
    syncParent(input.nineteenthEvidencePath);
    return { evidenceSource: result.evidenceSource, receiptSource, receipt: result.receipt };
  } finally {
    closeSync(evidenceDescriptor);
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
  }
}

export function readSessionProofCredentialRevocationOutputsFromOperatorPacket(
  input,
  runner = execFileSync,
  readAuthorization = readNineteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeStopOutputs } = readAuthorization(input, runner);
  const namespace = authorization.namespace.name;
  assertOutputPath(
    input.nineteenthEvidencePath,
    input.packetPath,
    namespace,
    "step-23-revoke-capabilities.evidence.json",
    false,
  );
  assertOutputPath(
    input.nineteenthStepReceiptPath,
    input.packetPath,
    namespace,
    "step-23-revoke-capabilities.receipt.json",
    false,
  );
  const nineteenthEvidenceSource = readPrivateOutput(input.nineteenthEvidencePath).toString("utf8");
  const nineteenthStepReceiptSource = readPrivateOutput(input.nineteenthStepReceiptPath).toString("utf8");
  const evidence = parseJson(nineteenthEvidenceSource, "proof credential revocation evidence");
  const receipt = parseJson(nineteenthStepReceiptSource, "proof credential revocation receipt");
  verifySessionProofCredentialRevocationEvidence(authorization, evidence);
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof credential revocation output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(namespace, runner);
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: nineteenthEvidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (nineteenthStepReceiptSource !== expectedSource) {
    throw new Error("proof credential revocation receipt is not the exact persisted artifact");
  }
  return {
    ...runtimeStopOutputs,
    nineteenthAuthorization: authorization,
    nineteenthEvidenceSource,
    nineteenthStepReceiptSource,
  };
}
