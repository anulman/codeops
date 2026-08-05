import { createHash } from "node:crypto";
import { verifySessionProofApplyEvidence } from "./codeops-session-proof-apply-evidence.mjs";
import { verifySessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const UID = /^.{1,256}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_SOURCE_BYTES = 64 * 1024;

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

function identity(resource) {
  return `${resource.apiVersion}/${resource.kind}/${resource.name}`;
}

function runtimeName(authorization) {
  return `codeops-session-runtime-${authorization.admission?.identity?.sessionSuffix ?? ""}`;
}

function assertAuthorization(authorization) {
  if (
    authorization?.stepId !== "stop-runtime" ||
    authorization.action !== "operator-delete-exact-runtime-job" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified runtime stop");
  }
}

function verifyRecordPredecessor(authorization, receiptSource, evidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof runtime stop predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof recording receipt");
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "record-proof" ||
    receipt.action !== "operator-record-and-export-evidence" ||
    receipt.artifact !== null ||
    receipt.artifactSha256 !== null ||
    receipt.evidenceSha256 !== digest(evidenceSource)
  ) {
    throw new Error("proof recording receipt identity drifted");
  }
  const recordEvidence = parseJson(evidenceSource, "proof recording evidence");
  verifySessionProofRecordEvidence({
    planSha256: authorization.planSha256,
    stepIndex: receipt.stepIndex,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: null,
    namespace: authorization.namespace,
    admission: authorization.admission,
    previousReceiptSha256: receipt.previousReceiptSha256,
  }, recordEvidence);
  return recordEvidence;
}

function runtimeIdentities(authorization, recordEvidence) {
  const readinessEvidence = parseJson(
    recordEvidence.runtimeReadinessEvidenceSource,
    "proof runtime readiness evidence",
  );
  const applyReceipt = parseJson(
    readinessEvidence.runtimeApplyReceiptSource,
    "proof runtime apply receipt",
  );
  const applyEvidence = parseJson(
    readinessEvidence.runtimeApplyEvidenceSource,
    "proof runtime apply evidence",
  );
  verifySessionProofApplyEvidence({
    planSha256: authorization.planSha256,
    stepId: "start-runtime",
    action: "operator-apply",
    artifact: "runtime",
    artifactSha256: applyReceipt.artifactSha256,
    namespace: authorization.namespace,
    admission: authorization.admission,
  }, applyEvidence);
  const byIdentity = new Map(applyEvidence.resourceInventory.map((resource) => [identity(resource), resource]));
  const name = runtimeName(authorization);
  const job = byIdentity.get(`batch/v1/Job/${name}`);
  const retained = [
    byIdentity.get(`networking.k8s.io/v1/NetworkPolicy/${name}`),
    byIdentity.get(`v1/ServiceAccount/${name}`),
  ];
  if (!job || retained.some((resource) => !resource)) {
    throw new Error("proof runtime stop apply identities are incomplete");
  }
  return { job, retained: retained.sort((left, right) => identity(left).localeCompare(identity(right))) };
}

function verifyRetainedResources(expected, resources) {
  if (
    !Array.isArray(resources) ||
    resources.length !== expected.length ||
    resources.some((resource) =>
      !sameKeys(resource, ["apiVersion", "kind", "name", "uid"]) || !UID.test(resource.uid ?? "")) ||
    JSON.stringify(resources.map(identity)) !== JSON.stringify(expected.map(identity)) ||
    JSON.stringify(resources.map((resource) => resource.uid)) !==
      JSON.stringify(expected.map((resource) => resource.uid))
  ) {
    throw new Error("proof runtime stop retained resource identity drifted");
  }
}

export function verifySessionProofRuntimeStopEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "recordReceiptSource", "recordEvidenceSource", "deletedJobUid",
      "runtimeJobAbsent", "retainedResourceInventory",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.recordReceiptSource !== "string" ||
    Buffer.byteLength(evidence.recordReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.recordEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.recordEvidenceSource) > MAX_SOURCE_BYTES ||
    !UID.test(evidence.deletedJobUid ?? "") ||
    evidence.runtimeJobAbsent !== true
  ) {
    throw new Error("proof runtime stop evidence identity drifted");
  }
  const recordEvidence = verifyRecordPredecessor(
    authorization,
    evidence.recordReceiptSource,
    evidence.recordEvidenceSource,
  );
  const expected = runtimeIdentities(authorization, recordEvidence);
  if (evidence.deletedJobUid !== expected.job.uid) {
    throw new Error("proof runtime stop Job UID drifted");
  }
  verifyRetainedResources(expected.retained, evidence.retainedResourceInventory);
  if (Date.parse(evidence.observedAt) < Date.parse(recordEvidence.observedAt)) {
    throw new Error("proof runtime stop observation time drifted");
  }
  return true;
}

export function buildSessionProofRuntimeStopEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const recordReceiptSource = input.recordReceiptSource ?? "";
  const recordEvidenceSource = input.recordEvidenceSource ?? "";
  const recordEvidence = verifyRecordPredecessor(
    authorization,
    recordReceiptSource,
    recordEvidenceSource,
  );
  const expected = runtimeIdentities(authorization, recordEvidence);
  const retainedResourceInventory = (input.retainedResources ?? [])
    .map((resource) => ({
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.name,
      uid: resource.uid,
    }))
    .sort((left, right) => identity(left).localeCompare(identity(right)));
  verifyRetainedResources(expected.retained, retainedResourceInventory);
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    recordReceiptSource,
    recordEvidenceSource,
    deletedJobUid: expected.job.uid,
    runtimeJobAbsent: input.runtimeJobAbsent,
    retainedResourceInventory,
  };
  verifySessionProofRuntimeStopEvidence(authorization, evidence);
  return evidence;
}
