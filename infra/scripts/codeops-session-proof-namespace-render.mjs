import { parseAllDocuments } from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function renderSessionProofNamespaceManifest(template, input) {
  if (!RUN_ID.test(input.runId ?? "")) throw new Error("proof run ID must be one DNS-safe label");
  const expectedNamespace = `codeops-session-proof-${input.runId}`;
  if (input.namespace !== expectedNamespace || input.namespace.length > 63) {
    throw new Error("proof namespace must be derived exactly from the run ID");
  }
  if (!SHA.test(input.baseSha ?? "")) throw new Error("proof base SHA must contain 40 lowercase hex characters");

  const tokens = {
    __CODEOPS_SESSION_PROOF_NAMESPACE__: input.namespace,
    __CODEOPS_RUN_ID__: input.runId,
    __CODEOPS_BASE_SHA__: input.baseSha,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(tokens)) {
    if (!rendered.includes(token)) throw new Error(`expected ${token}`);
    rendered = rendered.replaceAll(token, value);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) throw new Error("unresolved proof namespace token");

  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources.map((resource) => `${resource.kind}/${resource.metadata.name}`).sort();
  const expected = [
    `Namespace/${input.namespace}`,
    "LimitRange/codeops-session-proof",
    "ResourceQuota/codeops-session-proof",
    "NetworkPolicy/default-deny",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) throw new Error("proof namespace resource set drifted");

  const namespace = resources.find((resource) => resource.kind === "Namespace");
  const limitRange = resources.find((resource) => resource.kind === "LimitRange");
  const quota = resources.find((resource) => resource.kind === "ResourceQuota");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  for (const resource of resources.filter((resource) => resource.kind !== "Namespace")) {
    if (resource.metadata.namespace !== input.namespace) throw new Error("proof resource namespace drifted");
  }
  if (
    namespace.metadata.labels["app.kubernetes.io/part-of"] !== "codeops-session-proof" ||
    namespace.metadata.labels["codeops.renoconcierge.ca/proof-run"] !== input.runId ||
    namespace.metadata.labels["codeops.renoconcierge.ca/base-sha"] !== input.baseSha ||
    namespace.metadata.labels["pod-security.kubernetes.io/enforce"] !== "restricted" ||
    namespace.metadata.labels["pod-security.kubernetes.io/audit"] !== "restricted" ||
    namespace.metadata.labels["pod-security.kubernetes.io/warn"] !== "restricted"
  ) throw new Error("proof namespace identity or pod-security boundary drifted");

  const containerLimits = limitRange.spec.limits.find((entry) => entry.type === "Container");
  const pvcLimits = limitRange.spec.limits.find((entry) => entry.type === "PersistentVolumeClaim");
  const hard = quota.spec.hard;
  if (
    containerLimits.max.cpu !== "4" || containerLimits.max.memory !== "8Gi" ||
    pvcLimits.max.storage !== "2Gi" || hard.pods !== "12" ||
    hard["count/deployments.apps"] !== "4" || hard["count/jobs.batch"] !== "8" ||
    hard["count/secrets"] !== "16" || hard["count/persistentvolumeclaims"] !== "1" ||
    hard["requests.cpu"] !== "6" || hard["requests.memory"] !== "12Gi" ||
    hard["limits.cpu"] !== "12" || hard["limits.memory"] !== "24Gi"
  ) throw new Error("proof namespace resource bounds drifted");
  if (
    JSON.stringify(policy.spec.podSelector) !== JSON.stringify({}) ||
    JSON.stringify(policy.spec.policyTypes) !== JSON.stringify(["Ingress", "Egress"]) ||
    JSON.stringify(policy.spec.ingress) !== JSON.stringify([]) ||
    JSON.stringify(policy.spec.egress) !== JSON.stringify([])
  ) throw new Error("proof namespace default network isolation drifted");
  const serialized = JSON.stringify(resources);
  if (serialized.includes("Role") || serialized.includes("0.0.0.0/0") || serialized.includes("hostPath")) {
    throw new Error("proof namespace gained authority or broad exposure");
  }
  return rendered;
}
