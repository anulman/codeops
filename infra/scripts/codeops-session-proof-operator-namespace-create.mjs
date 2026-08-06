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
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import { readSessionProofOperatorAdmissionAttachment } from "./codeops-session-proof-operator-admission.mjs";

function assertReceiptPath(receiptPath, packetPath, namespace) {
  if (!isAbsolute(receiptPath ?? "") || resolve(receiptPath) !== receiptPath) {
    throw new Error("proof Namespace creation receipt path must be absolute and normalized");
  }
  const parent = dirname(receiptPath);
  const parentStat = lstatSync(parent);
  if (
    parent !== dirname(packetPath) ||
    basename(receiptPath) !== `${namespace}.namespace-create-receipt.json` ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("proof Namespace creation receipt path must derive exactly from the packet Namespace");
  }
  try {
    lstatSync(receiptPath);
    throw new Error("proof Namespace creation receipt already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reserveCreationReceipt(path) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function writeCreationReceipt(descriptor, path, source) {
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
    throw new Error("proof Namespace creation receipt changed while it was written");
  }
}

export function createSessionProofNamespaceFromOperatorPacket(input, runner = execFileSync) {
  const attachment = readSessionProofOperatorAdmissionAttachment(input);
  assertReceiptPath(
    input.receiptPath,
    input.packetPath,
    attachment.admission.identity.namespace,
  );
  const receiptDescriptor = reserveCreationReceipt(input.receiptPath);
  try {
    const receipt = createSessionProofNamespace({
      planSource: attachment.planSource,
      admission: attachment.admission,
      namespaceManifestSource: attachment.namespaceManifestSource,
      observedAt: input.observedAt,
    }, runner);
    writeCreationReceipt(
      receiptDescriptor,
      input.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  } finally {
    closeSync(receiptDescriptor);
  }
}
