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
    authorization?.stepId !== "wait-database" ||
    authorization.action !== "operator-wait-ready" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified database readiness");
  }
}

function normalizeConditions(conditions) {
  return (conditions ?? [])
    .filter((condition) => ["Available", "Progressing"].includes(condition.type))
    .map((condition) => ({ type: condition.type, status: condition.status }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function normalizeDeployment(deployment) {
  return {
    apiVersion: deployment?.apiVersion,
    kind: deployment?.kind,
    name: deployment?.metadata?.name,
    uid: deployment?.metadata?.uid,
    generation: deployment?.metadata?.generation,
    observedGeneration: deployment?.status?.observedGeneration,
    desiredReplicas: deployment?.spec?.replicas,
    replicas: deployment?.status?.replicas ?? 0,
    updatedReplicas: deployment?.status?.updatedReplicas ?? 0,
    readyReplicas: deployment?.status?.readyReplicas ?? 0,
    availableReplicas: deployment?.status?.availableReplicas ?? 0,
    unavailableReplicas: deployment?.status?.unavailableReplicas ?? 0,
    conditions: normalizeConditions(deployment?.status?.conditions),
  };
}

function verifyDeployment(deployment) {
  const expectedConditions = [
    { type: "Available", status: "True" },
    { type: "Progressing", status: "True" },
  ];
  if (
    !sameKeys(deployment, [
      "apiVersion", "kind", "name", "uid", "generation", "observedGeneration",
      "desiredReplicas", "replicas", "updatedReplicas", "readyReplicas",
      "availableReplicas", "unavailableReplicas", "conditions",
    ]) ||
    deployment.apiVersion !== "apps/v1" ||
    deployment.kind !== "Deployment" ||
    deployment.name !== "codeops-session-proof-database" ||
    !UID.test(deployment.uid ?? "") ||
    deployment.generation !== 1 ||
    deployment.observedGeneration !== deployment.generation ||
    deployment.desiredReplicas !== 1 ||
    deployment.replicas !== 1 ||
    deployment.updatedReplicas !== 1 ||
    deployment.readyReplicas !== 1 ||
    deployment.availableReplicas !== 1 ||
    deployment.unavailableReplicas !== 0 ||
    JSON.stringify(deployment.conditions) !== JSON.stringify(expectedConditions)
  ) {
    throw new Error("proof database readiness deployment drifted");
  }
}

export function verifySessionProofDatabaseApplyChain(
  authorization,
  receiptSource,
  applyEvidenceSource,
) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof database readiness predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof database apply receipt");
  const applyEvidenceSha256 = digest(applyEvidenceSource);
  if (
    receipt?.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "start-database" ||
    receipt.action !== "operator-apply" ||
    receipt.artifact !== "database" ||
    !SHA256.test(receipt.artifactSha256 ?? "") ||
    receipt.evidenceSha256 !== applyEvidenceSha256
  ) {
    throw new Error("proof database apply receipt identity drifted");
  }
  const applyEvidence = parseJson(applyEvidenceSource, "proof database apply evidence");
  verifySessionProofApplyEvidence({
    planSha256: authorization.planSha256,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    namespace: authorization.namespace,
  }, applyEvidence);
  const appliedDeployment = applyEvidence.resourceInventory.find((resource) =>
    resource.apiVersion === "apps/v1" &&
    resource.kind === "Deployment" &&
    resource.name === "codeops-session-proof-database");
  if (!appliedDeployment) {
    throw new Error("proof database apply evidence has no Deployment identity");
  }
  return appliedDeployment.uid;
}

export function verifySessionProofReadinessEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "databaseApplyReceiptSource", "databaseApplyEvidenceSource", "deployment",
    ]) ||
    evidence.apiVersion !== "codeops.example/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.databaseApplyReceiptSource !== "string" ||
    Buffer.byteLength(evidence.databaseApplyReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.databaseApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.databaseApplyEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof database readiness evidence identity drifted");
  }
  const appliedDeploymentUid = verifySessionProofDatabaseApplyChain(
    authorization,
    evidence.databaseApplyReceiptSource,
    evidence.databaseApplyEvidenceSource,
  );
  verifyDeployment(evidence.deployment);
  if (evidence.deployment.uid !== appliedDeploymentUid) {
    throw new Error("proof database readiness Deployment UID drifted from apply evidence");
  }
  return true;
}

export function buildSessionProofReadinessEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.databaseApplyReceiptSource ?? "";
  const applyEvidenceSource = input.databaseApplyEvidenceSource ?? "";
  const appliedDeploymentUid = verifySessionProofDatabaseApplyChain(
    authorization,
    receiptSource,
    applyEvidenceSource,
  );
  const deployment = normalizeDeployment(input.deployment);
  if (deployment.uid !== appliedDeploymentUid) {
    throw new Error("proof database readiness Deployment UID drifted from apply evidence");
  }
  verifyDeployment(deployment);
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    databaseApplyReceiptSource: receiptSource,
    databaseApplyEvidenceSource: applyEvidenceSource,
    deployment,
  };
  verifySessionProofReadinessEvidence(authorization, evidence);
  return evidence;
}
