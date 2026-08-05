import { createHash } from "node:crypto";
import { verifySessionProofApplyEvidence } from "./codeops-session-proof-apply-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const UID = /^.{1,256}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_SOURCE_BYTES = 64 * 1024;
const EXPECTED_COLUMNS = [
  { name: "dispatch_id", dataType: "uuid", nullable: false },
  { name: "dispatch_digest", dataType: "text", nullable: false },
  { name: "status", dataType: "text", nullable: false },
  { name: "result_json", dataType: "jsonb", nullable: true },
  { name: "created_at", dataType: "timestamp with time zone", nullable: false },
  { name: "completed_at", dataType: "timestamp with time zone", nullable: true },
];
const EXPECTED_FOREIGN_KEYS = [{
  columns: ["dispatch_id"],
  referencedSchema: "codeops",
  referencedTable: "session_runtime_outbox",
  referencedColumns: ["dispatch_id"],
}];
const EXPECTED_CHECKS = [
  "dispatch-digest-sha256",
  "receipt-state-shape",
  "result-type-lifecycle",
  "status-enum",
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
    authorization?.stepId !== "wait-gateway-migration" ||
    authorization.action !== "operator-wait-ready" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified gateway migration readiness");
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
  if (
    !sameKeys(deployment, [
      "apiVersion", "kind", "name", "uid", "generation", "observedGeneration",
      "desiredReplicas", "replicas", "updatedReplicas", "readyReplicas",
      "availableReplicas", "unavailableReplicas", "conditions",
    ]) ||
    deployment.apiVersion !== "apps/v1" ||
    deployment.kind !== "Deployment" ||
    deployment.name !== "codeops-control-gateway" ||
    !UID.test(deployment.uid ?? "") ||
    deployment.generation !== 1 ||
    deployment.observedGeneration !== 1 ||
    deployment.desiredReplicas !== 1 ||
    deployment.replicas !== 1 ||
    deployment.updatedReplicas !== 1 ||
    deployment.readyReplicas !== 1 ||
    deployment.availableReplicas !== 1 ||
    deployment.unavailableReplicas !== 0 ||
    JSON.stringify(deployment.conditions) !== JSON.stringify([
      { type: "Available", status: "True" },
      { type: "Progressing", status: "True" },
    ])
  ) {
    throw new Error("proof gateway readiness deployment drifted");
  }
}

function verifyMigrationRelation(relation) {
  if (
    !sameKeys(relation, [
      "schema", "name", "oid", "columns", "primaryKey", "foreignKeys", "checkConstraints",
    ]) ||
    relation.schema !== "codeops" ||
    relation.name !== "session_runtime_execution_receipts" ||
    !Number.isInteger(relation.oid) ||
    relation.oid < 1 ||
    JSON.stringify(relation.columns) !== JSON.stringify(EXPECTED_COLUMNS) ||
    JSON.stringify(relation.primaryKey) !== JSON.stringify(["dispatch_id"]) ||
    JSON.stringify(relation.foreignKeys) !== JSON.stringify(EXPECTED_FOREIGN_KEYS) ||
    JSON.stringify(relation.checkConstraints) !== JSON.stringify(EXPECTED_CHECKS)
  ) {
    throw new Error("proof gateway migration relation drifted");
  }
}

function verifyGatewayApplyChain(authorization, receiptSource, applyEvidenceSource) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof gateway readiness predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof gateway apply receipt");
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "start-gateway" ||
    receipt.action !== "operator-apply" ||
    receipt.artifact !== "gateway" ||
    !SHA256.test(receipt.artifactSha256 ?? "") ||
    receipt.evidenceSha256 !== digest(applyEvidenceSource)
  ) {
    throw new Error("proof gateway apply receipt identity drifted");
  }
  const applyEvidence = parseJson(applyEvidenceSource, "proof gateway apply evidence");
  verifySessionProofApplyEvidence({
    planSha256: authorization.planSha256,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    namespace: authorization.namespace,
  }, applyEvidence);
  const deployment = applyEvidence.resourceInventory.find((resource) =>
    resource.apiVersion === "apps/v1" &&
    resource.kind === "Deployment" &&
    resource.name === "codeops-control-gateway");
  if (!deployment) throw new Error("proof gateway apply evidence has no Deployment identity");
  return deployment.uid;
}

export function verifySessionProofGatewayReadinessEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "gatewayApplyReceiptSource", "gatewayApplyEvidenceSource", "deployment",
      "migrationRelation",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.gatewayApplyReceiptSource !== "string" ||
    Buffer.byteLength(evidence.gatewayApplyReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.gatewayApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.gatewayApplyEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof gateway readiness evidence identity drifted");
  }
  const appliedDeploymentUid = verifyGatewayApplyChain(
    authorization,
    evidence.gatewayApplyReceiptSource,
    evidence.gatewayApplyEvidenceSource,
  );
  verifyDeployment(evidence.deployment);
  if (evidence.deployment.uid !== appliedDeploymentUid) {
    throw new Error("proof gateway readiness Deployment UID drifted from apply evidence");
  }
  verifyMigrationRelation(evidence.migrationRelation);
  return true;
}

export function buildSessionProofGatewayReadinessEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.gatewayApplyReceiptSource ?? "";
  const applyEvidenceSource = input.gatewayApplyEvidenceSource ?? "";
  const appliedDeploymentUid = verifyGatewayApplyChain(authorization, receiptSource, applyEvidenceSource);
  const deployment = normalizeDeployment(input.deployment);
  if (deployment.uid !== appliedDeploymentUid) {
    throw new Error("proof gateway readiness Deployment UID drifted from apply evidence");
  }
  verifyDeployment(deployment);
  verifyMigrationRelation(input.migrationRelation);
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    gatewayApplyReceiptSource: receiptSource,
    gatewayApplyEvidenceSource: applyEvidenceSource,
    deployment,
    migrationRelation: input.migrationRelation,
  };
  verifySessionProofGatewayReadinessEvidence(authorization, evidence);
  return evidence;
}

export function sessionProofGatewayMigrationRelation() {
  return {
    schema: "codeops",
    name: "session_runtime_execution_receipts",
    oid: 12345,
    columns: EXPECTED_COLUMNS.map((column) => ({ ...column })),
    primaryKey: ["dispatch_id"],
    foreignKeys: EXPECTED_FOREIGN_KEYS.map((key) => ({
      ...key,
      columns: [...key.columns],
      referencedColumns: [...key.referencedColumns],
    })),
    checkConstraints: [...EXPECTED_CHECKS],
  };
}
