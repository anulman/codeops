import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
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
const RESOURCE_TYPES = new Map([
  ["apps/v1/Deployment", "deployment.apps"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/Service", "service"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function run(args, runner, options = {}) {
  return runner("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 45_000,
    ...options,
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

function verifyExecutionTimes(authorization, startedAt, completedAt) {
  if (
    !RFC3339.test(startedAt ?? "") ||
    !RFC3339.test(completedAt ?? "") ||
    Date.parse(startedAt) < Date.parse(authorization.authorizedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw new Error("proof gateway apply timestamps drifted");
  }
}

function readResource(namespace, expected, runner) {
  const resourceType = RESOURCE_TYPES.get(`${expected.apiVersion}/${expected.kind}`);
  if (!resourceType) throw new Error("proof gateway resource type is not admitted");
  const source = run([
    "-n", namespace,
    "get", resourceType, expected.name,
    "-o", "json",
    "--ignore-not-found",
    "--request-timeout=15s",
  ], runner).trim();
  if (!source) return null;
  const resource = parseJson(source, `proof gateway ${expected.kind}`);
  if (
    resource.apiVersion !== expected.apiVersion ||
    resource.kind !== expected.kind ||
    resource.metadata?.name !== expected.name ||
    resource.metadata?.namespace !== namespace ||
    typeof resource.metadata?.uid !== "string" ||
    resource.metadata.uid.length === 0
  ) {
    throw new Error("proof gateway live resource identity drifted");
  }
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
  };
}

function readInventory(authorization, runner) {
  return sessionProofApplyResourceIdentities(authorization.stepId).map((expected) =>
    readResource(authorization.namespace.name, expected, runner));
}

export function applySessionProofGateway(input, runner = execFileSync) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "start-gateway" ||
    authorization.action !== "operator-apply" ||
    authorization.artifact !== "gateway"
  ) {
    throw new Error("proof step is not the exact gateway apply action");
  }
  verifyExecutionTimes(authorization, input.startedAt, input.completedAt);
  const manifestSource = input.manifestSource ?? "";
  const manifestSha256 = createHash("sha256").update(manifestSource).digest("hex");
  if (manifestSha256 !== authorization.artifactSha256) {
    throw new Error("reviewed proof gateway manifest digest drifted");
  }

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  const existing = readInventory(authorization, runner).filter(Boolean);
  if (existing.length > 0) {
    throw new Error(`proof gateway resources already exist: ${existing.map((value) => value.name).join(", ")}`);
  }

  run([
    "-n", authorization.namespace.name,
    "create", "--filename", "-",
    "--request-timeout=30s",
  ], runner, { input: manifestSource });

  const resources = readInventory(authorization, runner);
  if (resources.some((resource) => resource === null)) {
    throw new Error("proof gateway package creation was incomplete");
  }
  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalResources = readInventory(authorization, runner);
  if (
    finalResources.some((resource) => resource === null) ||
    JSON.stringify(finalResources) !== JSON.stringify(resources)
  ) {
    throw new Error("proof gateway resource identity drifted after final identity check");
  }
  const evidence = buildSessionProofApplyEvidence({
    authorization,
    observedAt: input.completedAt,
    resources: finalResources,
  });
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
