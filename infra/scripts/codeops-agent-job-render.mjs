import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REPOSITORY =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const AGENT_ROLES = new Set(["coding-agent", "qa-contract-researcher"]);

const TOKENS = {
  __CODEOPS_AGENT_DIGEST__: "agentDigest",
  __CODEOPS_AGENT_ROLE__: "role",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_PROMPT_B64__: "promptBase64",
  __CODEOPS_REPOSITORY_URL__: "repository",
  __CODEOPS_RUN_ID__: "runId",
  __CODEOPS_RUN_SUFFIX__: "runSuffix",
  __CODEOPS_SESSION_GATEWAY_DIGEST__: "sessionGatewayDigest",
  __CODEOPS_WORKSPACE_READ_ONLY__: "workspaceReadOnly",
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
  if (!AGENT_ROLES.has(input.role ?? "")) {
    throw new Error("agent role must be coding-agent or qa-contract-researcher");
  }
  for (const key of ["agentDigest", "sessionGatewayDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must use a lowercase SHA-256 digest`);
    }
  }

  const values = {
    ...input,
    runSuffix: input.runId,
    workspaceReadOnly:
      input.role === "qa-contract-researcher" ? "true" : "false",
  };
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
  const networkPolicy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
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
  for (const resource of [account, job, job.spec.template, networkPolicy]) {
    if (
      resource.metadata.labels?.["codeops.renoconcierge.ca/agent-role"] !==
      input.role
    ) {
      throw new Error("every agent-run resource must carry the exact agent role");
    }
  }
  const runtimeContainers = pod.containers.filter((container) =>
    ["session-gateway", "coding-agent"].includes(container.name),
  );
  if (runtimeContainers.length !== 2) {
    throw new Error("agent run must contain the session gateway and coding agent");
  }
  for (const container of runtimeContainers) {
    const role = container.env?.find(
      (entry) => entry.name === "CODEOPS_AGENT_ROLE",
    );
    const workspace = container.volumeMounts?.find(
      (mount) => mount.name === "workspace",
    );
    if (role?.value !== input.role || !workspace) {
      throw new Error("runtime containers must receive the exact agent role");
    }
    if (
      workspace.readOnly !==
      (input.role === "qa-contract-researcher")
    ) {
      throw new Error("workspace mutability does not match the agent role");
    }
  }
  return rendered;
}
