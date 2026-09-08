const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const workerId = "acp-worker:primary";
const repository = "example/service";
const resolvedSha = "a".repeat(40);
const runtimeBinding = {
  version: "codeops.runtime-binding/v1",
  requirementDigest: `sha256:${"6".repeat(64)}`,
  compatibilityPolicyRevision: "policy-7",
  selectedProfileId: "standard-v1",
  selectedReleaseDigest: `sha256:${"7".repeat(64)}`,
 selectedCapabilityDigest: `sha256:${"8".repeat(64)}`,
  selectedProfile: { version: "codeops.runtime-profile/v1", profileId: "standard-v1", releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"], capabilityDigest: `sha256:${"8".repeat(64)}`, resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 }, authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true }, compatibilityPolicyRevision: "policy-7", images: { agent: `example/agent@sha256:${"a".repeat(64)}`, worker: `example/worker@sha256:${"b".repeat(64)}`, sessionGateway: `example/gateway@sha256:${"c".repeat(64)}` } },
  selectedAt: "2099-08-15T10:00:00.000Z",
};

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "session-authority",
    generation: 1,
    state: "running",
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: {
        version: "codeops.session-policy/v1",
        mode: "review",
        workspaceAccess: "read-only",
        modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      workspace: {
        version: "codeops.workspace/v1",
        sources: [{
          catalogKey: "codeops",
          repository,
          checkoutPath: "sources/codeops",
          requestedRef: "main",
          resolvedSha,
        }],
        scratchPath: "scratch",
      },
      workItemId: "55555555-5555-4555-8555-555555555555",
      workflowId: "workspace-launch",
      runId: "launch-authority",
      displayName: "Inspect CodeOps",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "runtime-worker",
      acquiredAt: "2099-08-15T10:00:00.000Z",
      expiresAt: "2099-08-15T12:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 2,
    capabilities: capabilities(),
    updatedAt: "2099-08-15T10:01:00.000Z",
    ...overrides,
  };
}

function dispatch(overrides = {}) {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "operator:example",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "session-authority",
      generation: 1,
      leaseId,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      type: "prompt",
      prompt: "Inspect the exact source.",
    },
    snapshot: snapshot(),
    dispatchedAt: "2099-08-15T10:01:00.000Z",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    dispatch_json: dispatch(),
    status: "claimed",
    claim_count: 1,
    claim_token: claimToken,
    claimed_by: workerId,
    claim_expires_at: "2099-08-15T11:00:00.000Z",
    owner_principal_id: "operator:example",
    session_id: "session-authority",
    session_identity_json: snapshot().identity,
    runtime_binding_json: runtimeBinding,
    owner_runtime_binding_json: runtimeBinding,
    runtime_claim_protocol: "bound-v2",
    legacy_runtime_worker_compatible: false,
    ...overrides,
  };
}


export { dispatchId, claimToken, leaseId, workerId, repository, resolvedSha, runtimeBinding, snapshot, dispatch, row };
