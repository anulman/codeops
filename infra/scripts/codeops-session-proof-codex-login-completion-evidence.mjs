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
    authorization?.stepId !== "wait-codex-login" ||
    authorization.action !== "operator-wait-complete" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified Codex login completion");
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
    ttlSecondsAfterFinished: job?.spec?.ttlSecondsAfterFinished,
    active: job?.status?.active ?? 0,
    succeeded: job?.status?.succeeded ?? 0,
    failed: job?.status?.failed ?? 0,
    startTime: job?.status?.startTime,
    completionTime: job?.status?.completionTime,
    conditions: normalizeConditions(job?.status?.conditions),
  };
}

function normalizePersistentVolumeClaim(claim) {
  return {
    apiVersion: claim?.apiVersion,
    kind: claim?.kind,
    name: claim?.metadata?.name,
    uid: claim?.metadata?.uid,
    deleting: typeof claim?.metadata?.deletionTimestamp === "string",
    phase: claim?.status?.phase,
  };
}

function verifyJob(job) {
  if (
    !sameKeys(job, [
      "apiVersion", "kind", "name", "uid", "generation", "completions",
      "parallelism", "backoffLimit", "activeDeadlineSeconds",
      "ttlSecondsAfterFinished", "active", "succeeded", "failed",
      "startTime", "completionTime", "conditions",
    ]) ||
    job.apiVersion !== "batch/v1" ||
    job.kind !== "Job" ||
    job.name !== "codeops-codex-auth-login" ||
    !UID.test(job.uid ?? "") ||
    job.generation !== 1 ||
    job.completions !== 1 ||
    job.parallelism !== 1 ||
    job.backoffLimit !== 0 ||
    job.activeDeadlineSeconds !== 900 ||
    job.ttlSecondsAfterFinished !== 3600 ||
    job.active !== 0 ||
    job.succeeded !== 1 ||
    job.failed !== 0 ||
    !RFC3339.test(job.startTime ?? "") ||
    !RFC3339.test(job.completionTime ?? "") ||
    Date.parse(job.completionTime) < Date.parse(job.startTime) ||
    JSON.stringify(job.conditions) !== JSON.stringify([{ type: "Complete", status: "True" }])
  ) {
    throw new Error("proof Codex login completion Job drifted");
  }
}

function verifyPersistentVolumeClaim(claim) {
  if (
    !sameKeys(claim, ["apiVersion", "kind", "name", "uid", "deleting", "phase"]) ||
    claim.apiVersion !== "v1" ||
    claim.kind !== "PersistentVolumeClaim" ||
    claim.name !== "codeops-codex-auth" ||
    !UID.test(claim.uid ?? "") ||
    claim.deleting !== false ||
    claim.phase !== "Bound"
  ) {
    throw new Error("proof Codex login credential claim drifted");
  }
}

export function verifySessionProofCodexLoginApplyChain(authorization, receiptSource, applyEvidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof Codex login completion predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof Codex login apply receipt");
  if (
    receipt?.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "codex-login" ||
    receipt.action !== "operator-apply" ||
    receipt.artifact !== "codex-login" ||
    !SHA256.test(receipt.artifactSha256 ?? "") ||
    receipt.evidenceSha256 !== digest(applyEvidenceSource)
  ) {
    throw new Error("proof Codex login apply receipt identity drifted");
  }
  const applyEvidence = parseJson(applyEvidenceSource, "proof Codex login apply evidence");
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
    resource.name === "codeops-codex-auth-login");
  const claim = applyEvidence.resourceInventory.find((resource) =>
    resource.apiVersion === "v1" &&
    resource.kind === "PersistentVolumeClaim" &&
    resource.name === "codeops-codex-auth");
  if (!job || !claim) {
    throw new Error("proof Codex login apply evidence lacks Job or credential claim identity");
  }
  return {
    jobUid: job.uid,
    persistentVolumeClaimUid: claim.uid,
    appliedAt: applyEvidence.observedAt,
  };
}

export function verifySessionProofCodexLoginCompletionEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "loginApplyReceiptSource", "loginApplyEvidenceSource", "job",
      "persistentVolumeClaim",
    ]) ||
    evidence.apiVersion !== "codeops.example/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.loginApplyReceiptSource !== "string" ||
    Buffer.byteLength(evidence.loginApplyReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.loginApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.loginApplyEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof Codex login completion evidence identity drifted");
  }
  const applied = verifySessionProofCodexLoginApplyChain(
    authorization,
    evidence.loginApplyReceiptSource,
    evidence.loginApplyEvidenceSource,
  );
  verifyJob(evidence.job);
  verifyPersistentVolumeClaim(evidence.persistentVolumeClaim);
  if (
    evidence.job.uid !== applied.jobUid ||
    evidence.persistentVolumeClaim.uid !== applied.persistentVolumeClaimUid
  ) {
    throw new Error("proof Codex login live identity drifted from apply evidence");
  }
  if (
    Date.parse(evidence.job.startTime) < Date.parse(applied.appliedAt) ||
    Date.parse(evidence.observedAt) < Date.parse(evidence.job.completionTime)
  ) {
    throw new Error("proof Codex login completion timestamp drifted");
  }
  return true;
}

export function buildSessionProofCodexLoginCompletionEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.loginApplyReceiptSource ?? "";
  const applyEvidenceSource = input.loginApplyEvidenceSource ?? "";
  const applied = verifySessionProofCodexLoginApplyChain(
    authorization,
    receiptSource,
    applyEvidenceSource,
  );
  const job = normalizeJob(input.job);
  const persistentVolumeClaim = normalizePersistentVolumeClaim(input.persistentVolumeClaim);
  if (
    job.uid !== applied.jobUid ||
    persistentVolumeClaim.uid !== applied.persistentVolumeClaimUid
  ) {
    throw new Error("proof Codex login live identity drifted from apply evidence");
  }
  verifyJob(job);
  verifyPersistentVolumeClaim(persistentVolumeClaim);
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    loginApplyReceiptSource: receiptSource,
    loginApplyEvidenceSource: applyEvidenceSource,
    job,
    persistentVolumeClaim,
  };
  verifySessionProofCodexLoginCompletionEvidence(authorization, evidence);
  return evidence;
}
