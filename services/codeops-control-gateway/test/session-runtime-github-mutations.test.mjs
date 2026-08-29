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

test("allows bounded publication requests to outlive the legacy timeout", () => {
  assert.equal(GITHUB_MUTATION_PROVIDER_TIMEOUT_MS, 240_000);
});

const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const workerId = "acp-worker:primary";
const repository = "anulman/codeops";
const leaseId = "33333333-3333-4333-8333-333333333333";

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
      .update(canonical({ dispatchId, operation, input }))
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
    this.decisionValue = decisionValue ?? decision(permissionValue);
    this.storedMutation = storedMutation;
    this.dispatchValue = dispatchValue;
    this.calls = [];
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
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
        }],
      };
    }
    if (
      text.includes("FROM codeops.session_runtime_outbox AS outbox") &&
      text.includes("session_runtime_permission_requests AS permission")
    ) {
      return {
        rowCount: 1,
        rows: [{
          request_json: this.permissionValue,
          command_json: this.decisionValue.command,
          result_json: this.decisionValue.result,
        }],
      };
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
      .update(canonical({ dispatchId, operation, input }))
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
  assert.equal(client.calls.length, 1);
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
    assert.equal(client.calls.length, 1, operation);
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

  const publish = mutationRequest("branch_publish", {
    repository,
    expectedHeadSha: "a".repeat(40),
    baseBranch: "main",
    branchName: "codeops/trusted-link",
    commitMessage: "Publish the trusted branch",
    changes: [{
      path: "bounded.txt",
      oldText: "before\n",
      newText: "after\n",
    }],
  });
  assert.equal((await authorizeTrusted(publish)).authorization.disposition, "authorized");
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

test("replays an exact completed operation without granting provider authority", async () => {
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
  const authorization = await authorizeSessionRuntimeGitHubMutation(
    new Client({
      insertCount: 0,
      permissionValue: permissionSubmission,
      storedMutation: {
        dispatch_id: dispatchId,
        payload_digest: payloadDigest,
        permission_digest: operationDigest,
        state: "succeeded",
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
  assert.deepEqual(authorization, { disposition: "replayed", result });

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

test("resumes the exact authorization when no provider attempt was committed", async () => {
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
    /does not match one authorized effect/,
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

test("requires exact principal-owned successful durable evidence for fast-forward", async () => {
  const operation = "branch_publish";
  const input = {
    repository,
    mode: "fast_forward",
    expectedHeadSha: "a".repeat(40),
    expectedBranchHeadSha: "b".repeat(40),
    expectedBranchHeadEffectId: `githubmutation-${"1".repeat(64)}`,
    baseBranch: "main",
    branchName: "codeops/bootstrap",
    commitMessage: "Continue bootstrap",
    changes: [{ path: "proof.txt", oldText: "", newText: "proved\n" }],
  };
  const request = {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation,
    operationId: `githubmutation-${createHash("sha256").update(canonical({ dispatchId, operation, input })).digest("hex")}`,
    input,
  };
  const permissionOperation = { kind: "github_mutation", repository, operation, pullRequestNumber: null, targetId: input.branchName, expectedHeadSha: input.expectedHeadSha, payloadJson: canonical(input) };
  const requestId = `permission-${createHash("sha256").update(canonical(permissionOperation)).update("\0").update(dispatchId).update("\0").update(request.operationId).digest("hex")}`;
  const permissionValue = {
    ...permission(),
    toolCallId: request.operationId,
    request: { ...permission().request, requestId, operation: permissionOperation, operationDigest: digest(canonical(permissionOperation)) },
  };
  const evidence = {
    effect_id: input.expectedBranchHeadEffectId,
    repository,
    target_id: input.branchName,
    expected_head_sha: "9".repeat(40),
    state: "succeeded",
    attempted_at: "2026-08-14T15:00:00.000Z",
    resolved_at: "2026-08-14T15:01:00.000Z",
    evidence_json: { version: "codeops.github-branch-publish-result/v1", repository, operationId: input.expectedBranchHeadEffectId, baseBranch: input.baseBranch, branchName: input.branchName, baseSha: "9".repeat(40), headSha: input.expectedBranchHeadSha, url: `https://github.com/${repository}/tree/codeops/bootstrap` },
  };
  class EvidenceClient extends Client {
    constructor(prior) { super({ permissionValue }); this.prior = prior; }
    async query(text, values = []) {
      if (text.includes("session.owner_principal_id") && text.includes("effect.effect_id")) {
        this.calls.push({ text, values });
        return { rowCount: this.prior === null ? 0 : 1, rows: this.prior === null ? [] : [this.prior] };
      }
      return super.query(text, values);
    }
  }
  const client = new EvidenceClient(evidence);
  const authorization = { dispatchId, workerId, request, now: () => new Date("2026-08-14T15:07:00.000Z") };
  assert.equal((await authorizeSessionRuntimeGitHubMutation(client, authorization)).disposition, "authorized");
  const query = client.calls.find(({ text }) => text.includes("effect.effect_id"));
  assert.match(query.text, /effect\.state = 'succeeded'/);
  assert.deepEqual(query.values, [input.expectedBranchHeadEffectId, repository, input.branchName, "access:aidan@example.com"]);
  await assert.rejects(authorizeSessionRuntimeGitHubMutation(new EvidenceClient({ ...evidence, state: "reconciled_satisfied" }), authorization), /lacks matching durable branch evidence/);
});
