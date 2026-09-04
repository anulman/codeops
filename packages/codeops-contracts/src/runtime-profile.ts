import { z } from "zod";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const digestImage = z.string().regex(/^.+@sha256:[0-9a-f]{64}$/);
const sortedIdentifiers = z.array(identifier).min(1).max(64).refine(
  (values) => new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value),
  "runtime capability values must be unique and sorted",
);

export const runtimeResourceBoundsSchema = z.object({
  cpuMillis: z.number().int().positive().max(1_000_000),
  memoryMiB: z.number().int().positive().max(16 * 1_024 * 1_024),
  ephemeralStorageMiB: z.number().int().positive().max(16 * 1_024 * 1_024),
}).strict();

export const runtimeAuthoritySchema = z.object({
  workspaceAccess: z.enum(["read-only", "bounded-writes"]),
  publicNetwork: z.boolean(),
  brokeredProviderEffects: z.boolean(),
}).strict();

export const runtimeRequirementsSchema = z.object({
  version: z.literal("codeops.runtime-requirements/v1"),
  capabilities: sortedIdentifiers,
  minimumResources: runtimeResourceBoundsSchema,
  requiredAuthority: runtimeAuthoritySchema,
  maximumAuthority: runtimeAuthoritySchema,
  compatibilityPolicyRevision: identifier,
}).strict().refine((value) =>
  !(value.requiredAuthority.workspaceAccess === "bounded-writes" &&
      value.maximumAuthority.workspaceAccess === "read-only") &&
  (!value.requiredAuthority.publicNetwork || value.maximumAuthority.publicNetwork) &&
  (!value.requiredAuthority.brokeredProviderEffects ||
      value.maximumAuthority.brokeredProviderEffects),
"required runtime authority must not exceed maximum runtime authority");

export const runtimeProfileSchema = z.object({
  version: z.literal("codeops.runtime-profile/v1"),
  profileId: identifier,
  releaseDigest: digest,
  capabilities: sortedIdentifiers,
  capabilityDigest: digest,
  resources: runtimeResourceBoundsSchema,
  authority: runtimeAuthoritySchema,
  compatibilityPolicyRevision: identifier,
  images: z.object({
    agent: digestImage,
    worker: digestImage,
    sessionGateway: digestImage,
  }).strict(),
}).strict();

export const runtimeLaunchBindingSchema = z.object({
  version: z.literal("codeops.runtime-launch-binding/v1"),
  requirementDigest: digest,
  profile: runtimeProfileSchema,
  selectedAt: z.string().datetime({ offset: true }),
}).strict();

export const runtimeBindingSchema = z.object({
  version: z.literal("codeops.runtime-binding/v1"),
  requirementDigest: digest,
  compatibilityPolicyRevision: identifier,
  selectedProfileId: identifier,
  selectedReleaseDigest: digest,
  selectedCapabilityDigest: digest,
  selectedProfile: runtimeProfileSchema,
  selectedAt: z.string().datetime({ offset: true }),
}).strict().refine((value) =>
  value.selectedProfile.profileId === value.selectedProfileId &&
  value.selectedProfile.releaseDigest === value.selectedReleaseDigest &&
  value.selectedProfile.capabilityDigest === value.selectedCapabilityDigest &&
  value.selectedProfile.compatibilityPolicyRevision ===
    value.compatibilityPolicyRevision,
"runtime binding profile must match its selected identity");

export type RuntimeRequirements = z.infer<typeof runtimeRequirementsSchema>;
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type RuntimeLaunchBinding = z.infer<typeof runtimeLaunchBindingSchema>;
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;
