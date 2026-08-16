const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "CODEOPS_AGENTS_UI_DIGEST";

export function renderAgentsUiManifest(template, digest) {
  if (!DIGEST.test(digest)) {
    throw new Error("agents UI image must use a lowercase SHA-256 digest");
  }
  const occurrences = template.split(TOKEN).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one ${TOKEN} token, found ${occurrences}`);
  }
  const rendered = template.replace(TOKEN, digest);
  const images = [...rendered.matchAll(/^\s*image:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (
    rendered.includes(TOKEN) ||
    images.length !== 1 ||
    images[0] !==
      `ghcr.io/anulman/codeops/agents-ui@${digest}`
  ) {
    throw new Error("mutable or unresolved agents UI image survived rendering");
  }
  const resources = parseAllDocuments(rendered).map((document) =>
    document.toJS(),
  );
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
    throw new Error("agents UI resource set drifted");
  }
  const serviceAccount = resources.find(
    (resource) => resource.kind === "ServiceAccount",
  );
  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const service = resources.find((resource) => resource.kind === "Service");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const pod = deployment.spec.template.spec;
  const workloadSelector = {
    "app.kubernetes.io/name": "codeops-agents-ui",
  };
  if (
    serviceAccount.automountServiceAccountToken !== false ||
    pod.automountServiceAccountToken !== false ||
    pod.serviceAccountName !== "codeops-agents-ui" ||
    JSON.stringify(deployment.spec.selector?.matchLabels) !==
      JSON.stringify(workloadSelector) ||
    deployment.spec.template.metadata?.labels?.["app.kubernetes.io/name"] !==
      "codeops-agents-ui" ||
    service.spec.type !== "ClusterIP" ||
    JSON.stringify(service.spec.selector) !== JSON.stringify(workloadSelector) ||
    JSON.stringify(service.spec.ports) !==
      JSON.stringify([
        { name: "http", protocol: "TCP", port: 3000, targetPort: "http" },
      ]) ||
    JSON.stringify(policy.spec.podSelector?.matchLabels) !==
      JSON.stringify(workloadSelector)
  ) {
    throw new Error("agents UI workload or service identity drifted");
  }
  const read = pod.volumes.find(
    (volume) => volume.name === "session-broker-read-auth",
  );
  const write = pod.volumes.find(
    (volume) => volume.name === "session-broker-write-auth",
  );
  if (
    pod.volumes.length !== 3 ||
    read?.secret?.secretName !== "codeops-session-broker-read-auth" ||
    write?.secret?.secretName !== "codeops-session-broker-write-auth" ||
    read.secret.secretName === write.secret.secretName ||
    read.secret.items?.map((item) => `${item.key}:${item.path}`).join(",") !==
      "token:token" ||
    write.secret.items?.map((item) => `${item.key}:${item.path}`).join(",") !==
      "token:token"
  ) {
    throw new Error("agents UI session auth binding drifted");
  }
  const container = pod.containers[0];
  const env = Object.fromEntries(
    container.env.map((entry) => [entry.name, entry.value]),
  );
  if (
    pod.containers.length !== 1 ||
    container.name !== "agents-ui" ||
    JSON.stringify(container.ports) !==
      JSON.stringify([{ name: "http", containerPort: 3000 }]) ||
    env.CODEOPS_SESSION_BROKER_URL !== "http://codeops-control-gateway:8080" ||
    env.CODEOPS_SESSION_BROKER_READ_TOKEN_FILE !==
      "/var/run/secrets/codeops-session-read/token" ||
    env.CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE !==
      "/var/run/secrets/codeops-session-write/token" ||
    env.CODEOPS_SESSION_OWNER_FIXED_PRINCIPAL !== "codeops:agents-ui" ||
    env.CODEOPS_SESSION_OWNER_PRINCIPAL_HEADER !== undefined ||
    container.securityContext.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext.capabilities?.drop) !==
      JSON.stringify(["ALL"])
  ) {
    throw new Error("agents UI runtime boundary drifted");
  }
  const serialized = JSON.stringify(resources);
  const expectedIngress = [
    {
      from: [
        {
          namespaceSelector: {
            matchLabels: {
              "kubernetes.io/metadata.name": "ingress-nginx",
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 3000 }],
    },
  ];
  const expectedEgress = [
    {
      to: [
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "codeops-control-gateway",
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: {
              "kubernetes.io/metadata.name": "kube-system",
            },
          },
        },
      ],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
  ];
  if (
    serialized.includes("0.0.0.0/0") ||
    serialized.includes("codeops-agent-dispatch-auth") ||
    serialized.includes("codeops-session-broker-database") ||
    JSON.stringify(policy.spec.ingress) !== JSON.stringify(expectedIngress) ||
    JSON.stringify(policy.spec.egress) !== JSON.stringify(expectedEgress)
  ) {
    throw new Error("agents UI authority or network boundary drifted");
  }
  return rendered;
}
import { parseAllDocuments } from "yaml";
