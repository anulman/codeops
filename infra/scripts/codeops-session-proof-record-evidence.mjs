import { createHash } from "node:crypto";
import { verifySessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_SOURCE_BYTES = 64 * 1024;

const OPERATIONS = [
  "job-initialization", "live-observation", "prompt", "permission-deny",
  "permission-approve", "checkpoint", "hibernate", "resume", "fork",
  "cancel", "archive",
];
const DURABILITY_CHECKS = ["browser-reconnect", "duplicate-command-replay"];
const ARTIFACTS = [
  { path: "browser/video/raw.webm", contentType: "video/webm", maxBytes: 1_500_000_000 },
  { path: "browser/trace.zip", contentType: "application/zip", maxBytes: 256_000_000 },
  { path: "session/export.json", contentType: "application/json", maxBytes: 32_000_000 },
  { path: "assertions.json", contentType: "application/json", maxBytes: 1_000_000 },
];

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

function assertAuthorization(authorization) {
  if (
    authorization?.stepId !== "record-proof" ||
    authorization.action !== "operator-record-and-export-evidence" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified evidence recording");
  }
}

function bytes(value, path) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`proof recording artifact ${path} must be exact bytes`);
  }
  return Buffer.from(value);
}

function verifyRuntimeReadinessChain(authorization, receiptSource, evidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof recording predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof runtime readiness receipt");
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "wait-runtime" ||
    receipt.action !== "operator-wait-ready" ||
    receipt.artifact !== null ||
    receipt.artifactSha256 !== null ||
    receipt.evidenceSha256 !== digest(evidenceSource)
  ) {
    throw new Error("proof runtime readiness receipt identity drifted");
  }
  const runtimeEvidence = parseJson(evidenceSource, "proof runtime readiness evidence");
  verifySessionProofRuntimeReadinessEvidence({
    planSha256: authorization.planSha256,
    stepIndex: receipt.stepIndex,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: null,
    namespace: authorization.namespace,
    admission: authorization.admission,
    previousReceiptSha256: receipt.previousReceiptSha256,
  }, runtimeEvidence);
  return runtimeEvidence.observedAt;
}

function verifyCapture(authorization, capture, runtimeReadyAt) {
  if (
    !sameKeys(capture, [
      "sourceSha", "startedAt", "finishedAt", "operations", "durabilityChecks",
      "inspection", "artifacts",
    ]) ||
    !SHA.test(capture.sourceSha ?? "") ||
    capture.sourceSha !== authorization.admission?.identity?.baseSha ||
    !RFC3339.test(capture.startedAt ?? "") ||
    !RFC3339.test(capture.finishedAt ?? "") ||
    Date.parse(capture.startedAt) < Date.parse(runtimeReadyAt) ||
    Date.parse(capture.finishedAt) <= Date.parse(capture.startedAt) ||
    JSON.stringify(capture.operations) !== JSON.stringify(OPERATIONS) ||
    JSON.stringify(capture.durabilityChecks) !== JSON.stringify(DURABILITY_CHECKS) ||
    !sameKeys(capture.inspection, [
      "legible", "completeOperationCoverage", "correctFinalLifecycleState",
      "syntheticOwnedContentOnly", "sensitiveMaterialAbsent",
    ]) ||
    Object.values(capture.inspection).some((value) => value !== true) ||
    !Array.isArray(capture.artifacts) ||
    capture.artifacts.length !== ARTIFACTS.length
  ) {
    throw new Error("proof recording capture contract drifted");
  }
  for (let index = 0; index < ARTIFACTS.length; index += 1) {
    const expected = ARTIFACTS[index];
    const artifact = capture.artifacts[index];
    if (
      !sameKeys(artifact, ["path", "contentType", "bytes", "sha256"]) ||
      artifact.path !== expected.path ||
      artifact.contentType !== expected.contentType ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > expected.maxBytes ||
      !SHA256.test(artifact.sha256 ?? "")
    ) {
      throw new Error("proof recording artifact inventory drifted");
    }
  }
}

export function verifySessionProofRecordEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "runtimeReadinessReceiptSource", "runtimeReadinessEvidenceSource", "capture",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    typeof evidence.runtimeReadinessReceiptSource !== "string" ||
    Buffer.byteLength(evidence.runtimeReadinessReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.runtimeReadinessEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.runtimeReadinessEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof recording evidence identity drifted");
  }
  const runtimeReadyAt = verifyRuntimeReadinessChain(
    authorization,
    evidence.runtimeReadinessReceiptSource,
    evidence.runtimeReadinessEvidenceSource,
  );
  verifyCapture(authorization, evidence.capture, runtimeReadyAt);
  if (Date.parse(evidence.observedAt) < Date.parse(evidence.capture.finishedAt)) {
    throw new Error("proof recording observation time drifted");
  }
  return true;
}

export function buildSessionProofRecordEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.runtimeReadinessReceiptSource ?? "";
  const evidenceSource = input.runtimeReadinessEvidenceSource ?? "";
  const runtimeReadyAt = verifyRuntimeReadinessChain(authorization, receiptSource, evidenceSource);
  const artifactKeys = Object.keys(input.artifacts ?? {}).sort();
  if (JSON.stringify(artifactKeys) !== JSON.stringify(ARTIFACTS.map((value) => value.path).sort())) {
    throw new Error("proof recording artifact set is incomplete or contains extras");
  }
  const inventory = ARTIFACTS.map((artifact) => {
    const source = bytes(input.artifacts[artifact.path], artifact.path);
    return {
      path: artifact.path,
      contentType: artifact.contentType,
      bytes: source.length,
      sha256: digest(source),
    };
  });
  const capture = {
    sourceSha: authorization.admission.identity.baseSha,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    operations: OPERATIONS,
    durabilityChecks: DURABILITY_CHECKS,
    inspection: input.inspection,
    artifacts: inventory,
  };
  verifyCapture(authorization, capture, runtimeReadyAt);
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    runtimeReadinessReceiptSource: receiptSource,
    runtimeReadinessEvidenceSource: evidenceSource,
    capture,
  };
  verifySessionProofRecordEvidence(authorization, evidence);
  return evidence;
}
