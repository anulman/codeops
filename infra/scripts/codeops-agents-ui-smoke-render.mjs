import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "CODEOPS_ACCEPTANCE_RUNNER_DIGEST";

export function renderAgentsUiSmokeManifest(template, digest) {
  if (!DIGEST.test(digest)) {
    throw new Error("agents UI smoke image must use a lowercase SHA-256 digest");
  }
  if (template.split(TOKEN).length - 1 !== 1) {
    throw new Error(`expected exactly one ${TOKEN} token`);
  }
  const rendered = template.replace(TOKEN, digest);
  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  if (
    JSON.stringify(identities) !==
    JSON.stringify(
      [
        "Job/codeops-agents-ui-smoke",
        "NetworkPolicy/codeops-agents-ui-smoke",
      ].sort(),
    )
  ) {
    throw new Error("agents UI smoke resource set drifted");
  }
  const job = resources.find((resource) => resource.kind === "Job");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const pod = job.spec.template.spec;
  const container = pod.containers?.[0];
  const serialized = JSON.stringify(job);
  if (
    job.metadata.name !== "codeops-agents-ui-smoke" ||
    job.spec.backoffLimit !== 0 ||
    job.spec.ttlSecondsAfterFinished !== 3600 ||
    job.spec.template.metadata?.labels?.[
      "codeops.renoconcierge.ca/agents-ui-smoke"
    ] !== "true" ||
    pod.serviceAccountName !== "codeops-agents-ui" ||
    pod.automountServiceAccountToken !== false ||
    pod.restartPolicy !== "Never" ||
    pod.containers?.length !== 1 ||
    container.name !== "smoke" ||
    container.image !==
      `ghcr.io/anulman/renoconcierge/renoconcierge-acceptance-runner@${digest}` ||
    JSON.stringify(container.command) !==
      JSON.stringify([
        "node",
        "services/acceptance-runner/src/codeops-agents-ui-smoke.mjs",
      ]) ||
    container.env?.length !== 1 ||
    container.env[0]?.name !== "CODEOPS_AGENTS_UI_BASE_URL" ||
    container.env[0]?.value !== "http://codeops-agents-ui:3000" ||
    container.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container.securityContext?.capabilities?.drop) !==
      JSON.stringify(["ALL"]) ||
    pod.volumes?.length !== 2 ||
    serialized.includes("secretName") ||
    serialized.includes("serviceAccountToken") ||
    rendered.includes(TOKEN)
  ) {
    throw new Error("agents UI smoke runtime boundary drifted");
  }
  const expectedSelector = {
    "codeops.renoconcierge.ca/agents-ui-smoke": "true",
  };
  const expectedEgress = [
    {
      to: [
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "codeops-agents-ui",
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 3000 }],
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
    JSON.stringify(policy.spec.podSelector?.matchLabels) !==
      JSON.stringify(expectedSelector) ||
    JSON.stringify(policy.spec.policyTypes) !==
      JSON.stringify(["Ingress", "Egress"]) ||
    JSON.stringify(policy.spec.ingress) !== JSON.stringify([]) ||
    JSON.stringify(policy.spec.egress) !== JSON.stringify(expectedEgress) ||
    JSON.stringify(resources).includes("0.0.0.0/0")
  ) {
    throw new Error("agents UI smoke network boundary drifted");
  }
  return rendered;
}
