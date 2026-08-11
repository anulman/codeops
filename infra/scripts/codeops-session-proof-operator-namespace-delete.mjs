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
  readSessionProofCredentialRevocationOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-credential-revocation.mjs";
import { deleteSessionProofNamespace } from "./codeops-session-proof-namespace-delete.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";
import {
  buildSessionProofNamespaceDeleteReceipt,
  buildSessionProofTeardownReceipt,
} from "./codeops-session-proof-teardown-evidence.mjs";

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function assertOutputPath(path, packetPath, namespace, suffix, mustBeAbsent) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path) {
    throw new Error("proof Namespace deletion output path must be absolute and normalized");
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
    throw new Error("proof Namespace deletion output path must derive exactly from the packet Namespace");
  }
  if (mustBeAbsent) {
    try {
      lstatSync(path);
      throw new Error("proof Namespace deletion output already exists");
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
    throw new Error("proof Namespace deletion output must be one bounded private regular file");
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
      throw new Error("proof Namespace deletion output changed while it was read");
    }
    return source.toString("utf8");
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
    throw new Error("proof Namespace deletion output changed while it was written");
  }
}

function exactDeletionOutputs(result) {
  if (result?.result !== "deleted-and-absence-verified" || result.proceed !== true) {
    throw new Error("proof Namespace deletion did not verify final absence");
  }
  const deletionEvidence = parseJson(
    result.deleteEvidenceSource,
    "proof Namespace deletion evidence",
  );
  const deletion = buildSessionProofNamespaceDeleteReceipt({
    planSha256: result.planSha256,
    namespace: result.namespace,
    observedAt: deletionEvidence.observedAt,
    revocationReceiptSource: deletionEvidence.revocationReceiptSource,
    revocationEvidenceSource: deletionEvidence.revocationEvidenceSource,
    deletionAccepted: true,
  });
  if (
    deletion.evidenceSource !== result.deleteEvidenceSource ||
    JSON.stringify(deletion.receipt) !== result.deleteReceiptSource
  ) {
    throw new Error("proof Namespace deletion outputs drifted");
  }
  const teardownEvidence = parseJson(
    result.teardownEvidenceSource,
    "proof final teardown evidence",
  );
  const teardown = buildSessionProofTeardownReceipt({
    planSha256: result.planSha256,
    namespace: result.namespace,
    observedAt: teardownEvidence.observedAt,
    deleteReceiptSource: result.deleteReceiptSource,
    deleteEvidenceSource: result.deleteEvidenceSource,
    namespaceAbsent: true,
  });
  if (
    teardown.evidenceSource !== result.teardownEvidenceSource ||
    JSON.stringify(teardown.receipt) !== JSON.stringify(result.teardownReceipt)
  ) {
    throw new Error("proof final teardown outputs drifted");
  }
  return {
    deletionEvidenceSource: result.deleteEvidenceSource,
    deletionReceiptSource: result.deleteReceiptSource,
    teardownEvidenceSource: result.teardownEvidenceSource,
    teardownReceiptSource: JSON.stringify(result.teardownReceipt),
  };
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
    outputs.nineteenthStepReceiptSource,
  ];
}

function buildNamespaceDeletionAuthorizationFromOperatorPacket(
  input,
  runner = execFileSync,
  readRevocationOutputs = readSessionProofCredentialRevocationOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRevocationOutputs(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const authorization = authorizeStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: priorReceiptSources(outputs),
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
  return { authorization, revocationOutputs: outputs };
}

export function authorizeNamespaceDeletionFromOperatorPacket(
  input,
  runner = execFileSync,
  readRevocationOutputs = readSessionProofCredentialRevocationOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  return buildNamespaceDeletionAuthorizationFromOperatorPacket(
    input,
    runner,
    readRevocationOutputs,
    authorizeStep,
  ).authorization;
}

export async function deleteSessionProofNamespaceFromOperatorPacket(
  input,
  runner = execFileSync,
  deleteNamespace = deleteSessionProofNamespace,
  readRevocationOutputs = readSessionProofCredentialRevocationOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const { authorization, revocationOutputs } =
    buildNamespaceDeletionAuthorizationFromOperatorPacket(
      input,
      runner,
      readRevocationOutputs,
      authorizeStep,
    );
  return deleteNamespace({
    planSource: revocationOutputs.planSource,
    creationReceipt: revocationOutputs.creationReceipt,
    revocationReceiptSource: revocationOutputs.nineteenthStepReceiptSource,
    revocationEvidenceSource: revocationOutputs.nineteenthEvidenceSource,
    observedAt: authorization.authorizedAt,
  }, { runner });
}

export async function persistSessionProofNamespaceDeletionFromOperatorPacket(
  input,
  runner = execFileSync,
  deleteFromPacket = deleteSessionProofNamespaceFromOperatorPacket,
) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  const outputs = [
    [input.twentiethEvidencePath, "step-24-delete-namespace.evidence.json"],
    [input.twentiethStepReceiptPath, "step-24-delete-namespace.receipt.json"],
    [input.twentyFirstEvidencePath, "step-25-verify-teardown.evidence.json"],
    [input.twentyFirstStepReceiptPath, "step-25-verify-teardown.receipt.json"],
  ];
  for (const [path, suffix] of outputs) {
    assertOutputPath(path, input.packetPath, namespace, suffix, true);
  }

  const descriptors = [];
  try {
    for (const [path] of outputs) {
      descriptors.push(reservePrivateOutput(path));
      syncParent(path);
    }
    const sources = exactDeletionOutputs(await deleteFromPacket(input, runner));
    const orderedSources = [
      sources.deletionEvidenceSource,
      sources.deletionReceiptSource,
      sources.teardownEvidenceSource,
      sources.teardownReceiptSource,
    ];
    for (let index = 0; index < outputs.length; index += 1) {
      writePrivateOutput(descriptors[index], outputs[index][0], orderedSources[index]);
    }
    syncParent(outputs[0][0]);
    return sources;
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

export function readSessionProofNamespaceDeletionOutputsFromOperatorPacket(input) {
  const packetName = basename(input.packetPath ?? "");
  const namespace = packetName.endsWith(".packet")
    ? packetName.slice(0, -".packet".length)
    : "";
  const outputs = [
    [input.twentiethEvidencePath, "step-24-delete-namespace.evidence.json"],
    [input.twentiethStepReceiptPath, "step-24-delete-namespace.receipt.json"],
    [input.twentyFirstEvidencePath, "step-25-verify-teardown.evidence.json"],
    [input.twentyFirstStepReceiptPath, "step-25-verify-teardown.receipt.json"],
  ];
  for (const [path, suffix] of outputs) {
    assertOutputPath(path, input.packetPath, namespace, suffix, false);
  }
  const [
    twentiethEvidenceSource,
    twentiethStepReceiptSource,
    twentyFirstEvidenceSource,
    twentyFirstStepReceiptSource,
  ] = outputs.map(([path]) => readPrivateOutput(path));
  const deletionEvidence = parseJson(
    twentiethEvidenceSource,
    "proof Namespace deletion evidence",
  );
  const teardownEvidence = parseJson(
    twentyFirstEvidenceSource,
    "proof final teardown evidence",
  );
  const teardownReceipt = parseJson(
    twentyFirstStepReceiptSource,
    "proof final teardown receipt",
  );
  if (deletionEvidence.namespace?.name !== namespace) {
    throw new Error("proof Namespace deletion output Namespace drifted");
  }
  const deletion = buildSessionProofNamespaceDeleteReceipt({
    planSha256: deletionEvidence.planSha256,
    namespace: deletionEvidence.namespace,
    observedAt: deletionEvidence.observedAt,
    revocationReceiptSource: deletionEvidence.revocationReceiptSource,
    revocationEvidenceSource: deletionEvidence.revocationEvidenceSource,
    deletionAccepted: true,
  });
  if (
    twentiethEvidenceSource !== deletion.evidenceSource ||
    twentiethStepReceiptSource !== JSON.stringify(deletion.receipt)
  ) {
    throw new Error("proof Namespace deletion outputs are not the exact persisted artifacts");
  }
  const teardown = buildSessionProofTeardownReceipt({
    planSha256: deletionEvidence.planSha256,
    namespace: deletionEvidence.namespace,
    observedAt: teardownEvidence.observedAt,
    deleteReceiptSource: twentiethStepReceiptSource,
    deleteEvidenceSource: twentiethEvidenceSource,
    namespaceAbsent: true,
  });
  if (
    twentyFirstEvidenceSource !== teardown.evidenceSource ||
    twentyFirstStepReceiptSource !== JSON.stringify(teardown.receipt) ||
    JSON.stringify(teardownReceipt) !== JSON.stringify(teardown.receipt)
  ) {
    throw new Error("proof final teardown outputs are not the exact persisted artifacts");
  }
  return {
    twentiethEvidenceSource,
    twentiethStepReceiptSource,
    twentyFirstEvidenceSource,
    twentyFirstStepReceiptSource,
  };
}
