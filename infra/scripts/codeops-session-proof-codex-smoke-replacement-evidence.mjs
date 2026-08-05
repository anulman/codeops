import { createHash } from "node:crypto";
import {
  buildSessionProofApplyEvidence,
  verifySessionProofApplyEvidence,
} from "./codeops-session-proof-apply-evidence.mjs";
import { verifySessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_SOURCE_BYTES = 64 * 1024;
const RETAINED = [
  "networking.k8s.io/v1/NetworkPolicy/codeops-codex-auth",
  "v1/PersistentVolumeClaim/codeops-codex-auth",
  "v1/ServiceAccount/codeops-codex-auth",
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

function identity(resource) {
  return `${resource.apiVersion}/${resource.kind}/${resource.name}`;
}

function assertAuthorization(authorization) {
  if (
    authorization?.stepId !== "codex-smoke" ||
    authorization.action !== "operator-replace-auth-job" ||
    authorization.artifact !== "codex-smoke" ||
    !SHA256.test(authorization.artifactSha256 ?? "")
  ) {
    throw new Error("proof step is not qualified Codex smoke replacement");
  }
}

export function verifySessionProofCodexSmokePredecessor(authorization, receiptSource, evidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof Codex smoke predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof Codex login completion receipt");
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "wait-codex-login" ||
    receipt.action !== "operator-wait-complete" ||
    receipt.artifact !== null ||
    receipt.artifactSha256 !== null ||
    receipt.evidenceSha256 !== digest(evidenceSource)
  ) {
    throw new Error("proof Codex login completion receipt identity drifted");
  }
  const evidence = parseJson(evidenceSource, "proof Codex login completion evidence");
  verifySessionProofCodexLoginCompletionEvidence({
    planSha256: authorization.planSha256,
    stepIndex: receipt.stepIndex,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    namespace: authorization.namespace,
    previousReceiptSha256: digest(evidence.loginApplyReceiptSource ?? ""),
    authorizedAt: evidence.job?.startTime,
  }, evidence);
  return evidence;
}

function verifyReplacementContinuity(loginCompletionEvidence, smokeApplyEvidence) {
  const loginApplyEvidence = parseJson(
    loginCompletionEvidence.loginApplyEvidenceSource,
    "proof Codex login apply evidence",
  );
  const loginByIdentity = new Map(loginApplyEvidence.resourceInventory.map((resource) => [identity(resource), resource]));
  const smokeByIdentity = new Map(smokeApplyEvidence.resourceInventory.map((resource) => [identity(resource), resource]));
  for (const retainedIdentity of RETAINED) {
    if (
      !loginByIdentity.has(retainedIdentity) ||
      smokeByIdentity.get(retainedIdentity)?.uid !== loginByIdentity.get(retainedIdentity)?.uid
    ) {
      throw new Error("proof Codex smoke retained resource identity drifted");
    }
  }
  const loginJob = loginByIdentity.get("batch/v1/Job/codeops-codex-auth-login");
  const smokeJob = smokeByIdentity.get("batch/v1/Job/codeops-codex-auth-smoke");
  if (!loginJob || !smokeJob || smokeJob.uid === loginJob.uid) {
    throw new Error("proof Codex smoke replacement Job identity drifted");
  }
  return loginJob.uid;
}

export function verifySessionProofCodexSmokeReplacementEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "artifactSha256", "loginCompletionReceiptSource",
      "loginCompletionEvidenceSource", "replacedLoginJobUid", "loginJobAbsent",
      "smokeApplyEvidenceSource",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    evidence.artifactSha256 !== authorization.artifactSha256 ||
    typeof evidence.loginCompletionReceiptSource !== "string" ||
    Buffer.byteLength(evidence.loginCompletionReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.loginCompletionEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.loginCompletionEvidenceSource) > MAX_SOURCE_BYTES ||
    typeof evidence.smokeApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.smokeApplyEvidenceSource) > MAX_SOURCE_BYTES ||
    evidence.loginJobAbsent !== true
  ) {
    throw new Error("proof Codex smoke replacement evidence identity drifted");
  }
  const loginCompletionEvidence = verifySessionProofCodexSmokePredecessor(
    authorization,
    evidence.loginCompletionReceiptSource,
    evidence.loginCompletionEvidenceSource,
  );
  const smokeApplyEvidence = parseJson(evidence.smokeApplyEvidenceSource, "proof Codex smoke apply evidence");
  verifySessionProofApplyEvidence(authorization, smokeApplyEvidence);
  const replacedLoginJobUid = verifyReplacementContinuity(loginCompletionEvidence, smokeApplyEvidence);
  if (evidence.replacedLoginJobUid !== replacedLoginJobUid) {
    throw new Error("proof Codex smoke replaced Job UID drifted");
  }
  if (Date.parse(evidence.observedAt) < Date.parse(loginCompletionEvidence.observedAt)) {
    throw new Error("proof Codex smoke replacement timestamp drifted");
  }
  return true;
}

export function buildSessionProofCodexSmokeReplacementEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const loginCompletionReceiptSource = input.loginCompletionReceiptSource ?? "";
  const loginCompletionEvidenceSource = input.loginCompletionEvidenceSource ?? "";
  const loginCompletionEvidence = verifySessionProofCodexSmokePredecessor(
    authorization,
    loginCompletionReceiptSource,
    loginCompletionEvidenceSource,
  );
  const smokeApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: input.observedAt,
    resources: input.resources,
  }));
  const smokeApplyEvidence = parseJson(smokeApplyEvidenceSource, "proof Codex smoke apply evidence");
  const replacedLoginJobUid = verifyReplacementContinuity(loginCompletionEvidence, smokeApplyEvidence);
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    artifactSha256: authorization.artifactSha256,
    loginCompletionReceiptSource,
    loginCompletionEvidenceSource,
    replacedLoginJobUid,
    loginJobAbsent: input.loginJobAbsent,
    smokeApplyEvidenceSource,
  };
  verifySessionProofCodexSmokeReplacementEvidence(authorization, evidence);
  return evidence;
}
