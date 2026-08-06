import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import { readSessionProofOperatorAdmissionAttachment } from "./codeops-session-proof-operator-admission.mjs";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function assertReceiptPath(receiptPath, packetPath, namespace, mustBeAbsent) {
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
  if (mustBeAbsent) {
    try {
      lstatSync(receiptPath);
      throw new Error("proof Namespace creation receipt already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readPrivateCreationReceipt(path) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error("proof Namespace creation receipt must be one bounded private regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const source = readFileSync(descriptor);
    const after = lstatSync(path);
    if (
      source.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      (after.mode & 0o777) !== 0o600
    ) {
      throw new Error("proof Namespace creation receipt changed while it was read");
    }
    return source;
  } finally {
    closeSync(descriptor);
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
    true,
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

export function readSessionProofOperatorCreationReceipt(input) {
  const attachment = readSessionProofOperatorAdmissionAttachment(input);
  assertReceiptPath(
    input.receiptPath,
    input.packetPath,
    attachment.admission.identity.namespace,
    false,
  );
  const receiptBytes = readPrivateCreationReceipt(input.receiptPath);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes);
  } catch {
    throw new Error("proof Namespace creation receipt must be valid JSON");
  }
  const uid = receipt.namespace?.uid;
  const successful = receipt.proceed === true;
  const checkedAt = Date.parse(receipt.checkedAt ?? "");
  if (
    typeof uid !== "string" ||
    uid.length < 1 ||
    uid.length > 256 ||
    !RFC3339.test(receipt.checkedAt ?? "") ||
    !Number.isFinite(checkedAt) ||
    checkedAt < Date.parse(attachment.admission.approvedAt) ||
    checkedAt > Date.parse(attachment.admission.expiresAt) ||
    !(
      successful && receipt.result === "created-and-uid-bound" ||
      receipt.proceed === false && receipt.result === "namespace-uid-bound-create-incomplete"
    )
  ) {
    throw new Error("proof Namespace creation receipt outcome drifted");
  }
  const expected = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-create/v1",
    result: receipt.result,
    checkedAt: receipt.checkedAt,
    planSha256: attachment.admission.planSha256,
    namespaceManifestSha256: digest(attachment.namespaceManifestSource),
    namespace: {
      name: attachment.admission.identity.namespace,
      uid,
    },
    proceed: receipt.proceed,
    admission: {
      ...attachment.admission,
      state: "approved-bound",
      namespaceUid: uid,
    },
  };
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (!receiptBytes.equals(Buffer.from(expectedSource))) {
    throw new Error("proof Namespace creation receipt is not the exact persisted artifact");
  }
  return {
    ...attachment,
    creationReceiptSource: expectedSource,
    creationReceipt: receipt,
    creationReceiptSha256: digest(expectedSource),
  };
}
