import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "__CODEOPS_SESSION_PROOF_POSTGRES_DIGEST__";

export function renderSessionProofGrantsManifest(template, digest) {
  if (!DIGEST.test(digest)) throw new Error("proof grant image must use one lowercase SHA-256 digest");
  if (template.split(TOKEN).length !== 2) throw new Error(`expected exactly one ${TOKEN}`);
  const rendered = template.replace(TOKEN, digest);
  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources.map((resource) => `${resource.kind}/${resource.metadata.name}`).sort();
  const expected = [
    "ConfigMap/codeops-session-proof-grants",
    "Job/codeops-session-proof-grants",
    "NetworkPolicy/codeops-session-proof-grants",
    "ServiceAccount/codeops-session-proof-grants",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error("proof grants resource set drifted");
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const job = resources.find((resource) => resource.kind === "Job");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const grants = resources.find((resource) => resource.kind === "ConfigMap").data["grants.sql"];
  const pod = job.spec.template.spec;
  const container = pod.containers[0];
  if (
    account.automountServiceAccountToken !== false || pod.automountServiceAccountToken !== false ||
    pod.serviceAccountName !== "codeops-session-proof-grants" || pod.restartPolicy !== "Never" ||
    job.spec.backoffLimit !== 0 || job.spec.activeDeadlineSeconds !== 300 || pod.containers.length !== 1 ||
    container.image !== `ghcr.io/anulman/renoconcierge/renoconcierge-postgres@${digest}` ||
    container.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext?.capabilities?.drop) !== JSON.stringify(["ALL"])
  ) throw new Error("proof grant Job identity or retry boundary drifted");
  const volumes = Object.fromEntries(pod.volumes.map((volume) => [volume.name, volume]));
  if (
    volumes.owner?.secret?.secretName !== "codeops-session-proof-database-owner" ||
    volumes.grants?.configMap?.name !== "codeops-session-proof-grants" ||
    pod.volumes.filter((volume) => volume.secret).length !== 1
  ) throw new Error("proof grant authority binding drifted");
  for (const required of [
    "REVOKE ALL ON ALL TABLES IN SCHEMA codeops",
    "GRANT SELECT (dispatch_id, dispatch_digest, status, result_json)",
    "GRANT INSERT (dispatch_id, dispatch_digest, status)",
    "GRANT UPDATE (status, result_json, completed_at)",
  ]) if (!grants.includes(required)) throw new Error("proof receipt grant contract drifted");
  const command = container.command.join("\n");
  const ingress = policy.spec.ingress;
  const ports = policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b));
  const serialized = JSON.stringify(resources);
  if (
    !command.includes("attempts=$((attempts + 1))") || !command.includes("[ \"$attempts\" -lt 60 ]") ||
    !command.includes("--set=worker_role=codeops_session_runtime_worker") || command.includes("database-url") ||
    JSON.stringify(ingress) !== JSON.stringify([]) || JSON.stringify(ports) !== JSON.stringify([53, 53, 5432]) ||
    policy.spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"] !== "codeops-session-proof-database" ||
    serialized.includes("persistentVolumeClaim") || serialized.includes("hostPath") || serialized.includes("0.0.0.0/0")
  ) throw new Error("proof grant execution or network boundary drifted");
  return rendered;
}
