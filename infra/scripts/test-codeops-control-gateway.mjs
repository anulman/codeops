import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderControlGatewayManifest } from "./codeops-control-gateway-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/control-gateway-template.yaml",
    import.meta.url,
  ),
  "utf8",
);
const modelProxyLedgerGrants = await readFile(
  new URL(
    "../k8s/codeops/trial0/model-proxy-ledger-grants.sql",
    import.meta.url,
  ),
  "utf8",
);
const input = {
  controlGatewayDigest: `sha256:${"a".repeat(64)}`,
  modelProxyDigest: `sha256:${"d".repeat(64)}`,
  agentDigest: `sha256:${"b".repeat(64)}`,
  workerDigest: `sha256:${"e".repeat(64)}`,
  sessionGatewayDigest: `sha256:${"c".repeat(64)}`,
  runtimeReleaseDigest: `sha256:${"f".repeat(64)}`,
  kubernetesApiCidr: "10.3.0.1/32",
};

function resources() {
  return parseAllDocuments(renderControlGatewayManifest(template, input)).map(
    (document) => document.toJS(),
  );
}

test("renders one namespace-scoped authenticated gateway", () => {
  const values = resources();
  const deployment = values.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "codeops-control-gateway",
  );
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(
    deployment.spec.template.spec.serviceAccountName,
    "codeops-control-gateway",
  );
  assert.equal(
    deployment.spec.template.spec.containers[0].image,
    `ghcr.io/anulman/codeops/control-gateway@${input.controlGatewayDigest}`,
  );
  const profileRegistry = values.find(
    (resource) => resource.kind === "ConfigMap" &&
      resource.metadata.name === "codeops-runtime-profile-registry",
  );
  const profile = JSON.parse(profileRegistry.data["profile-registry.json"]).profiles[0];
  assert.equal(profileRegistry.immutable, true);
  assert.equal(profile.releaseDigest, input.runtimeReleaseDigest);
  assert.equal(profile.images.agent, `ghcr.io/anulman/codeops/agent@${input.agentDigest}`);
  assert.equal(profile.images.worker, `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}`);
  assert.equal(profile.images.sessionGateway, `ghcr.io/anulman/codeops/session-gateway@${input.sessionGatewayDigest}`);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_RUNTIME_PROFILE_REGISTRY_FILE",
    ).value,
    "/var/run/codeops-runtime-profile/profile-registry.json",
  );
  assert.equal(
    JSON.stringify(deployment).includes("codeops-agent-source-credentials"),
    true,
  );
  assert.equal(
    JSON.stringify(deployment).includes("codeops-repository-head-auth"),
    true,
  );
  assert.notEqual(
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "dispatch-auth",
    ).secret.secretName,
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "repository-head-auth",
    ).secret.secretName,
  );
  assert.equal(
    JSON.stringify(deployment).includes("CODEOPS_MODEL_API_KEY_FILE"),
    false,
  );
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_MODEL_PROXY_ORIGIN",
    ).value,
    "http://codeops-model-proxy:8080",
  );
  const proxy = values.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "codeops-model-proxy",
  );
  assert.equal(
    proxy.spec.template.spec.containers[0].image,
    `ghcr.io/anulman/codeops/model-proxy@${input.modelProxyDigest}`,
  );
  assert.equal(proxy.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    proxy.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "OPENAI_API_KEY",
    ).valueFrom.secretKeyRef.name,
    "codeops-model-proxy-credentials",
  );
  assert.equal(
    proxy.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_MODEL_PROXY_DATABASE_URL",
    ).valueFrom.secretKeyRef.key,
    "database-url",
  );
  const proxyPolicy = values.find(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.name === "codeops-model-proxy",
  );
  assert.deepEqual(
    proxyPolicy.spec.ingress[0].from[0].podSelector.matchExpressions[0].values,
    ["codeops-agent", "codeops-session-runtime-worker"],
  );
  assert.equal(JSON.stringify(proxyPolicy.spec.egress).includes("codeops-postgres-cnpg-pgbouncer"), true);
  const databaseVolume = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-database",
  );
  assert.equal(
    databaseVolume.secret.secretName,
    "codeops-session-broker-database",
  );
  assert.deepEqual(databaseVolume.secret.items, [
    { key: "database-url", path: "database-url" },
  ]);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_DATABASE_URL_FILE",
    ).value,
    "/var/run/secrets/codeops-session-broker/database-url",
  );
  const readAuthVolume = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-read-auth",
  );
  assert.equal(
    readAuthVolume.secret.secretName,
    "codeops-session-broker-read-auth",
  );
  assert.deepEqual(readAuthVolume.secret.items, [
    { key: "token", path: "token" },
  ]);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_SESSION_BROKER_READ_TOKEN_FILE",
    ).value,
    "/var/run/secrets/codeops-session-read/token",
  );
  assert.notEqual(
    readAuthVolume.secret.secretName,
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "dispatch-auth",
    ).secret.secretName,
  );
  const writeAuthVolume = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-write-auth",
  );
  assert.equal(
    writeAuthVolume.secret.secretName,
    "codeops-session-broker-write-auth",
  );
  assert.deepEqual(writeAuthVolume.secret.items, [
    { key: "token", path: "token" },
  ]);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE",
    ).value,
    "/var/run/secrets/codeops-session-write/token",
  );
  assert.notEqual(
    writeAuthVolume.secret.secretName,
    readAuthVolume.secret.secretName,
  );
  const workerAuthVolume = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-runtime-worker-auth",
  );
  assert.equal(
    workerAuthVolume.secret.secretName,
    "codeops-session-runtime-worker-auth",
  );
  assert.deepEqual(workerAuthVolume.secret.items, [
    { key: "token", path: "token" },
  ]);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE",
    ).value,
    "/var/run/secrets/codeops-session-runtime-worker/token",
  );
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "CODEOPS_SESSION_RUNTIME_WORKER_ID",
    ).value,
    "acp-worker:primary",
  );
  assert.notEqual(
    workerAuthVolume.secret.secretName,
    readAuthVolume.secret.secretName,
  );
  assert.notEqual(
    workerAuthVolume.secret.secretName,
    writeAuthVolume.secret.secretName,
  );
  const initializationAuthVolume = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-job-initialization-auth",
  );
  assert.equal(
    initializationAuthVolume.secret.secretName,
    "codeops-session-job-initialization-auth",
  );
  assert.deepEqual(initializationAuthVolume.secret.items, [
    { key: "token", path: "token" },
  ]);
  assert.equal(
    deployment.spec.template.spec.containers[0].env.find(
      (entry) =>
        entry.name === "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE",
    ).value,
    "/var/run/secrets/codeops-session-job-initialization/token",
  );
  assert.notEqual(
    initializationAuthVolume.secret.secretName,
    workerAuthVolume.secret.secretName,
  );
});

test("grants the static model proxy only fixed ledger function authority", () => {
  assert.match(modelProxyLedgerGrants, /ALTER ROLE :"proxy_role"/);
  assert.match(modelProxyLedgerGrants, /REVOKE ALL ON ALL TABLES IN SCHEMA codeops/);
  assert.match(modelProxyLedgerGrants, /reserve_session_model_budget/);
  assert.match(modelProxyLedgerGrants, /settle_session_model_budget/);
  assert.match(
    modelProxyLedgerGrants,
    /charge_stale_session_model_budget_reservations/,
  );
  assert.doesNotMatch(
    modelProxyLedgerGrants,
    /GRANT (SELECT|INSERT|UPDATE|DELETE)/,
  );
  assert.match(modelProxyLedgerGrants, /^\\set ON_ERROR_STOP on[\s\S]*COMMIT;\n$/);
});

test("grants only fixed run-resource and log operations", () => {
  const role = resources().find((resource) => resource.kind === "Role");
  assert.deepEqual(
    [...new Set(role.rules.flatMap((rule) => rule.verbs))].sort(),
    ["create", "delete", "get", "list"],
  );
  assert.equal(
    role.rules.some((rule) => rule.resources.includes("deployments")),
    false,
  );
  const secretRule = role.rules.find((rule) =>
    rule.resources.includes("secrets"),
  );
  assert.deepEqual(secretRule.verbs, ["create", "delete"]);
});

test("admits only exact control-plane and session-runtime callers", () => {
  const policy = resources().find(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.name === "codeops-control-gateway",
  );
  assert.equal(
    policy.spec.ingress[0].from[0].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-orchestrator",
  );
  assert.equal(
    policy.spec.ingress[0].from[1].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-plane-controller",
  );
  assert.equal(
    policy.spec.ingress[0].from[2].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-agents-ui",
  );
  assert.equal(
    policy.spec.ingress[0].from[3].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ],
    "codeops-session-runtime-worker",
  );
  assert.equal(policy.spec.ingress[0].from.length, 4);
  assert.equal(policy.spec.egress[0].to[0].ipBlock.cidr, "10.3.0.1/32");
  assert.deepEqual(policy.spec.egress[0].ports, [
    { protocol: "TCP", port: 443 },
    { protocol: "TCP", port: 6443 },
  ]);
  const databaseEgress = policy.spec.egress.find(
    (entry) =>
      entry.to?.[0]?.podSelector?.matchLabels?.["cnpg.io/poolerName"] ===
      "codeops-postgres-cnpg-pgbouncer",
  );
  assert.deepEqual(databaseEgress.ports, [{ protocol: "TCP", port: 5432 }]);
});

test("fails closed on mutable images, broad API CIDRs, or template drift", () => {
  for (const patch of [
    { controlGatewayDigest: "latest" },
    { modelProxyDigest: "latest" },
    { agentDigest: `sha256:${"B".repeat(64)}` },
    { workerDigest: "latest" },
    { runtimeReleaseDigest: `sha256:${"F".repeat(64)}` },
    { kubernetesApiCidr: "10.3.0.0/24" },
  ]) {
    assert.throws(() =>
      renderControlGatewayManifest(template, { ...input, ...patch }),
    );
  }
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace("kind: Role", "kind: ClusterRole"),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "secretName: codeops-session-broker-database",
        "secretName: codeops-postgres",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "secretName: codeops-session-broker-write-auth",
        "secretName: codeops-session-broker-read-auth",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "secretName: codeops-session-broker-read-auth",
        "secretName: codeops-agent-dispatch-auth",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "secretName: codeops-session-runtime-worker-auth",
        "secretName: codeops-session-broker-write-auth",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "secretName: codeops-session-job-initialization-auth",
        "secretName: codeops-session-runtime-worker-auth",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "app.kubernetes.io/name: codeops-session-runtime-worker",
        "app.kubernetes.io/name: untrusted-runtime",
      ),
      input,
    ),
  );
  assert.throws(() =>
    renderControlGatewayManifest(
      template.replace(
        "cnpg.io/poolerName: codeops-postgres-cnpg-pgbouncer",
        "ipBlock:\n            cidr: 10.0.0.0/8",
      ),
      input,
    ),
  );
});
