import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofReadinessEvidence,
  verifySessionProofDatabaseApplyChain,
} from "./codeops-session-proof-readiness-evidence.mjs";
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
const MAX_ATTEMPTS = 120;
const MAX_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 2 * 60 * 1000;

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
    throw new Error("proof database readiness polling boundary drifted");
  }
}

function readDeployment(authorization, appliedDeploymentUid, runner) {
  const source = run([
    "-n", authorization.namespace.name,
    "get", "deployment.apps", "codeops-session-proof-database",
    "-o", "json",
    "--request-timeout=15s",
  ], runner);
  const deployment = parseJson(source, "proof database Deployment");
  if (
    deployment?.apiVersion !== "apps/v1" ||
    deployment.kind !== "Deployment" ||
    deployment.metadata?.name !== "codeops-session-proof-database" ||
    deployment.metadata?.namespace !== authorization.namespace.name ||
    deployment.metadata?.uid !== appliedDeploymentUid ||
    deployment.metadata?.generation !== 1
  ) {
    throw new Error("proof database live Deployment identity drifted");
  }
  return deployment;
}

function defaultWait(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function buildEvidence(input, deployment) {
  return buildSessionProofReadinessEvidence({
    authorization: input.authorization,
    databaseApplyReceiptSource: input.databaseApplyReceiptSource,
    databaseApplyEvidenceSource: input.databaseApplyEvidenceSource,
    deployment,
    observedAt: input.completedAt,
  });
}

export function waitForSessionProofDatabase(
  input,
  runner = execFileSync,
  wait = defaultWait,
) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "wait-database" ||
    authorization.action !== "operator-wait-ready" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not the exact database readiness action");
  }
  verifyExecutionBoundary(authorization, input);
  const appliedDeploymentUid = verifySessionProofDatabaseApplyChain(
    authorization,
    input.databaseApplyReceiptSource ?? "",
    input.databaseApplyEvidenceSource ?? "",
  );

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  let readyDeployment = null;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    const deployment = readDeployment(authorization, appliedDeploymentUid, runner);
    try {
      buildEvidence(input, deployment);
      readyDeployment = deployment;
      break;
    } catch (error) {
      if (!String(error?.message).includes("readiness deployment drifted")) throw error;
    }
    if (attempt + 1 < input.maxAttempts) wait(input.pollIntervalMs);
  }
  if (!readyDeployment) {
    throw new Error("proof database did not become ready within the reviewed polling boundary");
  }

  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalDeployment = readDeployment(authorization, appliedDeploymentUid, runner);
  const evidence = buildEvidence(input, finalDeployment);
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
