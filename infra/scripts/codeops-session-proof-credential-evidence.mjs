const UID = /^.{1,256}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const EXPECTED = {
  "issue-broker-capabilities": {
    scope: "session-video-proof",
    secrets: {
      "codeops-session-proof-database-owner": {
        type: "Opaque",
        keys: ["database", "password", "username"],
      },
      "codeops-session-broker-database": {
        type: "Opaque",
        keys: ["database-url"],
      },
      "codeops-session-broker-read-auth": { type: "Opaque", keys: ["token"] },
      "codeops-session-broker-write-auth": { type: "Opaque", keys: ["token"] },
      "codeops-session-runtime-worker-auth": { type: "Opaque", keys: ["token"] },
      "codeops-session-job-initialization-auth": { type: "Opaque", keys: ["token"] },
      "codeops-session-runtime-worker-database": {
        type: "Opaque",
        keys: ["database-url", "password"],
      },
    },
  },
  "issue-runtime-capabilities": {
    scope: "session-video-proof-runtime",
    secrets: {
      "codeops-registry": {
        type: "kubernetes.io/dockerconfigjson",
        keys: [".dockerconfigjson"],
      },
      "codeops-agent-source-credentials": {
        type: "Opaque",
        keys: ["repository-read-token"],
      },
    },
  },
};

function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());
}

export function verifySessionProofCredentialEvidence(authorization, evidence) {
  const expected = EXPECTED[authorization?.stepId];
  if (!expected) throw new Error("proof step is not a credential-issuance action");
  if (
    !sameKeys(evidence, [
      "apiVersion", "result", "observedAt", "planSha256", "stepId", "namespace",
      "credentialInventory",
    ]) ||
    evidence.apiVersion !== "codeops.example/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    !RFC3339.test(evidence.observedAt ?? "") ||
    JSON.stringify(evidence.namespace) !== JSON.stringify(authorization.namespace)
  ) {
    throw new Error("proof credential evidence identity drifted");
  }
  const expectedNames = Object.keys(expected.secrets).sort();
  const inventory = evidence.credentialInventory ?? [];
  if (
    !Array.isArray(inventory) ||
    JSON.stringify(inventory.map((secret) => secret.name).sort()) !== JSON.stringify(expectedNames)
  ) {
    throw new Error("proof credential evidence inventory drifted");
  }
  for (const secret of inventory) {
    const contract = expected.secrets[secret.name];
    if (
      !sameKeys(secret, ["name", "namespace", "uid", "type", "dataKeys", "labels"]) ||
      secret.namespace !== authorization.namespace.name ||
      !UID.test(secret.uid ?? "") ||
      secret.type !== contract.type ||
      JSON.stringify([...(secret.dataKeys ?? [])].sort()) !== JSON.stringify(contract.keys) ||
      !sameKeys(secret.labels, [
        "app.kubernetes.io/part-of",
        "codeops.example/credential-scope",
      ]) ||
      secret.labels["app.kubernetes.io/part-of"] !== "codeops-session-proof" ||
      secret.labels["codeops.example/credential-scope"] !== expected.scope
    ) {
      throw new Error("proof credential evidence metadata drifted");
    }
  }
  return true;
}

export function buildSessionProofCredentialEvidence(input) {
  const expected = EXPECTED[input.authorization?.stepId];
  if (!expected) throw new Error("proof step is not a credential-issuance action");
  const secrets = input.secrets ?? [];
  const expectedNames = Object.keys(expected.secrets).sort();
  const actualNames = secrets.map((secret) => secret.name).sort();
  if (
    new Set(actualNames).size !== actualNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error("proof credential Secret inventory drifted");
  }
  const normalized = secrets.map((secret) => {
    const contract = expected.secrets[secret.name];
    if (
      secret.namespace !== input.authorization.namespace?.name ||
      !UID.test(secret.uid ?? "") ||
      secret.type !== contract.type ||
      JSON.stringify([...(secret.dataKeys ?? [])].sort()) !== JSON.stringify(contract.keys) ||
      secret.labels?.["app.kubernetes.io/part-of"] !== "codeops-session-proof" ||
      secret.labels?.["codeops.example/credential-scope"] !== expected.scope ||
      Object.hasOwn(secret, "data") ||
      Object.hasOwn(secret, "stringData")
    ) {
      throw new Error("proof credential Secret metadata drifted");
    }
    return {
      name: secret.name,
      namespace: secret.namespace,
      uid: secret.uid,
      type: secret.type,
      dataKeys: [...secret.dataKeys].sort(),
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.example/credential-scope": expected.scope,
      },
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const evidence = {
    apiVersion: "codeops.example/session-proof-step-evidence/v1",
    result: "verified",
    observedAt: input.observedAt,
    planSha256: input.authorization.planSha256,
    stepId: input.authorization.stepId,
    namespace: input.authorization.namespace,
    credentialInventory: normalized,
  };
  verifySessionProofCredentialEvidence(input.authorization, evidence);
  return evidence;
}
