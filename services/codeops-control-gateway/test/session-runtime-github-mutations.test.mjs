import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authorizeSessionRuntimeGitHubMutation,
  beginSessionRuntimeGitHubMutationAttempt,
  completeSessionRuntimeGitHubMutation,
  createGitHubMutationProviderClient,
  createGitHubMutationReconciliationProviderClient,
  executeAuthorizedSessionRuntimeGitHubMutation,
  GITHUB_MUTATION_PROVIDER_TIMEOUT_MS,
  GitHubMutationProviderNoEffectError,
  recordSessionRuntimeGitHubMutationFailure,
  SessionRuntimeGitHubMutationConflictError,
} from "../dist/session-runtime-github-mutations.js";
import { loadUnknownProviderEffectReconciliation } from "../dist/provider-effect-receipts.js";

test("allows bounded publication requests to outlive the legacy timeout", () => {
  assert.equal(GITHUB_MUTATION_PROVIDER_TIMEOUT_MS, 240_000);
});

const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const workerId = "acp-worker:primary";
const repository = "anulman/codeops";
const leaseId = "33333333-3333-4333-8333-333333333333";
const admissionId = "77777777-7777-4777-8777-777777777777";

function canonical(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot() {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "session-github-mutation",
    generation: 1,
    state: "running",
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: {
        version: "codeops.session-policy/v1",
        mode: "implement",
        workspaceAccess: "bounded-writes",
        modelCalls: "allowed",
        modelPolicy: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      },
      workspace: {
        version: "codeops.workspace/v1",
        sources: [{
          catalogKey: "codeops",
          repository,
          checkoutPath: "sources/codeops",
          requestedRef: "main",
          resolvedSha: "a".repeat(40),
        }],
        scratchPath: "scratch",
      },
      workflowId: "workspace-launch",
      runId: "launch-github-mutation",
      displayName: "Change CodeOps",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "runtime-worker",
      acquiredAt: "2026-08-14T15:00:00.000Z",
      expiresAt: "2026-08-14T16:00:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 4,
    capabilities: capabilities(),
    updatedAt: "2026-08-14T15:04:00.000Z",
  };
}

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "session-github-mutation",
      generation: 1,
      leaseId,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      type: "prompt",
      prompt: "Rerun the exact failed check.",
    },
    snapshot: snapshot(),
    dispatchedAt: "2026-08-14T15:04:00.000Z",
  };
}

function runtimeRequest() {
  const operation = "check_rerun";
  const input = {
    repository,
    expectedHeadSha: "a".repeat(40),
    checkRunId: 1234,
  };
  return {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation,
    operationId: `githubmutation-${createHash("sha256")
      .update(canonical({ dispatchId, claimToken, operation, input }))
      .digest("hex")}`,
    input,
  };
}

function permission(request = runtimeRequest()) {
  const operation = {
    kind: "github_mutation",
    repository,
    operation: request.operation,
    pullRequestNumber: null,
    expectedHeadSha: request.input.expectedHeadSha,
    targetId: String(request.input.checkRunId),
    payloadJson: canonical(request.input),
  };
  const requestId = `permission-${createHash("sha256")
    .update(canonical(operation))
    .update("\0")
    .update(dispatchId)
    .update("\0")
    .update(request.operationId)
    .digest("hex")}`;
  return {
    version: "codeops.session-runtime-permission-submission/v1",
    claimToken,
    request: {
      requestId,
      title: "Allow check rerun once?",
      description: "One exact mutation.",
      operation,
      operationDigest: digest(canonical(operation)),
      options: [
        { optionId: "allow-once", label: "Allow once" },
        { optionId: "deny", label: "Do not allow it" },
      ],
      requestedAt: "2026-08-14T15:05:00.000Z",
    },
    acpSessionId: "codeops-github",
    toolCallId: request.operationId,
    options: [
      { optionId: "allow-once", acpOptionId: "allow-once" },
      { optionId: "deny", acpOptionId: "deny" },
    ],
  };
}

function decision(permissionSubmission = permission(), decision = {
  outcome: "selected",
  optionId: "allow-once",
}) {
  const command = {
    version: "codeops.session-command/v1",
    sessionId: "session-github-mutation",
    generation: 1,
    leaseId,
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
    type: "respond_permission",
    permissionRequestId: permissionSubmission.request.requestId,
    decision,
  };
  const result = {
    version: "codeops.session-command-result/v1",
    commandId: "66666666-6666-4666-8666-666666666666",
    sessionId: command.sessionId,
    generation: command.generation,
    leaseId: command.leaseId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    eventCursor: 6,
    snapshot: snapshot(),
    committedAt: "2026-08-14T15:06:00.000Z",
    disposition: "committed",
  };
  return { command, result };
}

class Client {
  constructor({ insertCount = 1, permissionValue = permission(), decisionValue, storedMutation = null, dispatchValue = dispatch() } = {}) {
    this.insertCount = insertCount;
    this.permissionValue = permissionValue;
    const selectedDecision = decisionValue ?? decision(permissionValue);
    this.decisionValue = {
      ...selectedDecision,
      result: { ...selectedDecision.result, snapshot: dispatchValue.snapshot },
    };
    this.storedMutation = storedMutation;
    this.dispatchValue = dispatchValue;
    this.calls = [];
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    if (["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT", "ROLLBACK"].includes(text)) {
      return { rowCount: null, rows: [] };
    }
    if (text.includes("SELECT snapshot_json") && text.includes("FROM codeops.sessions")) {
      return { rowCount: 1, rows: [{ snapshot_json: this.decisionValue.result.snapshot }] };
    }
    if (
      text.includes("FROM codeops.session_runtime_outbox AS outbox") &&
      text.includes("JOIN codeops.sessions AS session")
    ) {
      return {
        rowCount: 1,
        rows: [{
          dispatch_json: this.dispatchValue,
          status: "claimed",
          claim_token: claimToken,
          claimed_by: workerId,
          claim_expires_at: "2026-08-14T15:30:00.000Z",
          owner_principal_id: "access:aidan@example.com",
          admission_id: admissionId,
        }],
      };
    }
    if (
      text.includes("FROM codeops.session_runtime_permission_requests AS permission")
    ) {
      return {
        rowCount: 1,
        rows: [{
          request_json: this.permissionValue,
          command_id: this.decisionValue.result.commandId,
          principal_id: this.dispatchValue.principalId,
          command_json: this.decisionValue.command,
          result_json: this.decisionValue.result,
          admission_id: admissionId,
          session_generation: "1",
          session_lease_id: leaseId,
          operation_provider: "github",
          operation_id: this.permissionValue.toolCallId,
        }],
      };
    }
    if (text.includes("FROM codeops.work_item_admissions")) {
      return { rowCount: 1, rows: [{ admission_id: admissionId }] };
    }
    if (text.includes("INSERT INTO codeops.provider_effect_receipts")) {
      return { rowCount: this.insertCount, rows: [] };
    }
    if (text.includes("FROM codeops.provider_effect_receipts")) {
      return {
        rowCount: this.storedMutation ? 1 : 0,
        rows: this.storedMutation ? [this.storedMutation] : [],
      };
    }
    if (text.includes("UPDATE codeops.provider_effect_receipts")) {
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

function trustedDispatch(pullRequestNumber = 94) {
  const trusted = dispatch();
  trusted.snapshot.identity = {
    version: "codeops.temporal-session-identity/v2",
    repository,
    branch: "codeops/trusted-link",
    baseSha: "a".repeat(40),
    workflowId: "coding-trusted-link",
    runId: "agent-trusted-link",
    workItemId: "33333333-3333-4333-8333-333333333333",
    pullRequestNumber,
    pullRequestHeadSha: "a".repeat(40),
    planeWorkItem: {
      version: "codeops.trusted-plane-work-item-reference/v1",
      apiOrigin: "https://plane.example.com/",
      workspaceSlug: "engineering",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectIdentifier: "COAUTO",
      workItemId: "33333333-3333-4333-8333-333333333333",
      sequenceId: 19,
      reference: "COAUTO-19",
    },
    agentRole: "coding",
    round: 1,
    parentSessionId: null,
    forkedAtCursor: null,
  };
  return trusted;
}

function mutationRequest(operation, input) {
  return {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation,
    operationId: `githubmutation-${createHash("sha256")
      .update(canonical({ dispatchId, claimToken, operation, input }))
      .digest("hex")}`,
    input,
  };
}

function exactPermission(request) {
  const pullRequestNumber = [
    "pull_request_update_branch",
    "pull_request_update",
    "review_thread_reply",
  ].includes(request.operation)
    ? request.input.pullRequestNumber
    : null;
  const targetId = request.operation === "pull_request_create"
    ? request.input.headBranch
    : request.operation === "branch_publish"
      ? request.input.branchName
      : request.operation === "review_thread_reply"
        ? request.input.threadId
        : request.operation === "check_rerun"
          ? String(request.input.checkRunId)
          : null;
  const operation = {
    kind: "github_mutation",
    repository,
    operation: request.operation,
    pullRequestNumber,
    expectedHeadSha: request.input.expectedHeadSha,
    targetId,
    payloadJson: canonical(request.input),
  };
  const submission = {
    ...permission(),
    claimToken,
    toolCallId: request.operationId,
    request: {
      ...permission().request,
      requestId: `permission-${createHash("sha256")
        .update(canonical(operation)).update("\0").update(dispatchId)
        .update("\0").update(request.operationId).digest("hex")}`,
      operation,
      operationDigest: digest(canonical(operation)),
    },
  };
  return submission;
}

async function authorizeTrusted(request, pullRequestNumber = 94) {
  const permissionValue = exactPermission(request);
  const client = new Client({
    permissionValue,
    decisionValue: decision(permissionValue),
    dispatchValue: trustedDispatch(pullRequestNumber),
  });
  const authorization = await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId,
    workerId,
    request,
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  return { authorization, client };
}

test("rejects trusted Temporal pull-request number drift before permission", async () => {
  const request = mutationRequest("pull_request_update", {
    repository,
    pullRequestNumber: 95,
    expectedHeadSha: "a".repeat(40),
    expectedBaseSha: "b".repeat(40),
    body: "Update the exact pull request.",
  });
  const permissionValue = exactPermission(request);
  const client = new Client({
    permissionValue,
    decisionValue: decision(permissionValue),
    dispatchValue: trustedDispatch(94),
  });
  await assert.rejects(
    authorizeSessionRuntimeGitHubMutation(client, {
      dispatchId,
      workerId,
      request,
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }),
    /exact Temporal repository, pull request, and head/,
  );
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("rejects pull-request number drift for every numbered mutation", async () => {
  const inputs = [
    ["pull_request_update_branch", {
      repository,
      pullRequestNumber: 95,
      expectedHeadSha: "a".repeat(40),
    }],
    ["review_thread_reply", {
      repository,
      pullRequestNumber: 95,
      expectedHeadSha: "a".repeat(40),
      threadId: "review-thread-1",
      body: "Reply only on the immutable pull request.",
    }],
  ];
  for (const [operation, input] of inputs) {
    const request = mutationRequest(operation, input);
    const permissionValue = exactPermission(request);
    const client = new Client({
      permissionValue,
      decisionValue: decision(permissionValue),
      dispatchValue: trustedDispatch(94),
    });
    await assert.rejects(
      authorizeSessionRuntimeGitHubMutation(client, {
        dispatchId,
        workerId,
        request,
        now: () => new Date("2026-08-14T15:07:00.000Z"),
      }),
      /exact Temporal repository, pull request, and head/,
      operation,
    );
    assert.equal(client.calls.length, 3, operation);
    assert.equal(client.calls.at(-1).text, "ROLLBACK", operation);
  }
});

test("accepts matching and unnumbered trusted Temporal GitHub mutations", async () => {
  const update = mutationRequest("pull_request_update", {
    repository,
    pullRequestNumber: 94,
    expectedHeadSha: "a".repeat(40),
    expectedBaseSha: "b".repeat(40),
    body: "Update the exact pull request.",
  });
  assert.equal((await authorizeTrusted(update)).authorization.disposition, "authorized");

  const create = mutationRequest("pull_request_create", {
    repository,
    expectedHeadSha: "a".repeat(40),
    expectedBaseSha: "b".repeat(40),
    headBranch: "codeops/trusted-link",
    baseBranch: "main",
    title: "Create from the trusted head",
    body: "Create without a mutation pull-request number.",
    draft: true,
  });
  assert.equal((await authorizeTrusted(create)).authorization.disposition, "authorized");

  const check = mutationRequest("check_rerun", {
    repository,
    expectedHeadSha: "a".repeat(40),
    checkRunId: 1234,
  });
  assert.equal((await authorizeTrusted(check)).authorization.disposition, "authorized");

});

test("preserves an older producer payload without rewriting after permission", async () => {
  const input = {
    repository,
    expectedHeadSha: "a".repeat(40),
    expectedBaseSha: "a".repeat(40),
    headBranch: "codeops/trusted-link",
    baseBranch: "main",
    title: "Link the trusted ticket",
    body: "Fixes COAUTO-19 and `COAUTO-19`.",
    draft: true,
  };
  const request = mutationRequest("pull_request_create", input);
  const permissionValue = exactPermission(request);
  const client = new Client({
    permissionValue,
    decisionValue: decision(permissionValue),
    dispatchValue: trustedDispatch(),
  });
  const authorized = await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId,
    workerId,
    request,
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorized.disposition, "authorized");
  assert.equal(
    authorized.request.input.body,
    "Fixes COAUTO-19 and `COAUTO-19`.",
  );
});

test("normalizes inline publication identity and rejects its replay", async () => {
  const input = {
    repository, expectedHeadSha: "a".repeat(40), baseBranch: "main",
    branchName: "codeops/legacy-publication", commitMessage: "Publish  legacy bytes",
    changes: [{ path: "proof.txt", oldText: "before\n", newText: "after\n" }],
  };
  const normalizedRequest = mutationRequest("branch_publish", input);
  const request = {
    ...normalizedRequest,
    input: { ...input, commitMessage: ` \t${input.commitMessage}\n` },
  };
  const permissionValue = exactPermission(normalizedRequest);
  class LegacyClient extends Client {
    constructor() {
      super({ permissionValue, decisionValue: decision(permissionValue) });
      this.manifest = null;
      this.chunks = [];
      this.receipt = null;
      this.receiptInsertions = 0;
      this.reconciliationPayloadDigest = digest(canonical(input));
    }
    async query(text, values = []) {
      if (text.includes("SELECT effect.effect_id") &&
          text.includes("permission.request_json")) {
        this.calls.push({ text, values });
        return { rowCount: 1, rows: [{
          effect_id: request.operationId,
          session_id: "session-github-mutation",
          dispatch_id: dispatchId,
          payload_digest: this.reconciliationPayloadDigest,
          permission_digest: permissionValue.request.operationDigest,
          operation: "branch_publish",
          attempted_at: new Date("2026-08-14T15:08:00.000Z"),
          state: "unknown",
          permission_request_id: permissionValue.request.requestId,
          admission_id: admissionId,
          session_generation: 1,
          session_lease_id: leaseId,
          authorization_expires_at: new Date("2026-08-14T15:30:00.000Z"),
          request_json: permissionValue,
          dispatch_json: dispatch(),
        }] };
      }
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        this.calls.push({ text, values });
        return { rowCount: null, rows: [] };
      }
      if (text.includes("FROM codeops.session_runtime_outbox\n") &&
          text.includes("FOR UPDATE")) {
        this.calls.push({ text, values });
        return { rowCount: 1, rows: [{ dispatch_id: dispatchId }] };
      }
      if (text.includes("INSERT INTO codeops.github_branch_publish_candidate_manifests")) {
        this.calls.push({ text, values });
        this.manifest = {
          manifest_id: values[0], candidate_digest: values[1], candidate_bytes: values[2],
          chunk_count: values[3], dispatch_id: values[4], session_id: values[5],
          owner_principal_id: values[6], repository: values[7], operation: "branch_publish",
          operation_id: values[8], effect_digest: values[9],
          chunk_identities_json: JSON.parse(values[10]),
        };
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM codeops.github_branch_publish_candidate_manifests")) {
        this.calls.push({ text, values });
        return { rowCount: 1, rows: [this.manifest] };
      }
      if (text.includes("COALESCE(SUM(chunk_bytes)")) {
        this.calls.push({ text, values });
        return { rowCount: 1, rows: [{ staged_bytes: 0 }] };
      }
      if (text.includes("SELECT ordinal FROM codeops.github_branch_publish_candidate_chunks")) {
        this.calls.push({ text, values });
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO codeops.github_branch_publish_candidate_chunks")) {
        this.calls.push({ text, values });
        this.chunks.push({ ordinal: values[3], chunk_digest: values[4],
          chunk_bytes: values[5], content: values[6] });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT ordinal, chunk_digest, chunk_bytes, content")) {
        this.calls.push({ text, values });
        return { rowCount: this.chunks.length, rows: this.chunks };
      }
      if (text.includes("SELECT dispatch_id, payload_digest, permission_digest")) {
        this.calls.push({ text, values });
        return { rowCount: this.receipt === null ? 0 : 1,
          rows: this.receipt === null ? [] : [this.receipt] };
      }
      if (text.includes("INSERT INTO codeops.provider_effect_receipts")) {
        this.calls.push({ text, values });
        if (this.receipt !== null) return { rowCount: 0, rows: [] };
        this.receiptInsertions += 1;
        this.receipt = {
          dispatch_id: values[7], payload_digest: values[8],
          permission_digest: values[9], state: "authorized", evidence_json: null,
        };
        return { rowCount: 1, rows: [] };
      }
      return super.query(text, values);
    }
  }
  const client = new LegacyClient();
  const authorization = await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId, workerId, request,
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorization.disposition, "authorized");
  assert.equal("changes" in authorization.request.input, false);
  assert.equal("candidate" in authorization.request.input, true);
  assert.equal(authorization.request.input.commitMessage, input.commitMessage);
  assert.equal(authorization.request.payloadDigest, digest(canonical(input)));
  assert.equal(authorization.request.permissionDigest,
    permissionValue.request.operationDigest);
  assert.equal(client.chunks.length, 1);
  assert.match(client.calls.find(({ text }) => text.includes("candidate_manifests") &&
    text.includes("FOR UPDATE")).text, /FOR UPDATE/);

  const replayResult = {
    version: "codeops.github-branch-publish-result/v1",
    repository,
    operationId: normalizedRequest.operationId,
    baseBranch: input.baseBranch,
    branchName: input.branchName,
    baseSha: input.expectedHeadSha,
    headSha: "b".repeat(40),
    url: "https://github.com/anulman/codeops/tree/codeops%2Flegacy-publication",
  };
  client.receipt = { ...client.receipt, state: "succeeded",
    attempted_at: new Date("2026-08-14T15:08:00.000Z"),
    evidence_json: replayResult };
  assert.deepEqual(await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId, workerId, request: normalizedRequest,
    now: () => new Date("2026-08-14T15:09:00.000Z"),
  }), { disposition: "replayed", result: replayResult });
  assert.equal(client.receiptInsertions, 1);
  assert.equal(client.chunks.length, 1);

  const inFlight = await loadUnknownProviderEffectReconciliation(
    client, request.operationId, "access:aidan@example.com",
  );
  assert.deepEqual(inFlight.request, authorization.request);
  assert.equal(client.chunks.length, 1);

  const preUpgradeClient = new LegacyClient();
  const preUpgrade = await loadUnknownProviderEffectReconciliation(
    preUpgradeClient, request.operationId, "access:aidan@example.com",
  );
  assert.deepEqual(preUpgrade.request, authorization.request);
  assert.equal(preUpgradeClient.chunks.length, 1);

  const tampered = new LegacyClient();
  tampered.reconciliationPayloadDigest = `sha256:${"f".repeat(64)}`;
  await assert.rejects(loadUnknownProviderEffectReconciliation(
    tampered, request.operationId, "access:aidan@example.com",
  ), /digests are inconsistent/);
  assert.equal(tampered.manifest, null);
});

test("consumes one exact durable permission before returning provider authority", async () => {
  const client = new Client();
  const authorization = await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorization.disposition, "authorized");
  const provider = authorization.request;
  assert.equal(provider.operation, "check_rerun");
  assert.equal(provider.input.repository, repository);
  assert.match(provider.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(provider.permissionDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal("claimToken" in provider, false);
  assert.ok(client.calls.some(({ text }) =>
    text.includes("INSERT INTO codeops.provider_effect_receipts")));
  const authorizationQuery = client.calls.find(({ text }) =>
    text.includes("session_runtime_permission_requests AS permission"));
  assert.match(authorizationQuery.text, /permission\.request_id = \$2/);
  assert.equal(authorizationQuery.values[1], permission().request.requestId);

  const result = {
    version: "codeops.github-check-rerun-result/v1",
    repository,
    operationId: provider.operationId,
    headSha: "a".repeat(40),
    checkRunId: 1234,
    accepted: true,
  };
  await beginSessionRuntimeGitHubMutationAttempt(client, {
    request: provider,
    now: () => new Date("2026-08-14T15:07:30.000Z"),
  });
  assert.deepEqual(
    await completeSessionRuntimeGitHubMutation(client, {
      request: provider,
      result,
      now: () => new Date("2026-08-14T15:08:00.000Z"),
    }),
    result,
  );
});

test("rejects denial, payload drift, and reuse before provider authority", async () => {
  const deniedPermission = permission();
  const denied = new Client({
    permissionValue: deniedPermission,
    decisionValue: decision(deniedPermission, { outcome: "denied" }),
  });
  await assert.rejects(
    authorizeSessionRuntimeGitHubMutation(denied, {
      dispatchId,
      workerId,
      request: runtimeRequest(),
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }),
    SessionRuntimeGitHubMutationConflictError,
  );

  const drifted = runtimeRequest();
  drifted.input.checkRunId = 9999;
  await assert.rejects(
    authorizeSessionRuntimeGitHubMutation(new Client(), {
      dispatchId,
      workerId,
      request: drifted,
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }),
    SessionRuntimeGitHubMutationConflictError,
  );

  await assert.rejects(
    authorizeSessionRuntimeGitHubMutation(new Client({ insertCount: 0 }), {
      dispatchId,
      workerId,
      request: runtimeRequest(),
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }),
    /immutable stored identity/,
  );
});

test("replays validated completed and lost-response outcomes without another attempt", async () => {
  const request = runtimeRequest();
  const permissionSubmission = permission(request);
  const operationDigest = permissionSubmission.request.operationDigest;
  const payloadDigest = digest(canonical(request.input));
  const result = {
    version: "codeops.github-check-rerun-result/v1",
    repository,
    operationId: request.operationId,
    headSha: "a".repeat(40),
    checkRunId: 1234,
    accepted: true,
  };
  for (const state of ["succeeded", "reconciled_satisfied"]) {
    const replay = await authorizeSessionRuntimeGitHubMutation(
      new Client({
        insertCount: 0,
        permissionValue: permissionSubmission,
        storedMutation: {
          dispatch_id: dispatchId,
          payload_digest: payloadDigest,
          permission_digest: operationDigest,
          state,
          attempted_at: new Date("2026-08-14T15:06:30.000Z"),
          evidence_json: result,
        },
      }),
      {
        dispatchId,
        workerId,
        request,
        now: () => new Date("2026-08-14T15:07:00.000Z"),
      },
    );
    assert.deepEqual(replay, { disposition: "replayed", result });
  }

  await assert.rejects(
    authorizeSessionRuntimeGitHubMutation(
      new Client({
        insertCount: 0,
        permissionValue: permissionSubmission,
        storedMutation: {
          dispatch_id: dispatchId,
          payload_digest: payloadDigest,
          permission_digest: operationDigest,
          state: "unknown",
          attempted_at: new Date("2026-08-14T15:06:30.000Z"),
          evidence_json: null,
        },
      }),
      {
        dispatchId,
        workerId,
        request,
        now: () => new Date("2026-08-14T15:07:00.000Z"),
      },
    ),
    /outcome is not known/,
  );
});

test("keeps a duplicate authorization in flight until the original provider request completes", async () => {
  const request = runtimeRequest();
  const permissionSubmission = permission(request);
  const payloadDigest = digest(canonical(request.input));
  const attemptedAt = new Date("2026-08-14T15:07:01.000Z");
  const client = new Client({
    insertCount: 0,
    permissionValue: permissionSubmission,
    storedMutation: {
      dispatch_id: dispatchId,
      payload_digest: payloadDigest,
      permission_digest: permissionSubmission.request.operationDigest,
      state: "attempting",
      attempted_at: attemptedAt,
      evidence_json: null,
    },
  });

  await assert.rejects(authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId,
    workerId,
    request,
    now: () => new Date("2026-08-14T15:08:01.000Z"),
  }), /outcome is not known/);
  assert.equal(client.calls.some(({ text }) =>
    text.includes("UPDATE codeops.provider_effect_receipts")), false);

  const provider = (await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request,
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  })).request;
  const result = {
    version: "codeops.github-check-rerun-result/v1",
    repository,
    operationId: request.operationId,
    headSha: request.input.expectedHeadSha,
    checkRunId: request.input.checkRunId,
    accepted: true,
  };
  assert.deepEqual(await completeSessionRuntimeGitHubMutation(client, {
    request: provider,
    result,
    now: () => new Date("2026-08-14T15:11:01.000Z"),
  }), result);
  const completion = client.calls.find(({ text }) =>
    text.includes("SET state = 'succeeded'"));
  assert.ok(completion);
  assert.match(completion.text, /state = 'attempting'/);
});

test("resumes an exact authorization after a crash before the provider attempt", async () => {
  const request = runtimeRequest();
  const permissionSubmission = permission(request);
  const authorization = await authorizeSessionRuntimeGitHubMutation(
    new Client({
      insertCount: 0,
      permissionValue: permissionSubmission,
      storedMutation: {
        dispatch_id: dispatchId,
        payload_digest: digest(canonical(request.input)),
        permission_digest: permissionSubmission.request.operationDigest,
        state: "authorized",
        attempted_at: null,
        evidence_json: null,
      },
    }),
    {
      dispatchId,
      workerId,
      request,
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    },
  );
  assert.equal(authorization.disposition, "authorized");
  assert.equal(authorization.request.operationId, request.operationId);
});

test("calls only the internal mutation route with a distinct provider bearer", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorization.disposition, "authorized");
  const provider = authorization.request;
  const calls = [];
  const mutate = createGitHubMutationProviderClient({
    origin: "http://team-a-codeops-control-gateway:8080",
    token: "github-mutation-provider-token-with-distinct-authority",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        version: "codeops.github-check-rerun-result/v1",
        repository,
        operationId: provider.operationId,
        headSha: "a".repeat(40),
        checkRunId: 1234,
        accepted: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal((await mutate(provider)).accepted, true);
  assert.equal(
    calls[0].url,
    "http://team-a-codeops-control-gateway:8080/v1/repositories/anulman/codeops/github-mutations",
  );
  assert.equal(
    calls[0].init.headers.authorization,
    "Bearer github-mutation-provider-token-with-distinct-authority",
  );
  assert.deepEqual(calls[0].body, provider);
  assert.throws(() => createGitHubMutationProviderClient({
    origin: "https://api.github.com",
    token: "github-mutation-provider-token-with-distinct-authority",
  }));
});

test("bounds the complete mutation provider response body", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  let providerSignal;
  const mutate = createGitHubMutationProviderClient({
    origin: "http://team-a-codeops-control-gateway:8080",
    token: "github-mutation-provider-token-with-distinct-authority",
    timeoutMs: 10,
    fetch: async (_url, init) => {
      providerSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener(
            "abort",
            () => controller.error(init.signal.reason),
            { once: true },
          );
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    mutate(authorization.request),
    (error) => ["AbortError", "TimeoutError"].includes(error?.name),
  );
  assert.equal(providerSignal.aborted, true);
});

test("calls only the internal read-only reconciliation route", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  const calls = [];
  const reconcile = createGitHubMutationReconciliationProviderClient({
    origin: "http://team-a-codeops-control-gateway:8080",
    token: "github-mutation-provider-token-with-distinct-authority",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        version: "codeops.github-mutation-reconciliation-result/v1",
        state: "unknown",
        result: null,
        summary: "Attribution remains ambiguous.",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const attemptedAt = new Date("2026-08-14T15:07:01.000Z");
  assert.equal((await reconcile({ request: authorization.request, attemptedAt })).state, "unknown");
  assert.equal(
    calls[0].url,
    "http://team-a-codeops-control-gateway:8080/v1/repositories/anulman/codeops/github-mutations/reconcile",
  );
  assert.equal(calls[0].body.attemptedAt, attemptedAt.toISOString());
  assert.equal(calls[0].init.headers.authorization, "Bearer github-mutation-provider-token-with-distinct-authority");
});

test("commits attempting before outcomes and never retries unknown effects", async () => {
  const client = new Client();
  const authorization = await authorizeSessionRuntimeGitHubMutation(client, {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorization.disposition, "authorized");
  await beginSessionRuntimeGitHubMutationAttempt(client, {
    request: authorization.request,
    now: () => new Date("2026-08-14T15:07:01.000Z"),
  });
  await recordSessionRuntimeGitHubMutationFailure(client, {
    request: authorization.request,
    outcome: "unknown",
    now: () => new Date("2026-08-14T15:07:02.000Z"),
  });
  const updates = client.calls.filter(({ text }) =>
    text.includes("UPDATE codeops.provider_effect_receipts"));
  assert.match(updates[0].text, /state = 'attempting'/);
  assert.match(updates[1].text, /SET state = \$1/);
  assert.equal(updates[1].values[0], "unknown");
  assert.equal(updates[1].values[2], "inspect_check_attempts");
  assert.equal(updates[1].values[3], null);
});

test("distinguishes a proved no-effect provider response from ambiguity", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  assert.equal(authorization.disposition, "authorized");
  const mutate = createGitHubMutationProviderClient({
    origin: "http://team-a-codeops-control-gateway:8080",
    token: "github-mutation-provider-token-with-distinct-authority",
    fetch: async () => new Response('{"status":"no-effect"}', {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    mutate(authorization.request),
    GitHubMutationProviderNoEffectError,
  );
});

test("does not call the provider when the attempting commit fails", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  let providerCalls = 0;
  const client = new Client();
  const originalQuery = client.query.bind(client);
  client.query = async (text, values) =>
    text.includes("SET state = 'attempting'")
      ? { rowCount: 0, rows: [] }
      : originalQuery(text, values);
  await assert.rejects(
    executeAuthorizedSessionRuntimeGitHubMutation(client, {
      request: authorization.request,
      provider: async () => {
        providerCalls += 1;
        throw new Error("must not run");
      },
    }),
    /lost its active dispatch authority|does not match one authorized effect/,
  );
  assert.equal(providerCalls, 0);
});

test("records unknown when the provider outcome or completion commit is ambiguous", async () => {
  const authorization = await authorizeSessionRuntimeGitHubMutation(new Client(), {
    dispatchId,
    workerId,
    request: runtimeRequest(),
    now: () => new Date("2026-08-14T15:07:00.000Z"),
  });
  const providerFailure = new Client();
  await assert.rejects(
    executeAuthorizedSessionRuntimeGitHubMutation(providerFailure, {
      request: authorization.request,
      provider: async () => { throw new Error("connection reset after write"); },
      now: () => new Date("2026-08-14T15:07:01.000Z"),
    }),
    /connection reset/,
  );
  assert.equal(
    providerFailure.calls.find(({ text }) => text.includes("SET state = $1"))
      .values[0],
    "unknown",
  );

  const completionFailure = new Client();
  const originalQuery = completionFailure.query.bind(completionFailure);
  completionFailure.query = async (text, values) =>
    text.includes("SET state = 'succeeded'")
      ? { rowCount: 0, rows: [] }
      : originalQuery(text, values);
  await assert.rejects(
    executeAuthorizedSessionRuntimeGitHubMutation(completionFailure, {
      request: authorization.request,
      provider: async () => ({
        version: "codeops.github-check-rerun-result/v1",
        repository,
        operationId: authorization.request.operationId,
        headSha: "a".repeat(40),
        checkRunId: 1234,
        accepted: true,
      }),
      now: () => new Date("2026-08-14T15:07:02.000Z"),
    }),
    /completion does not match/,
  );
  assert.equal(
    completionFailure.calls.find(({ text }) => text.includes("SET state = $1"))
      .values[0],
    "unknown",
  );
});

function cleanedBranchPublication(state) {
  const operationId = `githubmutation-${"7".repeat(64)}`;
  const input = {
    repository,
    expectedHeadSha: "a".repeat(40),
    baseBranch: "main",
    branchName: "codeops/replayed-candidate",
    commitMessage: "Publish once",
    candidate: {
      manifestId: `githubcandidate-${"8".repeat(64)}`,
      digest: `sha256:${"9".repeat(64)}`,
      sizeBytes: 128,
      chunkCount: 1,
    },
  };
  const request = {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken, operation: "branch_publish", operationId, input,
  };
  const permissionValue = exactPermission(request);
  const payloadDigest = digest(canonical(input));
  const permissionDigest = permissionValue.request.operationDigest;
  const result = {
    version: "codeops.github-branch-publish-result/v1",
    repository, operationId, baseBranch: input.baseBranch,
    branchName: input.branchName, baseSha: input.expectedHeadSha,
    headSha: "b".repeat(40),
    url: `https://github.com/${repository}/tree/codeops/replayed-candidate`,
  };
  const stored = {
    dispatch_id: dispatchId, payload_digest: payloadDigest,
    permission_digest: permissionDigest, state,
    attempted_at: new Date("2026-08-14T15:06:30.000Z"), evidence_json: result,
  };
  class PostCleanupClient extends Client {
    constructor() {
      super({ insertCount: 0, permissionValue,
        decisionValue: decision(permissionValue), storedMutation: stored });
    }
    async query(text, values = []) {
      if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE" || text === "COMMIT" || text === "ROLLBACK") {
        this.calls.push({ text, values });
        return { rowCount: null, rows: [] };
      }
      return super.query(text, values);
    }
  }
  return { PostCleanupClient, request, result };
}

test("replays successful branch states after candidate chunks are gone", async () => {
  for (const state of ["succeeded", "reconciled_satisfied"]) {
    const { PostCleanupClient, request, result } = cleanedBranchPublication(state);
    const client = new PostCleanupClient();
    assert.deepEqual(await authorizeSessionRuntimeGitHubMutation(client, {
      dispatchId, workerId, request,
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }), { disposition: "replayed", result });
    assert.equal(client.calls.some(({ text }) =>
      text.includes("github_branch_publish_candidate_")), false);
    assert.match(client.calls.find(({ text }) =>
      text.includes("FROM codeops.provider_effect_receipts")).text, /FOR UPDATE/);
  }
});

test("rejects definitive non-success branch states after cleanup without reading chunks", async () => {
  for (const state of ["failed", "reconciled_not_observed", "operator_resolved"]) {
    const { PostCleanupClient, request } = cleanedBranchPublication(state);
    const client = new PostCleanupClient();
    await assert.rejects(authorizeSessionRuntimeGitHubMutation(client, {
      dispatchId, workerId, request,
      now: () => new Date("2026-08-14T15:07:00.000Z"),
    }), (error) => error instanceof SessionRuntimeGitHubMutationConflictError &&
      /definitive non-success/.test(error.message));
    assert.equal(client.calls.some(({ text }) =>
      text.includes("github_branch_publish_candidate_")), false);
  }
});
