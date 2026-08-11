import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofCodexSmokeCompletionEvidence,
  verifySessionProofCodexSmokeReplacementChain,
} from "./codeops-session-proof-codex-smoke-completion-evidence.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_ATTEMPTS = 192;
const MAX_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 16 * 60 * 1000;

function run(args, runner) {
  return runner("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 20_000,
  });
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function readAndVerifyLiveIdentity(authorization, observedAt, runner) {
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(authorization.namespace.name, runner);
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId,
    namespaceResource,
    operator,
    target,
    observedAt,
  });
  return { namespaceResource, operator, target };
}

function verifyExecutionBoundary(authorization, input) {
  if (
    !RFC3339.test(input.startedAt ?? "") ||
    !RFC3339.test(input.completedAt ?? "") ||
    Date.parse(input.startedAt) < Date.parse(authorization.authorizedAt) ||
    Date.parse(input.completedAt) < Date.parse(input.startedAt) ||
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > MAX_ATTEMPTS ||
    !Number.isInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 0 ||
    input.pollIntervalMs > MAX_INTERVAL_MS ||
    (input.maxAttempts - 1) * input.pollIntervalMs > MAX_WAIT_MS
  ) {
    throw new Error("proof Codex smoke completion polling boundary drifted");
  }
}

function readJob(authorization, appliedJobUid, runner) {
  const source = run([
    "-n", authorization.namespace.name,
    "get", "job.batch", "codeops-codex-auth-smoke",
    "-o", "json",
    "--request-timeout=15s",
  ], runner);
  const job = parseJson(source, "proof Codex smoke Job");
  if (
    job?.apiVersion !== "batch/v1" ||
    job.kind !== "Job" ||
    job.metadata?.name !== "codeops-codex-auth-smoke" ||
    job.metadata?.namespace !== authorization.namespace.name ||
    job.metadata?.uid !== appliedJobUid ||
    job.metadata?.generation !== 1
  ) {
    throw new Error("proof Codex smoke live Job identity drifted");
  }
  if (
    (job.status?.failed ?? 0) > 0 ||
    (job.status?.conditions ?? []).some((condition) =>
      condition.type === "Failed" && condition.status === "True")
  ) {
    throw new Error("proof Codex smoke Job failed");
  }
  return job;
}

function readPersistentVolumeClaim(authorization, appliedClaimUid, runner) {
  const source = run([
    "-n", authorization.namespace.name,
    "get", "persistentvolumeclaim", "codeops-codex-auth",
    "-o", "json",
    "--request-timeout=15s",
  ], runner);
  const claim = parseJson(source, "proof Codex smoke credential claim");
  if (
    claim?.apiVersion !== "v1" ||
    claim.kind !== "PersistentVolumeClaim" ||
    claim.metadata?.name !== "codeops-codex-auth" ||
    claim.metadata?.namespace !== authorization.namespace.name ||
    claim.metadata?.uid !== appliedClaimUid ||
    typeof claim.metadata?.deletionTimestamp === "string" ||
    claim.status?.phase !== "Bound"
  ) {
    throw new Error("proof Codex smoke live credential claim drifted");
  }
  return claim;
}

function verifyLoginJobAbsent(authorization, runner) {
  const source = run([
    "-n", authorization.namespace.name,
    "get", "job.batch", "codeops-codex-auth-login",
    "-o", "name",
    "--ignore-not-found",
    "--request-timeout=15s",
  ], runner).trim();
  if (source !== "") throw new Error("proof Codex login Job reappeared during smoke completion");
  return true;
}

function defaultWait(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function buildEvidence(input, job, persistentVolumeClaim) {
  return buildSessionProofCodexSmokeCompletionEvidence({
    authorization: input.authorization,
    smokeReplacementReceiptSource: input.smokeReplacementReceiptSource,
    smokeReplacementEvidenceSource: input.smokeReplacementEvidenceSource,
    loginJobAbsent: true,
    job,
    persistentVolumeClaim,
    observedAt: input.completedAt,
  });
}

export function waitForSessionProofCodexSmoke(input, runner = execFileSync, wait = defaultWait) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "wait-codex-smoke" ||
    authorization.action !== "operator-wait-complete" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not the exact Codex smoke completion action");
  }
  verifyExecutionBoundary(authorization, input);
  const applied = verifySessionProofCodexSmokeReplacementChain(
    authorization,
    input.smokeReplacementReceiptSource ?? "",
    input.smokeReplacementEvidenceSource ?? "",
  );

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  verifyLoginJobAbsent(authorization, runner);
  const initialClaim = readPersistentVolumeClaim(
    authorization,
    applied.persistentVolumeClaimUid,
    runner,
  );
  let completedJob = null;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    verifyLoginJobAbsent(authorization, runner);
    const job = readJob(authorization, applied.jobUid, runner);
    try {
      buildEvidence(input, job, initialClaim);
      completedJob = job;
      break;
    } catch (error) {
      if (!String(error?.message).includes("Codex smoke completion Job drifted")) throw error;
    }
    if (attempt + 1 < input.maxAttempts) wait(input.pollIntervalMs);
  }
  if (!completedJob) {
    throw new Error("proof Codex smoke Job did not complete within the reviewed polling boundary");
  }

  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  verifyLoginJobAbsent(authorization, runner);
  const finalClaim = readPersistentVolumeClaim(
    authorization,
    applied.persistentVolumeClaimUid,
    runner,
  );
  const finalJob = readJob(authorization, applied.jobUid, runner);
  const evidenceSource = JSON.stringify(buildEvidence(input, finalJob, finalClaim));
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
