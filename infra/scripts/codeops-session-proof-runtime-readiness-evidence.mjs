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

function runtimeName(authorization) {
  return `codeops-session-runtime-${authorization.admission?.identity?.sessionSuffix ?? ""}`;
}

function assertAuthorization(authorization) {
  if (
    authorization?.stepId !== "wait-runtime" ||
    authorization.action !== "operator-wait-ready" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not qualified runtime readiness");
  }
}

function conditionStatus(conditions, type) {
  return conditions?.find((condition) => condition.type === type)?.status ?? "False";
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
    ready: job?.status?.ready ?? 0,
    succeeded: job?.status?.succeeded ?? 0,
    failed: job?.status?.failed ?? 0,
    startTime: job?.status?.startTime,
    complete: conditionStatus(job?.status?.conditions, "Complete"),
    failedCondition: conditionStatus(job?.status?.conditions, "Failed"),
    failureTarget: conditionStatus(job?.status?.conditions, "FailureTarget"),
  };
}

function normalizePodConditions(conditions) {
  return ["ContainersReady", "Initialized", "PodScheduled", "Ready"]
    .map((type) => ({ type, status: conditionStatus(conditions, type) }));
}

function normalizeInitContainers(statuses) {
  return (statuses ?? []).map((status) => ({
    name: status.name,
    restartCount: status.restartCount,
    exitCode: status.state?.terminated?.exitCode,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeContainers(statuses) {
  return (statuses ?? []).map((status) => ({
    name: status.name,
    ready: status.ready,
    restartCount: status.restartCount,
    running: Boolean(status.state?.running?.startedAt),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePod(pod) {
  const jobOwner = pod?.metadata?.ownerReferences?.find((owner) =>
    owner.apiVersion === "batch/v1" && owner.kind === "Job" && owner.controller === true);
  return {
    apiVersion: pod?.apiVersion,
    kind: pod?.kind,
    name: pod?.metadata?.name,
    uid: pod?.metadata?.uid,
    jobName: pod?.metadata?.labels?.["job-name"],
    ownerJobUid: jobOwner?.uid,
    deletionTimestamp: pod?.metadata?.deletionTimestamp ?? null,
    phase: pod?.status?.phase,
    startTime: pod?.status?.startTime,
    conditions: normalizePodConditions(pod?.status?.conditions),
    initContainers: normalizeInitContainers(pod?.status?.initContainerStatuses),
    containers: normalizeContainers(pod?.status?.containerStatuses),
  };
}

function verifyJob(authorization, job) {
  if (
    !sameKeys(job, [
      "apiVersion", "kind", "name", "uid", "generation", "completions",
      "parallelism", "backoffLimit", "activeDeadlineSeconds", "active", "ready",
      "succeeded", "failed", "startTime", "complete", "failedCondition",
      "failureTarget",
    ]) ||
    job.apiVersion !== "batch/v1" ||
    job.kind !== "Job" ||
    job.name !== runtimeName(authorization) ||
    !UID.test(job.uid ?? "") ||
    job.generation !== 1 ||
    job.completions !== 1 ||
    job.parallelism !== 1 ||
    job.backoffLimit !== 0 ||
    job.activeDeadlineSeconds !== 3600 ||
    job.active !== 1 ||
    job.ready !== 1 ||
    job.succeeded !== 0 ||
    job.failed !== 0 ||
    !RFC3339.test(job.startTime ?? "") ||
    job.complete !== "False" ||
    job.failedCondition !== "False" ||
    job.failureTarget !== "False"
  ) {
    throw new Error("proof runtime readiness Job drifted");
  }
}

function verifyPod(authorization, pod, job) {
  const expectedConditions = [
    { type: "ContainersReady", status: "True" },
    { type: "Initialized", status: "True" },
    { type: "PodScheduled", status: "True" },
    { type: "Ready", status: "True" },
  ];
  const expectedInit = [{ name: "workspace-builder", restartCount: 0, exitCode: 0 }];
  const expectedContainers = [
    { name: "coding-agent", ready: true, restartCount: 0, running: true },
    { name: "runtime-worker", ready: true, restartCount: 0, running: true },
  ];
  if (
    !sameKeys(pod, [
      "apiVersion", "kind", "name", "uid", "jobName", "ownerJobUid",
      "deletionTimestamp", "phase", "startTime", "conditions", "initContainers",
      "containers",
    ]) ||
    pod.apiVersion !== "v1" ||
    pod.kind !== "Pod" ||
    typeof pod.name !== "string" ||
    !pod.name.startsWith(`${runtimeName(authorization)}-`) ||
    !UID.test(pod.uid ?? "") ||
    pod.jobName !== job.name ||
    pod.ownerJobUid !== job.uid ||
    pod.deletionTimestamp !== null ||
    pod.phase !== "Running" ||
    !RFC3339.test(pod.startTime ?? "") ||
    Date.parse(pod.startTime) < Date.parse(job.startTime) ||
    JSON.stringify(pod.conditions) !== JSON.stringify(expectedConditions) ||
    JSON.stringify(pod.initContainers) !== JSON.stringify(expectedInit) ||
    JSON.stringify(pod.containers) !== JSON.stringify(expectedContainers)
  ) {
    throw new Error("proof runtime readiness Pod drifted");
  }
}

export function verifySessionProofRuntimeApplyChain(
  authorization,
  receiptSource,
  applyEvidenceSource,
) {
  if (digest(receiptSource) !== authorization.previousReceiptSha256) {
    throw new Error("proof runtime readiness predecessor receipt drifted");
  }
  const receipt = parseJson(receiptSource, "proof runtime apply receipt");
  if (
    receipt?.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "start-runtime" ||
    receipt.action !== "operator-apply" ||
    receipt.artifact !== "runtime" ||
    !SHA256.test(receipt.artifactSha256 ?? "") ||
    receipt.evidenceSha256 !== digest(applyEvidenceSource)
  ) {
    throw new Error("proof runtime apply receipt identity drifted");
  }
  const applyEvidence = parseJson(applyEvidenceSource, "proof runtime apply evidence");
  verifySessionProofApplyEvidence({
    planSha256: authorization.planSha256,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    namespace: authorization.namespace,
    admission: authorization.admission,
  }, applyEvidence);
  const appliedJob = applyEvidence.resourceInventory.find((resource) =>
    resource.apiVersion === "batch/v1" &&
    resource.kind === "Job" &&
    resource.name === runtimeName(authorization));
  if (!appliedJob) throw new Error("proof runtime apply evidence has no Job identity");
  return appliedJob.uid;
}

export function verifySessionProofRuntimeReadinessEvidence(authorization, evidence) {
  assertAuthorization(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "runtimeApplyReceiptSource", "runtimeApplyEvidenceSource", "job", "pod",
    ]) ||
    evidence.apiVersion !== "codeops.example/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    typeof evidence.runtimeApplyReceiptSource !== "string" ||
    Buffer.byteLength(evidence.runtimeApplyReceiptSource) > MAX_SOURCE_BYTES ||
    typeof evidence.runtimeApplyEvidenceSource !== "string" ||
    Buffer.byteLength(evidence.runtimeApplyEvidenceSource) > MAX_SOURCE_BYTES
  ) {
    throw new Error("proof runtime readiness evidence identity drifted");
  }
  const appliedJobUid = verifySessionProofRuntimeApplyChain(
    authorization,
    evidence.runtimeApplyReceiptSource,
    evidence.runtimeApplyEvidenceSource,
  );
  verifyJob(authorization, evidence.job);
  verifyPod(authorization, evidence.pod, evidence.job);
  if (evidence.job.uid !== appliedJobUid) {
    throw new Error("proof runtime readiness Job UID drifted from apply evidence");
  }
  if (
    Date.parse(evidence.observedAt) < Date.parse(evidence.job.startTime) ||
    Date.parse(evidence.observedAt) < Date.parse(evidence.pod.startTime)
  ) {
    throw new Error("proof runtime readiness observation time drifted");
  }
  return true;
}

export function buildSessionProofRuntimeReadinessEvidence(input) {
  const authorization = input.authorization;
  assertAuthorization(authorization);
  const receiptSource = input.runtimeApplyReceiptSource ?? "";
  const applyEvidenceSource = input.runtimeApplyEvidenceSource ?? "";
  const appliedJobUid = verifySessionProofRuntimeApplyChain(
    authorization,
    receiptSource,
    applyEvidenceSource,
  );
  const job = normalizeJob(input.job);
  const pod = normalizePod(input.pod);
  if (job.uid !== appliedJobUid) {
    throw new Error("proof runtime readiness Job UID drifted from apply evidence");
  }
  verifyJob(authorization, job);
  verifyPod(authorization, pod, job);
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
    runtimeApplyReceiptSource: receiptSource,
    runtimeApplyEvidenceSource: applyEvidenceSource,
    job,
    pod,
  };
  verifySessionProofRuntimeReadinessEvidence(authorization, evidence);
  return evidence;
}
