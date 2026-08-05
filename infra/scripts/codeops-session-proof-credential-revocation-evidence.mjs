const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const EXPECTED_NAMES = [
  "codeops-session-proof-database-owner",
  "codeops-session-broker-database",
  "codeops-session-broker-read-auth",
  "codeops-session-broker-write-auth",
  "codeops-session-runtime-worker-auth",
  "codeops-session-job-initialization-auth",
  "codeops-session-runtime-worker-database",
  "ghcr-renoconcierge",
  "codeops-agent-source-credentials",
].sort();

function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());
}

function exactNames(names) {
  return (
    Array.isArray(names) &&
    new Set(names).size === names.length &&
    names.every((name) => typeof name === "string") &&
    JSON.stringify([...names].sort()) === JSON.stringify(EXPECTED_NAMES)
  );
}

export function verifySessionProofCredentialRevocationEvidence(authorization, evidence) {
  if (
    authorization?.stepId !== "revoke-capabilities" ||
    authorization.action !== "operator-revoke-exact-secrets"
  ) {
    throw new Error("proof step is not exact credential revocation");
  }
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "absentCredentialNames",
    ]) ||
    evidence.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace) ||
    !exactNames(evidence.absentCredentialNames)
  ) {
    throw new Error("proof credential revocation evidence drifted");
  }
  return true;
}

export function buildSessionProofCredentialRevocationEvidence(input) {
  const evidence = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: input.authorization?.planSha256,
    stepId: input.authorization?.stepId,
    namespace: input.authorization?.namespace,
    absentCredentialNames: [...(input.absentCredentialNames ?? [])].sort(),
  };
  verifySessionProofCredentialRevocationEvidence(input.authorization, evidence);
  return evidence;
}

export function sessionProofCredentialNames() {
  return [...EXPECTED_NAMES];
}
