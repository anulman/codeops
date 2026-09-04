import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import {
  assertModelProxyRouting,
  assertModelProxySessionVolume,
} from "./model-proxy-routing.mjs";
import {
  fixedRuntimeResources,
  requireFullRuntimeAuthority,
  validateRuntimeProfile,
} from "./runtime-profile-rendering.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

const tokens = {
  __CODEOPS_AGENT_DIGEST__: "agentDigest",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_BRANCH__: "branch",
  __CODEOPS_LEASE_ID__: "leaseId",
  __CODEOPS_RUN_ID__: "runId",
  __CODEOPS_RUNTIME_CAPABILITY_DIGEST__: "runtimeCapabilityDigest",
  __CODEOPS_RUNTIME_PROFILE_ID__: "runtimeProfileId",
  __CODEOPS_RUNTIME_PROFILE_JSON__: "runtimeProfileJson",
  __CODEOPS_RUNTIME_RELEASE_DIGEST__: "runtimeReleaseDigest",
  __CODEOPS_SESSION_ID__: "sessionId",
  __CODEOPS_SESSION_OWNER_PRINCIPAL_ID__: "ownerPrincipalId",
  __CODEOPS_SESSION_RUNTIME_WORKER_DIGEST__: "workerDigest",
  __CODEOPS_SESSION_SUFFIX__: "sessionSuffix",
  __CODEOPS_WORKFLOW_ID__: "workflowId",
};

export function renderAgentsSystemRootSession(template, input) {
  for (const key of ["agentDigest", "workerDigest", "runtimeReleaseDigest", "runtimeCapabilityDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) throw new Error(`${key} must be an immutable digest`);
  }
  if (!IDENTIFIER.test(input.runtimeProfileId ?? "")) throw new Error("runtimeProfileId is invalid");
  const profile = validateRuntimeProfile(input.runtimeProfile);
  if (profile.compatibilityPolicyRevision !== "compatible-substitution-v1") {
    throw new Error("runtime profile compatibility policy is unsupported");
  }
  requireFullRuntimeAuthority(profile);
  if (
    profile?.version !== "codeops.runtime-profile/v1" ||
    profile.profileId !== input.runtimeProfileId ||
    profile.releaseDigest !== input.runtimeReleaseDigest ||
    profile.capabilityDigest !== input.runtimeCapabilityDigest ||
    !Array.isArray(profile.capabilities) ||
    profile.capabilityDigest !== `sha256:${createHash("sha256").update(JSON.stringify(profile.capabilities)).digest("hex")}` ||
    profile.images?.agent !== `ghcr.io/anulman/codeops/agent@${input.agentDigest}` ||
    profile.images?.worker !== `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}` ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(profile.images?.sessionGateway ?? "")
  ) {
    throw new Error("runtime profile must bind the exact rendered root-session images");
  }
  if (!SHA.test(input.baseSha ?? "")) throw new Error("baseSha must be one exact commit");
  if (!UUID.test(input.leaseId ?? "")) throw new Error("leaseId must be one UUID");
  if (!PRINCIPAL.test(input.ownerPrincipalId ?? "")) throw new Error("ownerPrincipalId is invalid");
  if (!IDENTIFIER.test(input.sessionId ?? "") || !LABEL.test(input.sessionId ?? "")) throw new Error("sessionId is invalid");
  for (const key of ["sessionSuffix", "workflowId", "runId"]) {
    if (!DNS.test(input[key] ?? "")) throw new Error(`${key} must be DNS-safe`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch ?? "") || input.branch.includes("..") || input.branch.includes("//")) {
    throw new Error("branch is invalid");
  }

  const values = {
    ...input,
    runtimeProfileJson: JSON.stringify(profile).replaceAll("'", "''"),
  };
  let rendered = template;
  for (const [token, key] of Object.entries(tokens)) {
    if (!rendered.includes(token)) throw new Error(`template is missing ${token}`);
    rendered = rendered.replaceAll(token, values[key]);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) throw new Error("template has unresolved input");

  const job = parseDocument(rendered).toJS();
  const pod = job.spec?.template?.spec;
  const allocations = fixedRuntimeResources(profile);
  const builder = pod?.initContainers?.find((container) => container.name === "workspace-builder");
  const worker = pod?.containers?.find((container) => container.name === "runtime-worker");
  const agent = pod?.containers?.find((container) => container.name === "coding-agent");
  if (builder === undefined || worker === undefined || agent === undefined) {
    throw new Error("trusted root runtime containers are incomplete");
  }
  builder.resources = allocations.builder;
  worker.resources = allocations.worker;
  agent.resources = allocations.agent;
  const workspaceVolume = pod.volumes?.find((volume) => volume.name === "workspace");
  const tempVolume = pod.volumes?.find((volume) => volume.name === "temp");
  if (workspaceVolume?.emptyDir === undefined || tempVolume?.emptyDir === undefined) {
    throw new Error("trusted root ephemeral volumes are incomplete");
  }
  workspaceVolume.emptyDir.sizeLimit = allocations.workspaceSizeLimit;
  tempVolume.emptyDir.sizeLimit = allocations.tempSizeLimit;
  if (job.kind !== "Job" || job.metadata?.namespace !== "agents-system" || job.spec?.backoffLimit !== 0 || pod?.automountServiceAccountToken !== false || pod?.serviceAccountName !== "agents-system-runtime") {
    throw new Error("trusted root Job authority drifted");
  }
  if (job.metadata.name.length > 63) throw new Error("trusted root Job name is too long");
  const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
  if (containers.length !== 3 || containers.some((container) => !/@sha256:[0-9a-f]{64}$/.test(container.image))) {
    throw new Error("trusted root Job image identity drifted");
  }
  const runtimeIdentity = Object.fromEntries(worker.env.map((entry) => [entry.name, entry.value]));
  if (
    runtimeIdentity.CODEOPS_RUNTIME_PROFILE_ID !== input.runtimeProfileId ||
    runtimeIdentity.CODEOPS_RUNTIME_RELEASE_DIGEST !== input.runtimeReleaseDigest ||
    runtimeIdentity.CODEOPS_RUNTIME_CAPABILITY_DIGEST !== input.runtimeCapabilityDigest ||
    runtimeIdentity.CODEOPS_RUNTIME_PROFILE_JSON !== JSON.stringify(profile) ||
    job.metadata.annotations?.["codeops.example/runtime-release-digest"] !== input.runtimeReleaseDigest
  ) {
    throw new Error("trusted root runtime profile identity drifted");
  }
  if (worker?.env.find((entry) => entry.name === "CODEOPS_SESSION_OWNER_PRINCIPAL_ID")?.value !== input.ownerPrincipalId) {
    throw new Error("trusted root session owner drifted");
  }
  const mountedKeys = pod.volumes.find((volume) => volume.name === "session-secrets")?.secret?.items?.map((item) => item.key).sort();
  if (worker?.env.find((entry) => entry.name === "CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN")?.value !== "http://agents-session-control-gateway:8080" || JSON.stringify(mountedKeys) !== JSON.stringify(["initialization-token", "runtime-database-url", "runtime-worker-token"])) {
    throw new Error("trusted root initialization authority drifted");
  }
  if (JSON.stringify(job).includes("write-token") || JSON.stringify(job).includes("github-steering-token") || JSON.stringify(job).includes("kind: Secret")) {
    throw new Error("trusted root Job received unrelated authority");
  }
  assertModelProxyRouting(agent, "http://agents-system-model-proxy:8080");
  assertModelProxySessionVolume(pod, "runtime-worker");
  const source = JSON.stringify(agent);
  if (
    source.includes("codex-auth") ||
    source.includes("chat-gpt") ||
    !source.includes("/run/codeops/model-proxy-token") ||
    !source.includes("http://agents-system-model-proxy:8080/v1")
  ) {
    throw new Error("trusted root Job model authority drifted");
  }
  return stringify(job);
}
