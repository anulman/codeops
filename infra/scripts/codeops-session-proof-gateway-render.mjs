import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "__CODEOPS_SESSION_CONTROL_GATEWAY_DIGEST__";
const REGISTRY_TOKEN = "__CODEOPS_RUNTIME_PROFILE_REGISTRY_JSON__";

export function renderSessionProofGatewayManifest(template, input) {
  for (const key of ["gatewayDigest", "agentDigest", "workerDigest", "runtimeReleaseDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) throw new Error(`${key} must use one lowercase SHA-256 digest`);
  }
  const digest = input.gatewayDigest;
  if (template.split(TOKEN).length !== 2) throw new Error(`expected exactly one ${TOKEN}`);
  if (template.split(REGISTRY_TOKEN).length !== 2) throw new Error(`expected exactly one ${REGISTRY_TOKEN}`);
  const capabilities = ["acp", "checkpoint", "github-broker", "model-proxy", "work-items-broker"];
  const capabilityDigest = `sha256:${createHash("sha256").update(JSON.stringify(capabilities)).digest("hex")}`;
  const registry = {
    version: "codeops.runtime-profile-registry/v1",
    profiles: [{
      version: "codeops.runtime-profile/v1",
      profileId: "standard-v1",
      releaseDigest: input.runtimeReleaseDigest,
      capabilities,
      capabilityDigest,
      resources: { cpuMillis: 3_000, memoryMiB: 7_168, ephemeralStorageMiB: 5_120 },
      authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
      compatibilityPolicyRevision: "compatible-substitution-v1",
      images: {
        agent: `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
        worker: `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}`,
        sessionGateway: `ghcr.io/anulman/codeops/session-control-gateway@${input.gatewayDigest}`,
      },
    }],
  };
  const rendered = template.replace(TOKEN, digest).replace(REGISTRY_TOKEN, JSON.stringify(registry));
  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources.map((resource) => `${resource.kind}/${resource.metadata.name}`).sort();
  const expected = [
    "Deployment/codeops-control-gateway",
    "ConfigMap/codeops-runtime-profile-registry",
    "NetworkPolicy/codeops-control-gateway",
    "Service/codeops-control-gateway",
    "ServiceAccount/codeops-control-gateway",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error("proof gateway resource set drifted");

  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const runtimeRegistry = resources.find((resource) => resource.kind === "ConfigMap");
  const service = resources.find((resource) => resource.kind === "Service");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const selector = { "app.kubernetes.io/name": "codeops-control-gateway" };
  if (
    account.automountServiceAccountToken !== false ||
    pod.automountServiceAccountToken !== false ||
    pod.serviceAccountName !== "codeops-control-gateway" ||
    pod.containers.length !== 1 ||
    container.image !== `ghcr.io/anulman/codeops/session-control-gateway@${digest}` ||
    runtimeRegistry.immutable !== true ||
    JSON.parse(runtimeRegistry.data["profile-registry.json"]).profiles[0].releaseDigest !== input.runtimeReleaseDigest ||
    container.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext?.capabilities?.drop) !== JSON.stringify(["ALL"]) ||
    JSON.stringify(deployment.spec.selector.matchLabels) !== JSON.stringify(selector) ||
    service.spec.type !== "ClusterIP" ||
    JSON.stringify(service.spec.selector) !== JSON.stringify(selector) ||
    JSON.stringify(policy.spec.podSelector.matchLabels) !== JSON.stringify(selector)
  ) throw new Error("proof gateway workload identity drifted");

  const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
  const expectedEnv = {
    CODEOPS_DATABASE_URL_FILE: "/var/run/secrets/codeops-session-broker/database-url",
    CODEOPS_SESSION_BROKER_READ_TOKEN_FILE: "/var/run/secrets/codeops-session-read/token",
    CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE: "/var/run/secrets/codeops-session-write/token",
    CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE: "/var/run/secrets/codeops-session-runtime-worker/token",
    CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE: "/var/run/secrets/codeops-session-job-initialization/token",
    CODEOPS_SESSION_RUNTIME_WORKER_ID: "acp-worker:video-proof",
    CODEOPS_RUNTIME_PROFILE_REGISTRY_FILE: "/var/run/codeops-runtime/profile-registry.json",
    CODEOPS_RUNTIME_COMPATIBILITY_POLICY_REVISION: "compatible-substitution-v1",
    CODEOPS_HTTP_HOST: "0.0.0.0",
    CODEOPS_HTTP_PORT: "8080",
  };
  if (JSON.stringify(env) !== JSON.stringify(expectedEnv)) throw new Error("proof gateway runtime authority drifted");

  const secrets = pod.volumes.filter((volume) => volume.secret).map((volume) => volume.secret.secretName);
  const expectedSecrets = [
    "codeops-session-broker-database",
    "codeops-session-broker-read-auth",
    "codeops-session-broker-write-auth",
    "codeops-session-runtime-worker-auth",
    "codeops-session-job-initialization-auth",
  ];
  if (JSON.stringify(secrets) !== JSON.stringify(expectedSecrets) || new Set(secrets).size !== secrets.length) {
    throw new Error("proof gateway credentials must remain distinct");
  }
  for (const volume of pod.volumes.filter((entry) => entry.secret)) {
    if (
      volume.secret.defaultMode !== 256 ||
      volume.secret.items?.length !== 1 ||
      volume.secret.items[0].key !== volume.secret.items[0].path
    ) throw new Error("proof gateway secret projection drifted");
  }
  if (
    service.spec.type !== "ClusterIP" ||
    JSON.stringify(service.spec.ports) !== JSON.stringify([
      { name: "http", protocol: "TCP", port: 8080, targetPort: "http" },
    ])
  ) throw new Error("proof gateway service exposure drifted");
  const ingressNames = policy.spec.ingress[0].from.map((source) => source.podSelector.matchLabels["app.kubernetes.io/name"]);
  const egressPorts = policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b));
  const serialized = JSON.stringify(resources);
  if (
    JSON.stringify(ingressNames) !== JSON.stringify(["codeops-agents-ui", "codeops-session-runtime-worker"]) ||
    JSON.stringify(egressPorts) !== JSON.stringify([53, 53, 5432]) ||
    policy.spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"] !== "codeops-session-proof-database" ||
    serialized.includes("ClusterRole") || serialized.includes("0.0.0.0/0") || serialized.includes("codeops-agent-dispatch-auth") ||
    serialized.includes("codeops-repository-head-auth") || serialized.includes("codeops-publication-auth") || serialized.includes("persistentVolumeClaim")
  ) throw new Error("proof gateway network or authority boundary drifted");
  return rendered;
}
