import { createHash } from "node:crypto";
import { verifySessionProofCredentialRevocationEvidence } from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const MAX_SOURCE_BYTES = 64 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());
}

function assertBoundedSource(source, label) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) < 2 ||
    Buffer.byteLength(source) > MAX_SOURCE_BYTES
  ) {
    throw new Error(`${label} must be bounded exact bytes`);
  }
}

function stepIndex(stepId) {
  return sessionProofSequence().findIndex((step) => step.id === stepId);
}

function verifyReceipt(receipt, expected) {
  if (
    !sameKeys(receipt, [
      "apiVersion", "result", "proceed", "checkedAt", "planSha256", "namespace",
      "stepIndex", "stepId", "action", "artifact", "artifactSha256",
      "previousReceiptSha256", "evidenceSha256",
    ]) ||
    receipt.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    !RFC3339.test(receipt.checkedAt ?? "") ||
    receipt.planSha256 !== expected.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(expected.namespace) ||
    receipt.stepIndex !== stepIndex(expected.stepId) ||
    receipt.stepId !== expected.stepId ||
    receipt.action !== expected.action ||
    receipt.artifact !== null ||
    receipt.artifactSha256 !== null ||
    receipt.previousReceiptSha256 !== expected.previousReceiptSha256 ||
    receipt.evidenceSha256 !== expected.evidenceSha256
  ) {
    throw new Error(`proof ${expected.stepId} receipt drifted`);
  }
}

function buildReceipt(input) {
  const receipt = {
    apiVersion: "codeops.example/session-proof-step-receipt/v1",
    result: "completed",
    proceed: true,
    checkedAt: input.checkedAt,
    planSha256: input.planSha256,
    namespace: input.namespace,
    stepIndex: stepIndex(input.stepId),
    stepId: input.stepId,
    action: input.action,
    artifact: null,
    artifactSha256: null,
    previousReceiptSha256: digest(input.previousReceiptSource),
    evidenceSha256: digest(input.evidenceSource),
  };
  verifyReceipt(receipt, {
    ...input,
    previousReceiptSha256: digest(input.previousReceiptSource),
    evidenceSha256: digest(input.evidenceSource),
  });
  return receipt;
}

export function verifySessionProofRevocationPredecessor(input) {
  const receiptSource = input.revocationReceiptSource;
  const evidenceSource = input.revocationEvidenceSource;
  assertBoundedSource(receiptSource, "proof credential-revocation receipt");
  assertBoundedSource(evidenceSource, "proof credential-revocation evidence");
  const receipt = parseJson(receiptSource, "proof credential-revocation receipt");
  const evidence = parseJson(evidenceSource, "proof credential-revocation evidence");
  verifyReceipt(receipt, {
    planSha256: input.planSha256,
    namespace: input.namespace,
    stepId: "revoke-capabilities",
    action: "operator-revoke-exact-secrets",
    previousReceiptSha256: receipt.previousReceiptSha256,
    evidenceSha256: digest(evidenceSource),
  });
  if (!SHA256.test(receipt.previousReceiptSha256 ?? "")) {
    throw new Error("proof credential-revocation predecessor receipt drifted");
  }
  verifySessionProofCredentialRevocationEvidence({
    planSha256: input.planSha256,
    stepId: receipt.stepId,
    action: receipt.action,
    namespace: input.namespace,
  }, evidence);
  if (
    !RFC3339.test(input.observedAt ?? "") ||
    Date.parse(input.observedAt) < Date.parse(receipt.checkedAt) ||
    Date.parse(input.observedAt) < Date.parse(evidence.observedAt)
  ) {
    throw new Error("proof Namespace deletion preceded credential revocation");
  }
  return { receipt, evidence };
}

export function verifySessionProofNamespaceDeleteEvidence(input, evidence) {
  verifySessionProofRevocationPredecessor(input);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "revocationReceiptSource", "revocationEvidenceSource", "deletedNamespaceUid",
      "deletionAccepted",
    ]) ||
    evidence.apiVersion !== "codeops.example/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.observedAt !== input.observedAt ||
    evidence.planSha256 !== input.planSha256 ||
    evidence.stepId !== "delete-namespace" ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(input.namespace) ||
    evidence.revocationReceiptSource !== input.revocationReceiptSource ||
    evidence.revocationEvidenceSource !== input.revocationEvidenceSource ||
    evidence.deletedNamespaceUid !== input.namespace.uid ||
    evidence.deletionAccepted !== true
  ) {
    throw new Error("proof Namespace deletion evidence drifted");
  }
  return true;
}

export function buildSessionProofNamespaceDeleteEvidence(input) {
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: input.planSha256,
    stepId: "delete-namespace",
    namespace: input.namespace,
    revocationReceiptSource: input.revocationReceiptSource,
    revocationEvidenceSource: input.revocationEvidenceSource,
    deletedNamespaceUid: input.namespace.uid,
    deletionAccepted: input.deletionAccepted,
  };
  verifySessionProofNamespaceDeleteEvidence(input, evidence);
  return evidence;
}

export function buildSessionProofNamespaceDeleteReceipt(input) {
  const evidenceSource = JSON.stringify(buildSessionProofNamespaceDeleteEvidence(input));
  return {
    evidenceSource,
    receipt: buildReceipt({
      planSha256: input.planSha256,
      namespace: input.namespace,
      stepId: "delete-namespace",
      action: "operator-delete-exact-namespace",
      checkedAt: input.observedAt,
      previousReceiptSource: input.revocationReceiptSource,
      evidenceSource,
    }),
  };
}

export function buildSessionProofTeardownReceipt(input) {
  assertBoundedSource(input.deleteReceiptSource, "proof Namespace deletion receipt");
  assertBoundedSource(input.deleteEvidenceSource, "proof Namespace deletion evidence");
  const deleteReceipt = parseJson(input.deleteReceiptSource, "proof Namespace deletion receipt");
  const deleteEvidence = parseJson(input.deleteEvidenceSource, "proof Namespace deletion evidence");
  verifyReceipt(deleteReceipt, {
    planSha256: input.planSha256,
    namespace: input.namespace,
    stepId: "delete-namespace",
    action: "operator-delete-exact-namespace",
    previousReceiptSha256: deleteReceipt.previousReceiptSha256,
    evidenceSha256: digest(input.deleteEvidenceSource),
  });
  verifySessionProofNamespaceDeleteEvidence({
    planSha256: input.planSha256,
    namespace: input.namespace,
    observedAt: deleteEvidence.observedAt,
    revocationReceiptSource: deleteEvidence.revocationReceiptSource,
    revocationEvidenceSource: deleteEvidence.revocationEvidenceSource,
    deletionAccepted: deleteEvidence.deletionAccepted,
  }, deleteEvidence);
  if (
    deleteEvidence.deletedNamespaceUid !== input.namespace.uid ||
    input.namespaceAbsent !== true ||
    !RFC3339.test(input.observedAt ?? "") ||
    Date.parse(input.observedAt) < Date.parse(deleteReceipt.checkedAt)
  ) {
    throw new Error("proof final teardown evidence drifted");
  }
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: input.planSha256,
    stepId: "verify-teardown",
    namespace: input.namespace,
    deleteReceiptSource: input.deleteReceiptSource,
    deleteEvidenceSource: input.deleteEvidenceSource,
    namespaceAbsent: true,
  };
  const evidenceSource = JSON.stringify(evidence);
  return {
    evidenceSource,
    receipt: buildReceipt({
      planSha256: input.planSha256,
      namespace: input.namespace,
      stepId: "verify-teardown",
      action: "operator-verify-namespace-absent",
      checkedAt: input.observedAt,
      previousReceiptSource: input.deleteReceiptSource,
      evidenceSource,
    }),
  };
}
