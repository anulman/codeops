import { parseAllDocuments, stringify } from "yaml";
import { renderCodexAuthManifest } from "./codeops-codex-auth-render.mjs";

const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function renderSessionProofCodexAuthManifest(template, input) {
  if (!RUN_ID.test(input.runId ?? "")) throw new Error("proof run ID must be one DNS-safe label");
  const expectedNamespace = `codeops-session-proof-${input.runId}`;
  if (input.namespace !== expectedNamespace || input.namespace.length > 63) {
    throw new Error("proof namespace must be derived exactly from the run ID");
  }

  const base = renderCodexAuthManifest(template, {
    action: input.action,
    agentDigest: input.agentDigest,
  });
  const resources = parseAllDocuments(base).map((document) => document.toJS());
  for (const resource of resources) {
    resource.metadata.namespace = input.namespace;
    resource.metadata.labels = {
      ...(resource.metadata.labels ?? {}),
      "app.kubernetes.io/part-of": "codeops-session-proof",
      "codeops.example/proof-run": input.runId,
    };
    if (resource.kind === "Job") {
      resource.spec.template.metadata.labels["app.kubernetes.io/part-of"] = "codeops-session-proof";
      resource.spec.template.metadata.labels["codeops.example/proof-run"] = input.runId;
    }
  }

  const identities = resources.map((resource) => `${resource.kind}/${resource.metadata.name}`).sort();
  const expected = [
    `Job/codeops-codex-auth-${input.action}`,
    "NetworkPolicy/codeops-codex-auth",
    "PersistentVolumeClaim/codeops-codex-auth",
    "ServiceAccount/codeops-codex-auth",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error("proof Codex auth resource set drifted");
  for (const resource of resources) {
    if (
      resource.metadata.namespace !== input.namespace ||
      resource.metadata.labels["app.kubernetes.io/part-of"] !== "codeops-session-proof" ||
      resource.metadata.labels["codeops.example/proof-run"] !== input.runId
    ) throw new Error("proof Codex auth identity drifted");
  }

  const claim = resources.find((resource) => resource.kind === "PersistentVolumeClaim");
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const job = resources.find((resource) => resource.kind === "Job");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const pod = job.spec.template.spec;
  const container = pod.containers[0];
  if (
    JSON.stringify(claim.spec.accessModes) !== JSON.stringify(["ReadWriteOnce"]) ||
    claim.spec.resources.requests.storage !== "1Gi" ||
    claim.spec.storageClassName !== "csi-cinder-high-speed" ||
    account.automountServiceAccountToken !== false || pod.automountServiceAccountToken !== false ||
    job.spec.backoffLimit !== 0 || job.spec.activeDeadlineSeconds !== 900 ||
    pod.serviceAccountName !== "codeops-codex-auth" || pod.containers.length !== 1 ||
    JSON.stringify(pod.imagePullSecrets) !== JSON.stringify([{ name: "codeops-registry" }]) ||
    pod.volumes.find((volume) => volume.name === "codex-auth")?.persistentVolumeClaim?.claimName !== "codeops-codex-auth" ||
    pod.volumes.some((volume) => volume.secret || volume.hostPath) ||
    container.env.some((entry) => /TOKEN|KEY|REPOSITORY|PLANE|GITHUB|KUBERNETES/.test(entry.name))
  ) throw new Error("proof Codex auth claim, Job, or credential boundary drifted");

  const ports = policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b));
  const publicRule = policy.spec.egress.find((rule) => rule.ports.some((port) => port.port === 443));
  if (
    JSON.stringify(policy.spec.podSelector.matchLabels) !== JSON.stringify({ "app.kubernetes.io/name": "codeops-codex-auth" }) ||
    JSON.stringify(policy.spec.ingress) !== JSON.stringify([]) ||
    JSON.stringify(ports) !== JSON.stringify([53, 53, 443]) ||
    publicRule?.to?.[0]?.ipBlock?.cidr !== "0.0.0.0/0" ||
    !publicRule.to[0].ipBlock.except.includes("10.0.0.0/8") ||
    !publicRule.to[0].ipBlock.except.includes("192.168.0.0/16")
  ) throw new Error("proof Codex auth network boundary drifted");
  const serialized = JSON.stringify(resources);
  if (serialized.includes("CODEX_API_KEY") || serialized.includes("Role") || serialized.includes("hostPath")) {
    throw new Error("proof Codex auth gained authority or injected model credentials");
  }
  return `${resources.map((resource) => stringify(resource)).join("---\n")}`;
}
