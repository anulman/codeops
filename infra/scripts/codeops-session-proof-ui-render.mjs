import { parseAllDocuments, stringify } from "yaml";
import { renderAgentsUiManifest } from "./codeops-agents-ui-render.mjs";

const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function renderSessionProofUiManifest(template, input) {
  if (!RUN_ID.test(input.runId ?? "")) {
    throw new Error("proof run ID must be one DNS-safe label");
  }
  const expectedNamespace = `codeops-session-proof-${input.runId}`;
  if (input.namespace !== expectedNamespace || input.namespace.length > 63) {
    throw new Error("proof namespace must be derived exactly from the run ID");
  }

  const base = renderAgentsUiManifest(template, input.agentsUiDigest);
  const resources = parseAllDocuments(base).map((document) => document.toJS());
  for (const resource of resources) {
    resource.metadata.namespace = input.namespace;
    resource.metadata.labels = {
      ...(resource.metadata.labels ?? {}),
      "app.kubernetes.io/part-of": "codeops-session-proof",
      "codeops.example/proof-run": input.runId,
    };
  }

  const deployment = resources.find((resource) => resource.kind === "Deployment");
  deployment.spec.template.metadata.labels["app.kubernetes.io/part-of"] =
    "codeops-session-proof";
  deployment.spec.template.metadata.labels["codeops.example/proof-run"] =
    input.runId;

  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  policy.spec.ingress = [];

  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  const expected = [
    "Deployment/codeops-agents-ui",
    "NetworkPolicy/codeops-agents-ui",
    "Service/codeops-agents-ui",
    "ServiceAccount/codeops-agents-ui",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error("proof UI resource set drifted");
  }
  for (const resource of resources) {
    if (
      resource.metadata.namespace !== input.namespace ||
      resource.metadata.labels["app.kubernetes.io/part-of"] !==
        "codeops-session-proof" ||
      resource.metadata.labels["codeops.example/proof-run"] !==
        input.runId
    ) {
      throw new Error("proof UI identity drifted");
    }
  }

  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const env = Object.fromEntries(
    container.env.map((entry) => [entry.name, entry.value]),
  );
  const secretNames = pod.volumes
    .filter((volume) => volume.secret)
    .map((volume) => volume.secret.secretName);
  if (
    pod.automountServiceAccountToken !== false ||
    pod.containers.length !== 1 ||
    env.CODEOPS_SESSION_BROKER_URL !== "http://codeops-control-gateway:8080" ||
    JSON.stringify(secretNames) !==
      JSON.stringify([
        "codeops-session-broker-read-auth",
        "codeops-session-broker-write-auth",
      ]) ||
    container.securityContext.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext.capabilities?.drop) !==
      JSON.stringify(["ALL"])
  ) {
    throw new Error("proof UI runtime or credential boundary drifted");
  }

  const service = resources.find((resource) => resource.kind === "Service");
  const egressPorts = policy.spec.egress
    .flatMap((rule) => rule.ports.map((port) => port.port))
    .sort((a, b) => Number(a) - Number(b));
  const serialized = JSON.stringify(resources);
  if (
    service.spec.type !== "ClusterIP" ||
    JSON.stringify(policy.spec.ingress) !== JSON.stringify([]) ||
    JSON.stringify(egressPorts) !== JSON.stringify([53, 53, 8080]) ||
    policy.spec.egress[0].to[0].podSelector.matchLabels[
      "app.kubernetes.io/name"
    ] !== "codeops-control-gateway" ||
    resources.some((resource) => resource.kind === "Ingress") ||
    serialized.includes("0.0.0.0/0") ||
    serialized.includes("codeops-session-broker-database") ||
    serialized.includes("codeops-agent-dispatch-auth") ||
    serialized.includes("Role") ||
    serialized.includes("hostPath")
  ) {
    throw new Error("proof UI exposure or authority boundary drifted");
  }

  return resources.map((resource) => stringify(resource)).join("---\n");
}
