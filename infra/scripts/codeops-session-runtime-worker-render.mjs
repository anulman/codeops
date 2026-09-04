import { createHash } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";
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
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REPOSITORY = "https://github.com/example-org/example-repository";

const TOKENS = {
  __CODEOPS_AGENT_DIGEST__: "agentDigest",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_BRANCH__: "branch",
  __CODEOPS_LEASE_ID__: "leaseId",
  __CODEOPS_REPOSITORY_URL__: "repository",
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

export function renderSessionRuntimeWorkerManifest(template, input) {
  for (const key of ["agentDigest", "workerDigest", "runtimeReleaseDigest", "runtimeCapabilityDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must use one lowercase SHA-256 digest`);
    }
  }
  if (!IDENTIFIER.test(input.runtimeProfileId ?? "")) {
    throw new Error("runtime profile ID is invalid");
  }
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
    throw new Error("runtime profile must bind the exact rendered disposable-session images");
  }
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain 40 lowercase hex characters");
  }
  if (input.repository !== REPOSITORY) {
    throw new Error("session runtime repository is fixed to CodeOps");
  }
  if (
    !IDENTIFIER.test(input.sessionId ?? "") ||
    !LABEL.test(input.sessionId ?? "")
  ) {
    throw new Error("session ID must fit both broker and Kubernetes label identity");
  }
  if (!DNS.test(input.sessionSuffix ?? "")) {
    throw new Error("session suffix must be one DNS-safe label");
  }
  for (const key of ["workflowId", "runId"]) {
    if (!DNS.test(input[key] ?? "")) {
      throw new Error(`${key} must be one DNS-safe workflow identifier`);
    }
  }
  if (!UUID.test(input.leaseId ?? "")) {
    throw new Error("lease ID must be one lowercase UUID");
  }
  if (!PRINCIPAL.test(input.ownerPrincipalId ?? "")) {
    throw new Error("session owner principal is invalid");
  }
  if (
    typeof input.branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch) ||
    input.branch.includes("..") ||
    input.branch.includes("//") ||
    input.branch.endsWith("/") ||
    input.branch.endsWith(".") ||
    input.branch.endsWith(".lock")
  ) {
    throw new Error("branch must be one bounded single-line value");
  }

  const values = {
    ...input,
    runtimeProfileJson: JSON.stringify(profile).replaceAll("'", "''"),
  };
  let rendered = template;
  for (const [token, key] of Object.entries(TOKENS)) {
    if (!rendered.includes(token)) throw new Error(`expected ${token}`);
    rendered = rendered.replaceAll(token, values[key]);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("unresolved session runtime worker token");
  }

  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  const name = `codeops-session-runtime-${input.sessionSuffix}`;
  if (name.length > 63) {
    throw new Error("session runtime resource name exceeds 63 characters");
  }
  if (JSON.stringify(identities) !== JSON.stringify([
    `Job/${name}`,
    `NetworkPolicy/${name}`,
    `ServiceAccount/${name}`,
  ].sort())) {
    throw new Error("session runtime worker resource set drifted");
  }
  const job = resources.find((resource) => resource.kind === "Job");
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const pod = job.spec.template.spec;
  if (
    job.spec.backoffLimit !== 0 ||
    job.spec.activeDeadlineSeconds !== 3600 ||
    pod.restartPolicy !== "Never" ||
    pod.terminationGracePeriodSeconds !== 960 ||
    pod.automountServiceAccountToken !== false ||
    account.automountServiceAccountToken !== false ||
    pod.serviceAccountName !== name ||
    pod.initContainers.length !== 1 ||
    pod.containers.length !== 2
  ) {
    throw new Error("session runtime Job retry or identity boundary drifted");
  }
  const builder = pod.initContainers[0];
  const worker = pod.containers.find((container) => container.name === "runtime-worker");
  const agent = pod.containers.find((container) => container.name === "coding-agent");
  const allocations = fixedRuntimeResources(profile);
  builder.resources = allocations.builder;
  worker.resources = allocations.worker;
  agent.resources = allocations.agent;
  const workspaceVolume = pod.volumes.find((volume) => volume.name === "workspace");
  const tempVolume = pod.volumes.find((volume) => volume.name === "temp");
  if (workspaceVolume?.emptyDir === undefined || tempVolume?.emptyDir === undefined) {
    throw new Error("session runtime ephemeral volumes are incomplete");
  }
  workspaceVolume.emptyDir.sizeLimit = allocations.workspaceSizeLimit;
  tempVolume.emptyDir.sizeLimit = allocations.tempSizeLimit;
  const images = [builder, worker, agent].map((container) => container.image);
  if (
    images.filter((image) => image.endsWith(`@${input.agentDigest}`)).length !== 2 ||
    worker.image !== `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}` ||
    images.some((image) => !/@sha256:[0-9a-f]{64}$/.test(image))
  ) {
    throw new Error("session runtime Job image identity drifted");
  }
  const env = Object.fromEntries(worker.env.map((entry) => [entry.name, entry.value]));
  if (
    env.CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN !== "http://codeops-control-gateway:8080" ||
    env.CODEOPS_SESSION_RUNTIME_ACP_SOCKET_PATH !== "/run/codeops/agent.sock" ||
    env.CODEOPS_SESSION_RUNTIME_WORKSPACE !== "/workspace" ||
    env.CODEOPS_SESSION_ID !== input.sessionId ||
    env.CODEOPS_RUNTIME_PROFILE_ID !== input.runtimeProfileId ||
    env.CODEOPS_RUNTIME_RELEASE_DIGEST !== input.runtimeReleaseDigest ||
    env.CODEOPS_RUNTIME_CAPABILITY_DIGEST !== input.runtimeCapabilityDigest ||
    env.CODEOPS_RUNTIME_PROFILE_JSON !== JSON.stringify(profile) ||
    env.CODEOPS_SESSION_OWNER_PRINCIPAL_ID !== input.ownerPrincipalId ||
    env.CODEOPS_SESSION_BASE_SHA !== input.baseSha ||
    env.CODEOPS_SESSION_LEASE_ID !== input.leaseId
  ) {
    throw new Error("session runtime worker execution identity drifted");
  }
  if (
    job.metadata.annotations?.["codeops.example/runtime-profile-id"] !== input.runtimeProfileId ||
    job.metadata.annotations?.["codeops.example/runtime-release-digest"] !== input.runtimeReleaseDigest ||
    job.metadata.annotations?.["codeops.example/runtime-capability-digest"] !== input.runtimeCapabilityDigest
  ) {
    throw new Error("session runtime Job profile annotations drifted");
  }
  if (
    JSON.stringify(worker.readinessProbe) !== JSON.stringify({
      exec: {
        command: [
          "node",
          "-e",
          "process.exit(require('node:fs').existsSync('/run/codeops/ready') ? 0 : 1)",
        ],
      },
      periodSeconds: 1,
      timeoutSeconds: 1,
      failureThreshold: 1,
      successThreshold: 1,
    })
  ) {
    throw new Error("session runtime initialization readiness boundary drifted");
  }
  const volumes = Object.fromEntries(pod.volumes.map((volume) => [volume.name, volume]));
  const secretBindings = {
    "session-runtime-worker-auth": "codeops-session-runtime-worker-auth",
    "session-job-initialization-auth": "codeops-session-job-initialization-auth",
    "session-runtime-database": "codeops-session-runtime-worker-database",
  };
  for (const [volumeName, secretName] of Object.entries(secretBindings)) {
    const secret = volumes[volumeName]?.secret;
    if (
      secret?.secretName !== secretName ||
      secret.items?.length !== 1 ||
      secret.items[0].path !== secret.items[0].key
    ) {
      throw new Error(`session runtime ${volumeName} binding drifted`);
    }
  }
  if (
    new Set(Object.values(secretBindings)).size !== 3 ||
    pod.volumes.some((volume) => volume.persistentVolumeClaim) ||
    JSON.stringify(resources).includes("hostPath") ||
    JSON.stringify(resources).includes("codeops-session-broker-database") ||
    JSON.stringify(resources).includes("codex-auth")
  ) {
    throw new Error("session runtime credential or volume boundary drifted");
  }
  const agentSource = JSON.stringify(agent);
  assertModelProxyRouting(agent, "http://codeops-model-proxy:8080");
  assertModelProxySessionVolume(pod, "runtime-worker");
  if (
    !agentSource.includes("/run/codeops/model-proxy-token") ||
    !agentSource.includes("http://codeops-model-proxy:8080/v1") ||
    agentSource.includes("chat-gpt")
  ) {
    throw new Error("session runtime model authority drifted");
  }
  for (const container of [builder, worker, agent]) {
    if (
      container.securityContext?.readOnlyRootFilesystem !== true ||
      JSON.stringify(container.securityContext?.capabilities?.drop) !== JSON.stringify(["ALL"])
    ) {
      throw new Error("session runtime container hardening drifted");
    }
  }
  const expectedEgressPorts = [53, 53, 443, 5432, 8080, 8080];
  const actualEgressPorts = policy.spec.egress
    .flatMap((rule) => rule.ports.map((port) => port.port))
    .sort((left, right) => Number(left) - Number(right));
  if (
    policy.spec.ingress.length !== 0 ||
    JSON.stringify(actualEgressPorts) !== JSON.stringify(expectedEgressPorts) ||
    policy.spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"] !== "codeops-control-gateway" ||
    policy.spec.egress[1].to[0].podSelector.matchLabels["app.kubernetes.io/name"] !== "codeops-session-proof-database" ||
    policy.spec.egress[2].to[0].podSelector.matchLabels["app.kubernetes.io/name"] !== "codeops-model-proxy"
  ) {
    throw new Error("session runtime network boundary drifted");
  }
  return resources.map((resource) => stringify(resource)).join("---\n");
}
