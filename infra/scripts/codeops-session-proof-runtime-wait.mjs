import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofRuntimeReadinessEvidence,
  verifySessionProofRuntimeApplyChain,
} from "./codeops-session-proof-runtime-readiness-evidence.mjs";
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
const MAX_ATTEMPTS = 300;
const MAX_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 5 * 60 * 1000;

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

function runtimeName(authorization) {
  return `codeops-session-runtime-${authorization.admission?.identity?.sessionSuffix ?? ""}`;
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
    throw new Error("proof runtime readiness polling boundary drifted");
  }
}

function readJob(authorization, appliedJobUid, runner) {
  const name = runtimeName(authorization);
  const source = run([
    "-n", authorization.namespace.name,
    "get", "job.batch", name,
    "-o", "json",
    "--request-timeout=15s",
  ], runner);
  const job = parseJson(source, "proof runtime Job");
  if (
    job?.apiVersion !== "batch/v1" ||
    job.kind !== "Job" ||
    job.metadata?.name !== name ||
    job.metadata?.namespace !== authorization.namespace.name ||
    job.metadata?.uid !== appliedJobUid ||
    job.metadata?.generation !== 1
  ) {
    throw new Error("proof runtime live Job identity drifted");
  }
  if (
    (job.status?.failed ?? 0) > 0 ||
    job.status?.conditions?.some((condition) =>
      ["Failed", "FailureTarget"].includes(condition.type) && condition.status === "True")
  ) {
    throw new Error("proof runtime Job reached terminal failure");
  }
  return job;
}

function readPod(authorization, job, runner) {
  const source = run([
    "-n", authorization.namespace.name,
    "get", "pods",
    "--selector", `job-name=${job.metadata.name}`,
    "-o", "json",
    "--request-timeout=15s",
  ], runner);
  const list = parseJson(source, "proof runtime Pod list");
  if (list?.apiVersion !== "v1" || list.kind !== "List" || !Array.isArray(list.items)) {
    throw new Error("proof runtime Pod list identity drifted");
  }
  if (list.items.length === 0) return null;
  if (list.items.length !== 1) {
    throw new Error("proof runtime gained multiple Pods");
  }
  const pod = list.items[0];
  const owner = pod.metadata?.ownerReferences?.find((value) =>
    value.apiVersion === "batch/v1" && value.kind === "Job" && value.controller === true);
  if (
    pod.apiVersion !== "v1" ||
    pod.kind !== "Pod" ||
    pod.metadata?.namespace !== authorization.namespace.name ||
    pod.metadata?.labels?.["job-name"] !== job.metadata.name ||
    owner?.uid !== job.metadata.uid
  ) {
    throw new Error("proof runtime live Pod identity drifted");
  }
  return pod;
}

function defaultWait(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function buildEvidence(input, job, pod) {
  return buildSessionProofRuntimeReadinessEvidence({
    authorization: input.authorization,
    runtimeApplyReceiptSource: input.runtimeApplyReceiptSource,
    runtimeApplyEvidenceSource: input.runtimeApplyEvidenceSource,
    job,
    pod,
    observedAt: input.completedAt,
  });
}

export function waitForSessionProofRuntime(
  input,
  runner = execFileSync,
  wait = defaultWait,
) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "wait-runtime" ||
    authorization.action !== "operator-wait-ready" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not the exact runtime readiness action");
  }
  verifyExecutionBoundary(authorization, input);
  const appliedJobUid = verifySessionProofRuntimeApplyChain(
    authorization,
    input.runtimeApplyReceiptSource ?? "",
    input.runtimeApplyEvidenceSource ?? "",
  );

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  let ready = false;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    const job = readJob(authorization, appliedJobUid, runner);
    const pod = readPod(authorization, job, runner);
    if (pod) {
      try {
        buildEvidence(input, job, pod);
        ready = true;
        break;
      } catch (error) {
        if (!/proof runtime readiness (Job|Pod) drifted/.test(String(error?.message))) {
          throw error;
        }
      }
    }
    if (attempt + 1 < input.maxAttempts) wait(input.pollIntervalMs);
  }
  if (!ready) {
    throw new Error("proof runtime did not become ready within the reviewed polling boundary");
  }

  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalJob = readJob(authorization, appliedJobUid, runner);
  const finalPod = readPod(authorization, finalJob, runner);
  if (!finalPod) throw new Error("proof runtime Pod disappeared before completion");
  const evidence = buildEvidence(input, finalJob, finalPod);
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
