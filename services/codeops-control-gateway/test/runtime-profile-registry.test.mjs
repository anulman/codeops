import assert from "node:assert/strict";
import test from "node:test";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import {
  RuntimeCompatibilityError,
  createRuntimeProfileRegistry,
  resolveWorkspaceRuntimeLaunchBinding,
  runtimeProfileModel,
} from "../dist/runtime-profile-registry.js";

const requirements = {
  version: "codeops.runtime-requirements/v1",
  capabilities: ["acp", "checkpoint"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1280, ephemeralStorageMiB: 1280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "policy-7",
};
const requirementDigest = sha256CanonicalJsonDigest(requirements);
const digest = (character) => `sha256:${character.repeat(64)}`;

function profile(release = "7", overrides = {}) {
  const capabilities = overrides.capabilities ?? ["acp", "checkpoint", "github-broker"];
  return {
    version: "codeops.runtime-profile/v1",
    profileId: "standard-v1",
    releaseDigest: digest(release),
    capabilities,
    capabilityDigest: sha256CanonicalJsonDigest(capabilities),
    resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
    authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
    compatibilityPolicyRevision: "policy-7",
    images: { agent: `example/agent@${digest(release)}`, worker: `example/worker@${digest(release)}`,
      sessionGateway: `example/gateway@${digest(release)}` },
    ...overrides,
  };
}

function registry(candidate) {
  return createRuntimeProfileRegistry({
    version: "codeops.runtime-profile-registry/v1",
    profiles: [candidate],
  });
}

function launch(runtimeLaunchBinding) {
  return {
    version: "codeops.workspace-launch/v1",
    launchId: "launch-0123456789abcdef01234567",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    principalId: "user@example.com",
    requestDigest: digest("1"),
    runtimeRequirements: requirements,
    runtimeRequirementDigest: requirementDigest,
    ...(runtimeLaunchBinding === undefined ? {} : { runtimeLaunchBinding }),
    policy: {
      version: "codeops.session-policy/v1", mode: "implement",
      workspaceAccess: "bounded-writes", modelCalls: "allowed",
      modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    },
    contextAttachments: [], promptDigest: digest("2"),
    workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
    state: "provisioning", createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z", deadlineAt: "2026-08-01T06:00:00.000Z",
    attemptCount: 0,
  };
}

test("selects only a capability, resource, authority, and policy compatible profile", () => {
  assert.equal(registry(profile()).selectCompatible(requirements).releaseDigest, digest("7"));
  for (const [changed, code] of [
    [{ capabilities: ["acp"] }, "capability-unsatisfied"],
    [{ compatibilityPolicyRevision: "policy-8" }, "policy-revision-mismatch"],
    [{ resources: { cpuMillis: 599, memoryMiB: 7168, ephemeralStorageMiB: 5120 } }, "resource-bound-unsatisfied"],
    [{ authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true } }, "authority-expansion"],
    [{ authority: { workspaceAccess: "read-only", publicNetwork: true, brokeredProviderEffects: true } }, "authority-unsatisfied"],
  ]) {
    const checked = code === "authority-expansion"
      ? { ...requirements,
          requiredAuthority: { ...requirements.requiredAuthority, publicNetwork: false },
          maximumAuthority: { ...requirements.maximumAuthority, publicNetwork: false } }
      : requirements;
    assert.throws(
      () => registry(profile("7", changed)).resolveCompatible("standard-v1", checked),
      (error) => error instanceof RuntimeCompatibilityError && error.code === code,
    );
  }
});

test("accepts only the subscription-only no-fallback Astra profile authority", () => {
  const astra = (capabilities) => profile("7", {
    profileId: "gpt-6-astra",
    capabilities: [...capabilities].sort(),
    capabilityDigest: sha256CanonicalJsonDigest([...capabilities].sort()),
  });
  assert.equal(runtimeProfileModel(astra([
    "acp", "api-key-fallback:false", "model:gpt-6-astra",
    "provider-route:chatgpt-primary",
  ])), "gpt-6-astra");
  for (const capabilities of [
    ["acp", "api-key-fallback:true", "model:gpt-6-astra", "provider-route:chatgpt-primary"],
    ["acp", "api-key-fallback:false", "model:gpt-6-astra", "provider-route:api-key"],
  ]) assert.throws(() => runtimeProfileModel(astra(capabilities)), /provider authority/);
});

test("replays the complete stored profile across a same-ID release rollover", () => {
  const bound = {
    version: "codeops.runtime-launch-binding/v1",
    requirementDigest,
    profile: profile("7"),
    selectedAt: "2026-08-01T00:01:00.000Z",
  };
  const replay = resolveWorkspaceRuntimeLaunchBinding(
    launch(bound), registry(profile("8")), "2026-08-02T00:01:00.000Z",
  );
  assert.deepEqual(replay, bound);
  assert.equal(replay.profile.images.worker, `example/worker@${digest("7")}`);
});

test("selects a guarded binding for an established active legacy launch", () => {
  const legacy = launch();
  delete legacy.runtimeRequirements;
  delete legacy.runtimeRequirementDigest;
  legacy.legacyRuntimeCompatible = true;
  const binding = resolveWorkspaceRuntimeLaunchBinding(
    legacy, registry(profile("7")), "2026-08-02T00:01:00.000Z", requirements,
  );
  assert.equal(binding.requirementDigest, requirementDigest);
  assert.equal(binding.profile.releaseDigest, digest("7"));
});

test("rejects an unmarked unbound launch admitted after migration", () => {
  const unbound = launch();
  delete unbound.runtimeRequirements;
  delete unbound.runtimeRequirementDigest;
  assert.throws(() => resolveWorkspaceRuntimeLaunchBinding(
    unbound, registry(profile("7")), "2026-08-02T00:01:00.000Z", requirements,
  ), (error) => error instanceof RuntimeCompatibilityError &&
    error.code === "legacy-runtime-unbound");
});
