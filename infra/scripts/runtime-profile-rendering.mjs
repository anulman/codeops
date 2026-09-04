import { createHash } from "node:crypto";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const digestImage = /^.+@sha256:[0-9a-f]{64}$/;
const exactKeys = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const positiveBound = (value) =>
  Number.isInteger(value) && value > 0 && value <= 16 * 1_024 * 1_024;

export function validateRuntimeProfile(raw) {
  if (!exactKeys(raw, [
    "version", "profileId", "releaseDigest", "capabilities",
    "capabilityDigest", "resources", "authority",
    "compatibilityPolicyRevision", "images",
  ]) || raw.version !== "codeops.runtime-profile/v1" ||
      !identifier.test(raw.profileId ?? "") || !digest.test(raw.releaseDigest ?? "") ||
      !Array.isArray(raw.capabilities) || raw.capabilities.length < 1 ||
      raw.capabilities.length > 64 ||
      raw.capabilities.some((value, index) => !identifier.test(value) ||
        (index > 0 && raw.capabilities[index - 1] >= value)) ||
      raw.capabilityDigest !== `sha256:${createHash("sha256").update(JSON.stringify(raw.capabilities)).digest("hex")}` ||
      !exactKeys(raw.resources, ["cpuMillis", "memoryMiB", "ephemeralStorageMiB"]) ||
      !positiveBound(raw.resources.cpuMillis) ||
      !positiveBound(raw.resources.memoryMiB) ||
      !positiveBound(raw.resources.ephemeralStorageMiB) ||
      raw.resources.cpuMillis > 1_000_000 ||
      !exactKeys(raw.authority, ["workspaceAccess", "publicNetwork", "brokeredProviderEffects"]) ||
      !["read-only", "bounded-writes"].includes(raw.authority.workspaceAccess) ||
      typeof raw.authority.publicNetwork !== "boolean" ||
      typeof raw.authority.brokeredProviderEffects !== "boolean" ||
      !identifier.test(raw.compatibilityPolicyRevision ?? "") ||
      !exactKeys(raw.images, ["agent", "worker", "sessionGateway"]) ||
      Object.values(raw.images).some((image) => !digestImage.test(image))) {
    throw new Error("runtime profile does not match the complete trusted schema");
  }
  return Object.freeze(structuredClone(raw));
}

const kube = (resources) => ({
  cpu: `${resources.cpuMillis}m`,
  memory: `${resources.memoryMiB}Mi`,
  "ephemeral-storage": `${resources.ephemeralStorageMiB}Mi`,
});

const runtimeRequirements = {
  cpuMillis: 600,
  memoryMiB: 1_280,
  ephemeralStorageMiB: 1_280,
};

const subtract = (total, reserved, label) => {
  const remainder = Object.fromEntries(
    Object.keys(total).map((key) => [key, total[key] - reserved[key]]),
  );
  if (Object.values(remainder).some((value) => value <= 0)) {
    throw new Error(`runtime profile cannot supply ${label}`);
  }
  return remainder;
};

export function fixedRuntimeResources(profile) {
  const sidecarRequests = { cpuMillis: 100, memoryMiB: 256, ephemeralStorageMiB: 256 };
  const sidecarLimits = { cpuMillis: 1_000, memoryMiB: 1_024, ephemeralStorageMiB: 1_024 };
  const builderRequests = {
    cpuMillis: 100,
    memoryMiB: 128,
    ephemeralStorageMiB: runtimeRequirements.ephemeralStorageMiB,
  };
  const builderLimits = {
    cpuMillis: 500,
    memoryMiB: 512,
    ephemeralStorageMiB: profile.resources.ephemeralStorageMiB,
  };
  const agentRequests = subtract(runtimeRequirements, sidecarRequests, "runtime requirements");
  const agentLimits = subtract(profile.resources, sidecarLimits, "runtime profile");
  for (const [name, requests, limits] of [
    ["workspace-builder", builderRequests, builderLimits],
    ["runtime-worker", sidecarRequests, sidecarLimits],
    ["coding-agent", agentRequests, agentLimits],
  ]) {
    for (const key of Object.keys(requests)) {
      if (requests[key] > limits[key] || limits[key] <= 0) {
        throw new Error(`runtime profile cannot bound ${name} ${key}`);
      }
    }
  }
  return {
    builder: { requests: kube(builderRequests), limits: kube(builderLimits) },
    worker: { requests: kube(sidecarRequests), limits: kube(sidecarLimits) },
    agent: { requests: kube(agentRequests), limits: kube(agentLimits) },
    workspaceSizeLimit: `${profile.resources.ephemeralStorageMiB}Mi`,
    tempSizeLimit: profile.resources.ephemeralStorageMiB >= 2_048
      ? "2Gi"
      : `${profile.resources.ephemeralStorageMiB}Mi`,
  };
}

export function requireFullRuntimeAuthority(profile) {
  if (profile.authority.workspaceAccess !== "bounded-writes" ||
      !profile.authority.publicNetwork ||
      !profile.authority.brokeredProviderEffects) {
    throw new Error("fixed runtime does not render authority denied by its selected profile");
  }
}
