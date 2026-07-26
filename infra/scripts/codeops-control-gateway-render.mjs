import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/32$/;

export function renderControlGatewayManifest(template, input) {
  for (const key of [
    "controlGatewayDigest",
    "agentDigest",
    "sessionGatewayDigest",
  ]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (!CIDR.test(input.kubernetesApiCidr ?? "")) {
    throw new Error("Kubernetes API CIDR must be one IPv4 /32");
  }
  const replacements = {
    __CODEOPS_CONTROL_GATEWAY_DIGEST__: input.controlGatewayDigest,
    __CODEOPS_AGENT_DIGEST__: input.agentDigest,
    __CODEOPS_SESSION_GATEWAY_DIGEST__: input.sessionGatewayDigest,
    __CODEOPS_KUBERNETES_API_CIDR__: input.kubernetesApiCidr,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (rendered.split(token).length !== 2) {
      throw new Error(`expected exactly one ${token}`);
    }
    rendered = rendered.replace(token, value);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("unresolved control-gateway token");
  }
  const resources = parseAllDocuments(rendered).map((document) =>
    document.toJS(),
  );
  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  const expected = [
    "Deployment/codeops-control-gateway",
    "NetworkPolicy/codeops-control-gateway",
    "PersistentVolumeClaim/codeops-control-gateway-evidence",
    "Role/codeops-control-gateway",
    "RoleBinding/codeops-control-gateway",
    "Service/codeops-control-gateway",
    "ServiceAccount/codeops-control-gateway",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error("control-gateway resource set drifted");
  }
  const role = resources.find((resource) => resource.kind === "Role");
  const verbs = new Set(role.rules.flatMap((rule) => rule.verbs));
  if (verbs.has("patch") || verbs.has("update") || verbs.has("*")) {
    throw new Error("control gateway may not mutate existing resources");
  }
  const deployment = resources.find(
    (resource) => resource.kind === "Deployment",
  );
  const image = deployment.spec.template.spec.containers[0].image;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("control gateway image must be immutable");
  }
  const serialized = JSON.stringify(resources);
  if (serialized.includes("ClusterRole") || serialized.includes("hostPath")) {
    throw new Error("control gateway must remain namespace scoped");
  }
  return rendered;
}
