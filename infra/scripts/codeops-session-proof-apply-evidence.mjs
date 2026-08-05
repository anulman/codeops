const UID = /^.{1,256}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const EXPECTED = {
  "start-database": {
    action: "operator-apply",
    artifact: "database",
    resources: [
      { apiVersion: "v1", kind: "ConfigMap", name: "codeops-session-proof-database-init" },
      { apiVersion: "apps/v1", kind: "Deployment", name: "codeops-session-proof-database" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-session-proof-database" },
      { apiVersion: "v1", kind: "Service", name: "codeops-session-proof-database" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-session-proof-database" },
    ],
  },
  "start-gateway": {
    action: "operator-apply",
    artifact: "gateway",
    resources: [
      { apiVersion: "apps/v1", kind: "Deployment", name: "codeops-control-gateway" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-control-gateway" },
      { apiVersion: "v1", kind: "Service", name: "codeops-control-gateway" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-control-gateway" },
    ],
  },
  "grant-receipts": {
    action: "operator-apply",
    artifact: "grants",
    resources: [
      { apiVersion: "batch/v1", kind: "Job", name: "codeops-session-proof-grants" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-session-proof-grants" },
      { apiVersion: "v1", kind: "ConfigMap", name: "codeops-session-proof-grants" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-session-proof-grants" },
    ],
  },
  "codex-login": {
    action: "operator-apply",
    artifact: "codex-login",
    resources: [
      { apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-codex-auth" },
      { apiVersion: "v1", kind: "PersistentVolumeClaim", name: "codeops-codex-auth" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-codex-auth" },
    ],
  },
  "codex-smoke": {
    action: "operator-replace-auth-job",
    artifact: "codex-smoke",
    resources: [
      { apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-smoke" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-codex-auth" },
      { apiVersion: "v1", kind: "PersistentVolumeClaim", name: "codeops-codex-auth" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-codex-auth" },
    ],
  },
  "start-ui": {
    action: "operator-apply",
    artifact: "ui",
    resources: [
      { apiVersion: "apps/v1", kind: "Deployment", name: "codeops-agents-ui" },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name: "codeops-agents-ui" },
      { apiVersion: "v1", kind: "Service", name: "codeops-agents-ui" },
      { apiVersion: "v1", kind: "ServiceAccount", name: "codeops-agents-ui" },
    ],
  },
};

function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());
}

function identity(resource) {
  return `${resource.apiVersion}/${resource.kind}/${resource.name}`;
}

function expectedResources(authorization) {
  if (authorization?.stepId === "start-runtime") {
    const sessionSuffix = authorization.admission?.identity?.sessionSuffix;
    const name = `codeops-session-runtime-${sessionSuffix ?? ""}`;
    if (
      authorization.action !== "operator-apply" ||
      authorization.artifact !== "runtime" ||
      !DNS.test(sessionSuffix ?? "") ||
      name.length > 63
    ) {
      throw new Error("proof step is not a qualified apply action");
    }
    return [
      { apiVersion: "batch/v1", kind: "Job", name },
      { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", name },
      { apiVersion: "v1", kind: "ServiceAccount", name },
    ];
  }
  const contract = EXPECTED[authorization?.stepId];
  if (
    !contract ||
    authorization.action !== contract.action ||
    authorization.artifact !== contract.artifact
  ) {
    throw new Error("proof step is not a qualified apply action");
  }
  return contract.resources;
}

export function verifySessionProofApplyEvidence(authorization, evidence) {
  const expected = expectedResources(authorization);
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "artifactSha256", "resourceInventory",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    evidence.artifactSha256 !== authorization.artifactSha256
  ) {
    throw new Error("proof apply evidence identity drifted");
  }
  const resources = evidence.resourceInventory ?? [];
  if (
    !Array.isArray(resources) ||
    resources.length !== expected.length ||
    new Set(resources.map(identity)).size !== resources.length ||
    JSON.stringify(resources.map(identity).sort()) !==
      JSON.stringify(expected.map(identity).sort())
  ) {
    throw new Error("proof apply evidence resource inventory drifted");
  }
  for (const resource of resources) {
    if (
      !sameKeys(resource, ["apiVersion", "kind", "name", "uid"]) ||
      !UID.test(resource.uid ?? "")
    ) {
      throw new Error("proof apply evidence resource identity drifted");
    }
  }
  return true;
}

export function buildSessionProofApplyEvidence(input) {
  const expected = expectedResources(input.authorization);
  const resources = input.resources ?? [];
  const normalized = resources.map((resource) => ({
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.name,
    uid: resource.uid,
  })).sort((left, right) => identity(left).localeCompare(identity(right)));
  if (
    resources.some((resource) =>
      !sameKeys(resource, ["apiVersion", "kind", "name", "uid"])) ||
    normalized.length !== expected.length ||
    new Set(normalized.map(identity)).size !== normalized.length ||
    JSON.stringify(normalized.map(identity)) !==
      JSON.stringify([...expected].sort((left, right) => identity(left).localeCompare(identity(right))).map(identity))
  ) {
    throw new Error("proof apply resource inventory drifted");
  }
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: input.authorization.planSha256,
    stepId: input.authorization.stepId,
    namespace: input.authorization.namespace,
    artifactSha256: input.authorization.artifactSha256,
    resourceInventory: normalized,
  };
  verifySessionProofApplyEvidence(input.authorization, evidence);
  return evidence;
}

export function sessionProofApplyResourceIdentities(stepId, authorization = null) {
  if (stepId === "start-runtime") {
    return expectedResources({ ...authorization, stepId }).map((resource) => ({ ...resource }));
  }
  return (EXPECTED[stepId]?.resources ?? []).map((resource) => ({ ...resource }));
}
