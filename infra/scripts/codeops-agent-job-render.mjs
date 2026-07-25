import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REPOSITORY =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

const TOKENS = {
  CODEOPS_AGENT_DIGEST: "agentDigest",
  CODEOPS_BASE_SHA: "baseSha",
  CODEOPS_PROMPT_B64: "promptBase64",
  CODEOPS_REPOSITORY_URL: "repository",
  CODEOPS_RUN_ID: "runId",
  CODEOPS_RUN_SUFFIX: "runSuffix",
  CODEOPS_SESSION_GATEWAY_DIGEST: "sessionGatewayDigest",
};

export function renderAgentJobManifest(template, input) {
  if (!RUN_ID.test(input.runId ?? "")) {
    throw new Error("run ID must be a DNS-safe label");
  }
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain exactly 40 lowercase hex characters");
  }
  if (!REPOSITORY.test(input.repository ?? "")) {
    throw new Error("repository must be an HTTPS GitHub repository URL");
  }
  for (const key of ["agentDigest", "sessionGatewayDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must use a lowercase SHA-256 digest`);
    }
  }

  const values = { ...input, runSuffix: input.runId };
  values.promptBase64 = Buffer.from(input.prompt ?? "", "utf8").toString("base64");
  if (
    Buffer.byteLength(input.prompt ?? "", "utf8") < 1 ||
    Buffer.byteLength(input.prompt ?? "", "utf8") > 100_000
  ) {
    throw new Error("prompt must contain 1 to 100000 UTF-8 bytes");
  }
  let rendered = template;
  for (const [token, key] of Object.entries(TOKENS)) {
    const occurrences = rendered.split(token).length - 1;
    if (occurrences < 1) throw new Error(`expected ${token} token`);
    rendered = rendered.replaceAll(token, values[key]);
  }
  for (const token of Object.keys(TOKENS)) {
    if (rendered.includes(token)) {
      throw new Error(`unresolved ${token} token survived rendering`);
    }
  }

  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const kinds = resources.map((resource) => resource?.kind).sort();
  if (
    JSON.stringify(kinds) !==
    JSON.stringify(["Job", "NetworkPolicy", "ServiceAccount"])
  ) {
    throw new Error("agent run may render only Job, NetworkPolicy, and ServiceAccount");
  }

  const job = resources.find((resource) => resource.kind === "Job");
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const pod = job.spec.template.spec;
  const images = [...pod.initContainers, ...pod.containers].map(
    (container) => container.image,
  );
  if (
    images.length !== 3 ||
    images.some((image) => !/@sha256:[0-9a-f]{64}$/.test(image))
  ) {
    throw new Error("every agent-run container image must be immutable");
  }
  if (
    pod.automountServiceAccountToken !== false ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("agent run must not receive a Kubernetes service-account token");
  }
  if (JSON.stringify(resources).includes("hostPath")) {
    throw new Error("agent run must not mount host paths");
  }
  return rendered;
}
