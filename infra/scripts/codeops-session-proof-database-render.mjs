import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "__CODEOPS_SESSION_PROOF_POSTGRES_DIGEST__";

export function renderSessionProofDatabaseManifest(template, digest) {
  if (!DIGEST.test(digest)) throw new Error("proof database image must use one lowercase SHA-256 digest");
  if (template.split(TOKEN).length !== 2) throw new Error(`expected exactly one ${TOKEN}`);
  const rendered = template.replace(TOKEN, digest);
  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources.map((resource) => `${resource.kind}/${resource.metadata.name}`).sort();
  const expected = [
    "ConfigMap/codeops-session-proof-database-init",
    "Deployment/codeops-session-proof-database",
    "NetworkPolicy/codeops-session-proof-database",
    "Service/codeops-session-proof-database",
    "ServiceAccount/codeops-session-proof-database",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error("proof database resource set drifted");

  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const service = resources.find((resource) => resource.kind === "Service");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const init = resources.find((resource) => resource.kind === "ConfigMap");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const selector = { "app.kubernetes.io/name": "codeops-session-proof-database" };
  if (
    account.automountServiceAccountToken !== false || pod.automountServiceAccountToken !== false ||
    pod.serviceAccountName !== "codeops-session-proof-database" || pod.containers.length !== 1 ||
    container.image !== `ghcr.io/anulman/renoconcierge/renoconcierge-postgres@${digest}` ||
    container.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext?.capabilities?.drop) !== JSON.stringify(["ALL"]) ||
    JSON.stringify(deployment.spec.selector.matchLabels) !== JSON.stringify(selector) ||
    service.spec.type !== "ClusterIP" || JSON.stringify(service.spec.selector) !== JSON.stringify(selector) ||
    JSON.stringify(service.spec.ports) !== JSON.stringify([{ name: "postgres", protocol: "TCP", port: 5432, targetPort: "postgres" }]) ||
    JSON.stringify(policy.spec.podSelector.matchLabels) !== JSON.stringify(selector)
  ) throw new Error("proof database workload identity drifted");

  const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
  if (
    env.POSTGRES_USER_FILE !== "/var/run/secrets/codeops-session-proof-owner/username" ||
    env.POSTGRES_PASSWORD_FILE !== "/var/run/secrets/codeops-session-proof-owner/password" ||
    env.POSTGRES_DB_FILE !== "/var/run/secrets/codeops-session-proof-owner/database" ||
    env.PGDATA !== "/var/lib/postgresql/data/pgdata"
  ) throw new Error("proof database bootstrap identity drifted");

  const volumes = Object.fromEntries(pod.volumes.map((volume) => [volume.name, volume]));
  if (
    volumes.owner?.secret?.secretName !== "codeops-session-proof-database-owner" ||
    volumes["runtime-database"]?.secret?.secretName !== "codeops-session-runtime-worker-database" ||
    volumes.init?.configMap?.name !== "codeops-session-proof-database-init" ||
    !volumes.data?.emptyDir || Object.hasOwn(volumes.data, "persistentVolumeClaim") ||
    volumes.data.emptyDir.sizeLimit !== "2Gi"
  ) throw new Error("proof database disposable storage or credential binding drifted");
  if (!init.data["01-runtime-worker.sh"].includes("CREATE ROLE codeops_session_runtime_worker") ||
      !init.data["01-runtime-worker.sh"].includes("PASSWORD :'worker_password'")) {
    throw new Error("proof database runtime role bootstrap drifted");
  }
  const ingressNames = policy.spec.ingress[0].from.map((source) => source.podSelector.matchLabels["app.kubernetes.io/name"]);
  const serialized = JSON.stringify(resources);
  if (
    JSON.stringify(ingressNames) !== JSON.stringify(["codeops-control-gateway", "codeops-session-runtime-worker"]) ||
    JSON.stringify(policy.spec.ingress[0].ports) !== JSON.stringify([{ protocol: "TCP", port: 5432 }]) ||
    JSON.stringify(policy.spec.egress) !== JSON.stringify([]) ||
    serialized.includes("persistentVolumeClaim") || serialized.includes("hostPath") || serialized.includes("0.0.0.0/0")
  ) throw new Error("proof database persistence or network boundary drifted");
  return rendered;
}
