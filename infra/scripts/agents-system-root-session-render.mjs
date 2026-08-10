import { parseDocument } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const tokens = {
  __CODEOPS_AGENT_DIGEST__: "agentDigest",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_BRANCH__: "branch",
  __CODEOPS_LEASE_ID__: "leaseId",
  __CODEOPS_RUN_ID__: "runId",
  __CODEOPS_SESSION_ID__: "sessionId",
  __CODEOPS_SESSION_RUNTIME_WORKER_DIGEST__: "workerDigest",
  __CODEOPS_SESSION_SUFFIX__: "sessionSuffix",
  __CODEOPS_WORKFLOW_ID__: "workflowId",
};

export function renderAgentsSystemRootSession(template, input) {
  for (const key of ["agentDigest", "workerDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) throw new Error(`${key} must be an immutable digest`);
  }
  if (!SHA.test(input.baseSha ?? "")) throw new Error("baseSha must be one exact commit");
  if (!UUID.test(input.leaseId ?? "")) throw new Error("leaseId must be one UUID");
  if (!IDENTIFIER.test(input.sessionId ?? "") || !LABEL.test(input.sessionId ?? "")) throw new Error("sessionId is invalid");
  for (const key of ["sessionSuffix", "workflowId", "runId"]) {
    if (!DNS.test(input[key] ?? "")) throw new Error(`${key} must be DNS-safe`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch ?? "") || input.branch.includes("..") || input.branch.includes("//")) {
    throw new Error("branch is invalid");
  }

  let rendered = template;
  for (const [token, key] of Object.entries(tokens)) {
    if (!rendered.includes(token)) throw new Error(`template is missing ${token}`);
    rendered = rendered.replaceAll(token, input[key]);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) throw new Error("template has unresolved input");

  const job = parseDocument(rendered).toJS();
  const pod = job.spec?.template?.spec;
  if (job.kind !== "Job" || job.metadata?.namespace !== "agents-system" || job.spec?.backoffLimit !== 0 || pod?.automountServiceAccountToken !== false || pod?.serviceAccountName !== "agents-system-runtime") {
    throw new Error("trusted root Job authority drifted");
  }
  if (job.metadata.name.length > 63) throw new Error("trusted root Job name is too long");
  const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
  if (containers.length !== 3 || containers.some((container) => !/@sha256:[0-9a-f]{64}$/.test(container.image))) {
    throw new Error("trusted root Job image identity drifted");
  }
  const worker = pod.containers.find((container) => container.name === "runtime-worker");
  const mountedKeys = pod.volumes.find((volume) => volume.name === "session-secrets")?.secret?.items?.map((item) => item.key).sort();
  if (worker?.env.find((entry) => entry.name === "CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN")?.value !== "http://agents-session-control-gateway:8080" || JSON.stringify(mountedKeys) !== JSON.stringify(["initialization-token", "runtime-database-url", "runtime-worker-token"])) {
    throw new Error("trusted root initialization authority drifted");
  }
  if (JSON.stringify(job).includes("write-token") || JSON.stringify(job).includes("github-steering-token") || JSON.stringify(job).includes("kind: Secret")) {
    throw new Error("trusted root Job received unrelated authority");
  }
  const agent = pod.containers.find((container) => container.name === "coding-agent");
  const source = JSON.stringify(agent);
  if (
    source.includes("codex-auth") ||
    source.includes("chat-gpt") ||
    !source.includes("/run/codeops/model-proxy-token") ||
    !source.includes("http://agents-system-model-proxy:8080/v1")
  ) {
    throw new Error("trusted root Job model authority drifted");
  }
  return rendered;
}
