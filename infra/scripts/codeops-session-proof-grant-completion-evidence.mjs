import { createHash } from "node:crypto";
import { verifySessionProofApplyEvidence } from "./codeops-session-proof-apply-evidence.mjs";

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

function assertAuthorization(authorization) {
  if (
    authorization?.stepId !== "wait-grants" ||
    authorization.action !== "operator-wait-complete" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified grant completion");
  }
}

function normalizeConditions(conditions) {
  return (conditions ?? [])
    .filter((condition) => ["Complete", "Failed"].includes(condition.type))
    .map((condition) => ({ type: condition.type, status: condition.status }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function normalizeJob(job) {
  return {
    apiVersion: job?.apiVersion,
    kind: job?.kind,
    name: job?.metadata?.name,
    uid: job?.metadata?.uid,
    generation: job?.metadata?.generation,
    completions: job?.spec?.completions,
    parallelism: job?.spec?.parallelism,
    backoffLimit: job?.spec?.backoffLimit,
    activeDeadlineSeconds: job?.spec?.activeDeadlineSeconds,
    active: job?.status?.active ?? 0,
    succeeded: job?.status?.succeeded ?? 0,
    failed: job?.status?.failed ?? 0,
    startTime: job?.status?.startTime,
    completionTime: job?.status?.completionTime,
    conditions: normalizeConditions(job?.status?.conditions),
  };
}

function verifyJob(job) {
  if (
    !sameKeys(job, [
      "apiVersion", "kind", "name", "uid", "generation", "completions",
      "parallelism", "backoffLimit", "activeDeadlineSeconds", "active",
      "succeeded", "failed", "startTime", "completionTime", "conditions",
    ]) ||
    job.apiVersion !== "batch/v1" ||
    job.kind !== "Job" ||
    job.name !== "codeops-session-proof-grants" ||
    !UID.test(job.uid ?? "") ||
    job.generation !== 1 ||
    job.completions !== 1 ||
    job.parallelism !== 1 ||
    job.backoffLimit !== 0 ||
    job.activeDeadlineSeconds !== 300 ||
    job.active !== 0 ||
    job.succeeded !== 1 ||
    job.failed !== 0 ||
    !RFC3339.test(job.startTime ?? "") ||
    !RFC3339.test(job.completionTime ?? "") ||
    Date.parse(job.completionTime) < Date.parse(job.startTime) ||
    JSON.stringify(job.conditions) !== JSON.stringify([{ type: "Complete", status: "True" }])
  ) {
    throw new Error("proof grant completion Job drifted");
  }
}

export function verifySessionProofGrantApplyChain(authorization, receiptSource, applyEvidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof grant completion predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof grant apply receipt");
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "grant-receipts" ||
    receipt.action !== "operator-apply" ||
    receipt.artifact !== "grants" ||
    !SHA256.test(receipt.artifactSha256 ?? "") ||
    receipt.evidenceSha256 !== digest(applyEvidenceSource)
  ) {
    throw new Error("proof grant apply receipt identity drifted");
  }
  const applyEvidence = parseJson(applyEvidenceSource, "proof grant apply evidence");
  verifySessionProofApplyEvidence({
    planSha256: authorization.planSha256,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    namespace: authorization.namespace,
  }, applyEvidence);
  const job = applyEvidence.resourceInventory.find((resource) =>
    resource.apiVersion === "batch/v1" &&
    resource.kind === "Job" &&
    resource.name === "codeops-session-proof-grants");
  if (!job) throw new Error("proof grant apply evidence has no Job identity");
  return job.uid;
}

export function verifySessionProofGrantCompletionEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "grantApplyReceiptSource", "grantApplyEvidenceSource", "job",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.grantApplyReceiptSource !== "string" ||
    Buffer.byteLength(evidence.grantApplyReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.grantApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.grantApplyEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof grant completion evidence identity drifted");
  }
  const appliedJobUid = verifySessionProofGrantApplyChain(
    authorization,
    evidence.grantApplyReceiptSource,
    evidence.grantApplyEvidenceSource,
  );
  verifyJob(evidence.job);
  if (evidence.job.uid !== appliedJobUid) {
    throw new Error("proof grant completion Job UID drifted from apply evidence");
  }
  if (Date.parse(evidence.observedAt) < Date.parse(evidence.job.completionTime)) {
    throw new Error("proof grant completion timestamp drifted");
  }
  return true;
}

export function buildSessionProofGrantCompletionEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.grantApplyReceiptSource ?? "";
  const applyEvidenceSource = input.grantApplyEvidenceSource ?? "";
  const appliedJobUid = verifySessionProofGrantApplyChain(
    authorization,
    receiptSource,
    applyEvidenceSource,
  );
  const job = normalizeJob(input.job);
  if (job.uid !== appliedJobUid) {
    throw new Error("proof grant completion Job UID drifted from apply evidence");
  }
  verifyJob(job);
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    grantApplyReceiptSource: receiptSource,
    grantApplyEvidenceSource: applyEvidenceSource,
    job,
  };
  verifySessionProofGrantCompletionEvidence(authorization, evidence);
  return evidence;
}
