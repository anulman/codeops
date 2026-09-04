import { readFile } from "node:fs/promises";
import {
  runtimeProfileSchema,
  runtimeRequirementsSchema,
  sha256CanonicalJsonDigest,
  type RuntimeProfile,
  type RuntimeRequirements,
  type RuntimeLaunchBinding,
  type WorkspaceLaunch,
  runtimeLaunchBindingSchema,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const registrySchema = z.object({
  version: z.literal("codeops.runtime-profile-registry/v1"),
  profiles: z.array(runtimeProfileSchema).min(1).max(32),
}).strict();

export type RuntimeCompatibilityRejection =
  | "profile-not-deployed"
  | "policy-revision-mismatch"
  | "capability-unsatisfied"
  | "resource-bound-unsatisfied"
  | "authority-expansion"
  | "authority-unsatisfied"
  | "legacy-runtime-unbound"
  | "runtime-release-mismatch";

export class RuntimeCompatibilityError extends Error {
  constructor(readonly code: RuntimeCompatibilityRejection) { super(code); }
}

export interface RuntimeProfileRegistry {
  readonly profiles: readonly RuntimeProfile[];
  resolveCompatible(profileId: string, requirements: RuntimeRequirements): RuntimeProfile;
  selectCompatible(requirements: RuntimeRequirements): RuntimeProfile;
}

function rejection(profile: RuntimeProfile, requirements: RuntimeRequirements): RuntimeCompatibilityRejection | null {
  if (profile.compatibilityPolicyRevision !== requirements.compatibilityPolicyRevision) return "policy-revision-mismatch";
  if (requirements.capabilities.some((capability) => !profile.capabilities.includes(capability))) return "capability-unsatisfied";
  if (profile.resources.cpuMillis < requirements.minimumResources.cpuMillis ||
      profile.resources.memoryMiB < requirements.minimumResources.memoryMiB ||
      profile.resources.ephemeralStorageMiB < requirements.minimumResources.ephemeralStorageMiB) return "resource-bound-unsatisfied";
  // Both supported Pod builders reserve the same sidecar request and limit.
  // The remaining agent request must fit within the remaining agent limit.
  if (profile.resources.cpuMillis - requirements.minimumResources.cpuMillis < 900 ||
      profile.resources.memoryMiB - requirements.minimumResources.memoryMiB < 768 ||
      profile.resources.ephemeralStorageMiB -
        requirements.minimumResources.ephemeralStorageMiB < 768) return "resource-bound-unsatisfied";
  if ((requirements.maximumAuthority.workspaceAccess === "read-only" && profile.authority.workspaceAccess === "bounded-writes") ||
      (profile.authority.publicNetwork && !requirements.maximumAuthority.publicNetwork) ||
      (profile.authority.brokeredProviderEffects && !requirements.maximumAuthority.brokeredProviderEffects)) return "authority-expansion";
  if ((requirements.requiredAuthority.workspaceAccess === "bounded-writes" && profile.authority.workspaceAccess === "read-only") ||
      (requirements.requiredAuthority.publicNetwork && !profile.authority.publicNetwork) ||
      (requirements.requiredAuthority.brokeredProviderEffects && !profile.authority.brokeredProviderEffects)) return "authority-unsatisfied";
  return null;
}

export function createRuntimeProfileRegistry(raw: unknown): RuntimeProfileRegistry {
  const parsed = registrySchema.parse(raw);
  const profiles = parsed.profiles.map((candidate) => {
    const profile = runtimeProfileSchema.parse(candidate);
    if (profile.capabilityDigest !== sha256CanonicalJsonDigest(profile.capabilities)) {
      throw new Error("runtime profile capability digest is invalid");
    }
    return profile;
  });
  const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
  if (byId.size !== profiles.length) throw new Error("runtime profile identities must be unique");
  const ordered = [...profiles].sort((left, right) => left.profileId.localeCompare(right.profileId));
  return {
    profiles: ordered,
    resolveCompatible(profileId, rawRequirements) {
      const requirements = runtimeRequirementsSchema.parse(rawRequirements);
      const profile = byId.get(profileId);
      if (profile === undefined) throw new RuntimeCompatibilityError("profile-not-deployed");
      const code = rejection(profile, requirements);
      if (code !== null) throw new RuntimeCompatibilityError(code);
      return profile;
    },
    selectCompatible(rawRequirements) {
      const requirements = runtimeRequirementsSchema.parse(rawRequirements);
      const profile = ordered.find((candidate) => rejection(candidate, requirements) === null);
      if (profile === undefined) throw new RuntimeCompatibilityError("profile-not-deployed");
      return profile;
    },
  };
}

export async function loadRuntimeProfileRegistryFile(filePath: string): Promise<RuntimeProfileRegistry> {
  if (!filePath.startsWith("/") || filePath.length > 1_024) throw new Error("runtime profile registry path must be an exact absolute path");
  const contents = await readFile(filePath, "utf8");
  if (Buffer.byteLength(contents) > 128 * 1_024) throw new Error("runtime profile registry exceeds 128 KiB");
  return createRuntimeProfileRegistry(JSON.parse(contents));
}

export function resolveWorkspaceRuntimeLaunchBinding(
  launch: WorkspaceLaunch,
  registry: RuntimeProfileRegistry,
  selectedAt: string,
  legacyRequirements?: RuntimeRequirements,
): RuntimeLaunchBinding {
  const requirements = launch.runtimeRequirements ?? legacyRequirements;
  if (requirements === undefined ||
      (launch.runtimeRequirements === undefined) !== (launch.runtimeRequirementDigest === undefined) ||
      (launch.runtimeRequirements === undefined && launch.legacyRuntimeCompatible !== true)) {
    throw new RuntimeCompatibilityError("legacy-runtime-unbound");
  }
  if (launch.runtimeLaunchBinding !== undefined) return runtimeLaunchBindingSchema.parse(launch.runtimeLaunchBinding);
  return runtimeLaunchBindingSchema.parse({
    version: "codeops.runtime-launch-binding/v1",
    requirementDigest: sha256CanonicalJsonDigest(requirements),
    profile: registry.selectCompatible(requirements),
    selectedAt,
  });
}
