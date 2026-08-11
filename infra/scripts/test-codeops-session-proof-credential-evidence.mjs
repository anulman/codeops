import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";

const authorization = {
  planSha256: "1".repeat(64),
  stepId: "issue-runtime-capabilities",
  namespace: { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" },
};
const labels = {
  "app.kubernetes.io/part-of": "codeops-session-proof",
  "codeops.example/credential-scope": "session-video-proof-runtime",
};
const secrets = [
  {
    name: "codeops-registry",
    namespace: authorization.namespace.name,
    uid: "secret-uid-1",
    type: "kubernetes.io/dockerconfigjson",
    dataKeys: [".dockerconfigjson"],
    labels,
  },
  {
    name: "codeops-agent-source-credentials",
    namespace: authorization.namespace.name,
    uid: "secret-uid-2",
    type: "Opaque",
    dataKeys: ["repository-read-token"],
    labels,
  },
];

test("attests only exact runtime credential metadata without values", () => {
  const evidence = buildSessionProofCredentialEvidence({
    authorization,
    secrets,
    observedAt: "2026-08-05T18:50:00Z",
  });
  assert.equal(evidence.result, "verified");
  assert.deepEqual(evidence.credentialInventory.map((secret) => secret.name), [
    "codeops-agent-source-credentials",
    "codeops-registry",
  ]);
  assert.equal(JSON.stringify(evidence).includes("data\""), false);
});

test("rejects missing, extra, wrong-key, wrong-label, or value-bearing Secrets", () => {
  const build = (value) => buildSessionProofCredentialEvidence({
    authorization,
    secrets: value,
    observedAt: "2026-08-05T18:50:00Z",
  });
  assert.throws(() => build(secrets.slice(1)), /inventory drifted/);
  assert.throws(() => build([...secrets, { ...secrets[0], name: "extra" }]), /inventory drifted/);
  assert.throws(() => build([{ ...secrets[0], dataKeys: ["token"] }, secrets[1]]), /metadata drifted/);
  assert.throws(() => build([{ ...secrets[0], labels: {} }, secrets[1]]), /metadata drifted/);
  assert.throws(() => build([{ ...secrets[0], data: { ".dockerconfigjson": "secret" } }, secrets[1]]), /metadata drifted/);
});

test("attests the exact seven broker capabilities as a separate scope", () => {
  const brokerAuthorization = { ...authorization, stepId: "issue-broker-capabilities" };
  const brokerLabels = {
    "app.kubernetes.io/part-of": "codeops-session-proof",
    "codeops.example/credential-scope": "session-video-proof",
  };
  const contracts = {
    "codeops-session-proof-database-owner": ["database", "password", "username"],
    "codeops-session-broker-database": ["database-url"],
    "codeops-session-broker-read-auth": ["token"],
    "codeops-session-broker-write-auth": ["token"],
    "codeops-session-runtime-worker-auth": ["token"],
    "codeops-session-job-initialization-auth": ["token"],
    "codeops-session-runtime-worker-database": ["database-url", "password"],
  };
  const evidence = buildSessionProofCredentialEvidence({
    authorization: brokerAuthorization,
    observedAt: "2026-08-05T18:50:00Z",
    secrets: Object.entries(contracts).map(([name, dataKeys], index) => ({
      name,
      namespace: authorization.namespace.name,
      uid: `broker-secret-uid-${index}`,
      type: "Opaque",
      dataKeys,
      labels: brokerLabels,
    })),
  });
  assert.equal(evidence.credentialInventory.length, 7);
  assert.equal(evidence.stepId, "issue-broker-capabilities");
});
