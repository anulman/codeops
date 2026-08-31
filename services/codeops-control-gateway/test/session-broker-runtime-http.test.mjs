import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionRuntimeRequestError,
  serveSessionRuntime,
} from "../dist/session-broker-runtime-http.js";
import { WorkItemAdmissionConflictError, WorkItemAdmissionDuplicateError } from "../dist/work-item-admission.js";
import {
  ClaimedDispatchAuthorityConflictError,
  ClaimedDispatchAuthorityNotFoundError,
} from "../dist/claimed-dispatch-authority.js";
import {
  GitHubBranchCandidateConflictError,
  GitHubBranchCandidateInvalidRequestError,
  GitHubBranchCandidateNotFoundError,
} from "../dist/github-branch-publish-candidates.js";
import { SessionRuntimeGitHubMutationConflictError } from "../dist/session-runtime-github-mutations.js";

const token = "r".repeat(32);
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const requestId = "permission-1";

function admissionBody() {
  return { version: "codeops.work-item-admission/v1",
    admissionId: "11111111-1111-4111-8111-111111111111", claimToken,
    plan: { planId: "approved-plan", planDigest: `sha256:${"a".repeat(64)}`, permissionRequestId: "approve-plan" },
    workItem: { repository: "example-org/example-repository", provider: { kind: "plane",
      workspaceId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333" },
      workItemId: "66666666-6666-4666-8666-666666666666", workflowId: "workflow", runId: "run",
      sourceSha: "b".repeat(40), title: "Admit work", prompt: "Implement only this work item." },
    child: { sessionId: "session-child", leaseId: "77777777-7777-4777-8777-777777777777",
      holderId: "runtime-worker:child", dispatchId: "88888888-8888-4888-8888-888888888888",
      idempotencyKey: "99999999-9999-4999-8999-999999999999" } };
}

function admissionRoute(body, admitWorkItem) {
  return serveSessionRuntime({ method: "POST",
    url: `/v1/session-runtime/dispatches/${dispatchId}/work-item-admissions`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, token,
    workerId: "runtime-worker:parent", readBody: async () => body,
    claim: async () => null, complete: async () => ({}), submitPermission: async () => ({}), pollPermission: async () => ({}),
    admitWorkItem,
  });
}

test("routes one bounded work-item admission without a provider effect", async () => {
  const admissions = [];
  const body = admissionBody();
  const result = await admissionRoute(body, async (input) => {
    admissions.push(input);
    return { version: "codeops.work-item-admission-result/v1", admissionId: body.admissionId,
      disposition: "created", parentSessionId: "session-parent", childSessionId: body.child.sessionId,
      dispatchId: body.child.dispatchId, lifecycleEventId: `event:${"c".repeat(64)}`,
      supervisionEventId: `sha256:${"d".repeat(64)}` };
  });
  assert.equal(result.status, 200);
  assert.deepEqual(admissions, [{ dispatchId, workerId: "runtime-worker:parent", request: body }]);
});

test("maps only the duplicate admission error to public HTTP 409", async () => {
  const body = admissionBody();
  assert.deepEqual(await admissionRoute(body, async () => {
    throw new WorkItemAdmissionDuplicateError("duplicate admission");
  }), { status: 409, body: { status: "conflict" } });
  const authorityDrift = new WorkItemAdmissionConflictError("authority drift");
  await assert.rejects(admissionRoute(body, async () => { throw authorityDrift; }),
    (error) => error === authorityDrift);
  for (const code of ["40001", "40P01", "08006"]) {
    const failure = Object.assign(new Error("database failure"), { code });
    await assert.rejects(admissionRoute(body, async () => { throw failure; }),
      (error) => error === failure && !(error instanceof WorkItemAdmissionConflictError));
  }
});

const candidateOperationId = `githubmutation-${"a".repeat(64)}`;
const candidateManifestId = `githubcandidate-${"b".repeat(64)}`;
const candidateDigest = `sha256:${"c".repeat(64)}`;
const candidateChunkDigest = `sha256:${"d".repeat(64)}`;

function candidateRoute(kind, failure) {
  const manifest = {
    version: "codeops.github-branch-publish-candidate-manifest-request/v1",
    claimToken,
    operationId: candidateOperationId,
    effectDigest: `sha256:${"e".repeat(64)}`,
    repository: "example-org/example-repository",
    candidate: {
      manifestId: candidateManifestId,
      digest: candidateDigest,
      sizeBytes: 1,
      chunkCount: 1,
    },
    chunks: [{ ordinal: 0, digest: candidateChunkDigest, sizeBytes: 1 }],
  };
  const chunk = {
    version: "codeops.github-branch-publish-candidate-chunk-request/v1",
    claimToken,
    operationId: candidateOperationId,
    manifestId: candidateManifestId,
    ordinal: 0,
    digest: candidateChunkDigest,
    bytesBase64: "eA==",
  };
  return serveSessionRuntime({
    method: "POST",
    url: `/v1/session-runtime/dispatches/${dispatchId}/github-branch-candidates/${kind === "manifest" ? "manifests" : "chunks/0"}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    token,
    workerId: "runtime-worker:candidate",
    readBody: async () => kind === "manifest" ? manifest : chunk,
    claim: async () => null,
    complete: async () => ({}),
    submitPermission: async () => ({}),
    pollPermission: async () => ({}),
    createGitHubBranchCandidateManifest: async () => { throw failure; },
    storeGitHubBranchCandidateChunk: async () => { throw failure; },
  });
}

test("maps deterministic candidate staging failures without retry classification", async () => {
  const cases = [
    ["manifest", new GitHubBranchCandidateInvalidRequestError("invalid manifest"), 400, "invalid-request"],
    ["chunk", new GitHubBranchCandidateInvalidRequestError("invalid chunk"), 400, "invalid-request"],
    ["manifest", new ClaimedDispatchAuthorityNotFoundError("missing dispatch"), 404, "not-found"],
    ["chunk", new GitHubBranchCandidateNotFoundError("missing manifest"), 404, "not-found"],
    ["manifest", new ClaimedDispatchAuthorityConflictError("stale claim"), 409, "conflict"],
    ["chunk", new GitHubBranchCandidateConflictError("conflicting duplicate"), 409, "conflict"],
  ];
  for (const [kind, failure, status, bodyStatus] of cases) {
    assert.deepEqual(await candidateRoute(kind, failure), {
      status,
      body: { status: bodyStatus },
    });
  }
  const infrastructure = Object.assign(new Error("database unavailable"), {
    code: "08006",
  });
  await assert.rejects(candidateRoute("manifest", infrastructure),
    (error) => error === infrastructure);
});

test("maps a definitive GitHub mutation conflict to typed HTTP 409", async () => {
  const githubMutation = {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation: "branch_publish",
    operationId: candidateOperationId,
    input: {
      repository: "example-org/example-repository",
      expectedHeadSha: "a".repeat(40),
      baseBranch: "main",
      branchName: "codeops/post-cleanup-conflict",
      commitMessage: "Do not retry a definitive outcome",
      candidate: {
        manifestId: candidateManifestId,
        digest: candidateDigest,
        sizeBytes: 1,
        chunkCount: 1,
      },
    },
  };
  const result = await serveSessionRuntime({
    method: "POST",
    url: `/v1/session-runtime/dispatches/${dispatchId}/github-mutations`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    token,
    workerId: "runtime-worker:candidate",
    readBody: async () => githubMutation,
    claim: async () => null,
    complete: async () => ({}),
    submitPermission: async () => ({}),
    pollPermission: async () => ({}),
    mutateGitHub: async () => {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation has a definitive non-success outcome",
      );
    },
  });
  assert.deepEqual(result, { status: 409, body: { status: "conflict" } });
});
const authority = {
  sessionId: "ses_91a4",
  generation: 3,
  leaseId: "11111111-1111-4111-8111-111111111111",
  identity: {
    repository: "example-org/example-repository",
    branch: "feat/agents-ui",
    baseSha: "a".repeat(40),
    workflowId: "workflow-155",
    runId: "run-155",
    parentSessionId: null,
    forkedAtCursor: null,
  },
};

function completion(overrides = {}) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    observedEventCursor: 184,
    type: "prompt",
    material: {
      response: "I updated the focused implementation and verified the result.",
      stopReason: "end_turn",
    },
    completedAt: "2026-08-04T19:05:00.000Z",
    ...overrides,
  };
}

function request(overrides = {}) {
  const claims = [];
  const completions = [];
  const permissionSubmissions = [];
  const permissionPolls = [];
  const workItems = [];
  const workItemOperations = [];
  const githubReads = [];
  const githubMutations = [];
  return {
    claims,
    completions,
    permissionSubmissions,
    permissionPolls,
    workItems,
    workItemOperations,
    githubReads,
    githubMutations,
    promise: serveSessionRuntime({
      method: "POST",
      url: "/v1/session-runtime/claims",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      token,
      workerId: "acp-worker:primary",
      readBody: async () => ({
        version: "codeops.session-runtime-claim-request/v1",
        ...authority,
        leaseMs: 300_000,
      }),
      claim: async (input) => {
        claims.push(input);
        return null;
      },
      complete: async (input) => {
        completions.push(input);
        return { disposition: "committed" };
      },
      submitPermission: async (input) => {
        permissionSubmissions.push(input);
        return {
          version: "codeops.session-runtime-permission-result/v1",
          dispatchId,
          requestId,
          disposition: "pending",
          decision: null,
        };
      },
      pollPermission: async (input) => {
        permissionPolls.push(input);
        return {
          version: "codeops.session-runtime-permission-result/v1",
          dispatchId,
          requestId,
          disposition: "decided",
          decision: { outcome: "denied" },
        };
      },
      createWorkItem: async (input) => {
        workItems.push(input);
        return {
          version: "codeops.work-item-create-result/v1",
          provider: "plane",
          operationId: "workitem-123",
          repository: "example-org/example-repository",
          workItemId: "77777777-7777-4777-8777-777777777777",
          disposition: "created",
        };
      },
      getWorkItem: async (input) => {
        workItemOperations.push({ operation: "get", input });
        return { operation: "get" };
      },
      searchWorkItems: async (input) => {
        workItemOperations.push({ operation: "search", input });
        return { operation: "search" };
      },
      commentWorkItem: async (input) => {
        workItemOperations.push({ operation: "comment", input });
        return { operation: "comment" };
      },
      updateWorkItem: async (input) => {
        workItemOperations.push({ operation: "update", input });
        return { operation: "update" };
      },
      relateWorkItem: async (input) => {
        workItemOperations.push({ operation: "relate", input });
        return { operation: "relate" };
      },
      readGitHub: async (input) => {
        githubReads.push(input);
        return {
          version: "codeops.github-search-result/v1",
          repository: "example-org/example-repository",
          kind: "issues",
          query: "runtime",
          items: [],
          truncated: false,
        };
      },
      mutateGitHub: async (input) => {
        githubMutations.push(input);
        return {
          version: "codeops.github-check-rerun-result/v1",
          repository: "example-org/example-repository",
          operationId: input.request.operationId,
          headSha: "a".repeat(40),
          checkRunId: input.request.input.checkRunId,
          accepted: true,
        };
      },
      ...overrides,
    }),
  };
}

test("authenticates one server-bound worker before claiming", async () => {
  const submitted = request();
  assert.deepEqual(await submitted.promise, {
    status: 200,
    body: {
      version: "codeops.session-runtime-claim-response/v1",
      claim: null,
    },
  });
  assert.deepEqual(submitted.claims, [
    { workerId: "acp-worker:primary", ...authority, leaseMs: 300_000 },
  ]);

  const unauthorized = request({ headers: {} });
  assert.deepEqual(await unauthorized.promise, {
    status: 401,
    body: { status: "unauthorized" },
  });
  assert.equal(unauthorized.claims.length, 0);
});

test("binds a completion to the path, claim, and authenticated worker", async () => {
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/completions`,
    readBody: async () => ({
      version: "codeops.session-runtime-completion-request/v1",
      claimToken,
      completion: completion(),
    }),
  });
  assert.deepEqual(await submitted.promise, {
    status: 200,
    body: { disposition: "committed" },
  });
  assert.deepEqual(submitted.completions, [
    {
      dispatchId,
      claimToken,
      workerId: "acp-worker:primary",
      completion: completion(),
    },
  ]);
});

test("binds permission submission and polling to the claimed dispatch", async () => {
  const submission = {
    version: "codeops.session-runtime-permission-submission/v1",
    claimToken,
    request: {
      requestId,
      title: "Allow write?",
      description: "The agent wants to update one file.",
      operation: { kind: "command", command: "npm test", cwd: "/workspace" },
      operationDigest: `sha256:${"a".repeat(64)}`,
      options: [{ optionId: "allow-once", label: "Allow once" }],
      requestedAt: "2026-08-04T19:04:00.000Z",
    },
    acpSessionId: "acp-session-1",
    toolCallId: "tool-call-1",
    options: [{ optionId: "allow-once", acpOptionId: "opaque-allow-once" }],
  };
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/permissions`,
    readBody: async () => submission,
  });
  assert.equal((await submitted.promise).body.disposition, "pending");
  assert.deepEqual(submitted.permissionSubmissions, [{
    dispatchId,
    workerId: "acp-worker:primary",
    submission,
  }]);

  const poll = {
    version: "codeops.session-runtime-permission-poll/v1",
    claimToken,
    requestId,
  };
  const polled = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/permissions/${requestId}/poll`,
    readBody: async () => poll,
  });
  assert.equal((await polled.promise).body.disposition, "decided");
  assert.deepEqual(polled.permissionPolls, [{
    dispatchId,
    workerId: "acp-worker:primary",
    poll,
  }]);
});

test("binds work-item creation to the claimed dispatch and authenticated worker", async () => {
  const createRequest = {
    version: "codeops.session-runtime-work-item-create-request/v1",
    claimToken,
    operationId: "workitem-123",
    input: {
      repository: "example-org/example-repository",
      mode: "triage",
      title: "Create one task",
      description: "Create one provider-neutral task.",
    },
  };
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/work-items`,
    readBody: async () => createRequest,
  });
  assert.equal((await submitted.promise).body.workItemId, "77777777-7777-4777-8777-777777777777");
  assert.deepEqual(submitted.workItems, [{
    dispatchId,
    workerId: "acp-worker:primary",
    request: createRequest,
  }]);
});

test("binds one GitHub read to its exact runtime route and worker", async () => {
  const githubRead = {
    version: "codeops.session-runtime-github-read-request/v1",
    claimToken,
    operation: "search",
    operationId: `githubread-${"a".repeat(64)}`,
    input: {
      repository: "example-org/example-repository",
      kind: "issues",
      query: "runtime",
      limit: 5,
    },
  };
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/github-reads`,
    readBody: async () => githubRead,
  });
  assert.equal((await submitted.promise).body.version, "codeops.github-search-result/v1");
  assert.deepEqual(submitted.githubReads, [{
    dispatchId,
    workerId: "acp-worker:primary",
    request: githubRead,
  }]);
});

test("binds one GitHub mutation to its exact runtime route and worker", async () => {
  const githubMutation = {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation: "check_rerun",
    operationId: `githubmutation-${"a".repeat(64)}`,
    input: {
      repository: "example-org/example-repository",
      expectedHeadSha: "a".repeat(40),
      checkRunId: 1234,
    },
  };
  const submitted = request({
    url: `/v1/session-runtime/dispatches/${dispatchId}/github-mutations`,
    readBody: async () => githubMutation,
  });
  assert.equal(
    (await submitted.promise).body.version,
    "codeops.github-check-rerun-result/v1",
  );
  assert.deepEqual(submitted.githubMutations, [{
    dispatchId,
    workerId: "acp-worker:primary",
    request: githubMutation,
  }]);
});

test("binds every work-item operation to its exact runtime route", async () => {
  const workItemId = "77777777-7777-4777-8777-777777777777";
  const relatedWorkItemId = "88888888-8888-4888-8888-888888888888";
  const cases = [
    ["get", { repository: "example-org/example-repository", workItemId }],
    ["search", { repository: "example-org/example-repository", query: "runtime route", limit: 5 }],
    ["comment", { repository: "example-org/example-repository", workItemId, body: "Verified." }],
    ["update", {
      repository: "example-org/example-repository",
      workItemId,
      expectedRevision: `sha256:${"a".repeat(64)}`,
      title: "Updated",
    }],
    ["relate", {
      repository: "example-org/example-repository",
      workItemId,
      relatedWorkItemId,
      relation: "relates_to",
    }],
  ];
  for (const [operation, input] of cases) {
    const operationId = `workitem-${operation}`;
    const runtimeRequest = {
      version: `codeops.session-runtime-work-item-${operation}-request/v1`,
      claimToken,
      operationId,
      input,
    };
    const submitted = request({
      url: `/v1/session-runtime/dispatches/${dispatchId}/work-items/${operation}`,
      readBody: async () => runtimeRequest,
    });
    assert.deepEqual(await submitted.promise, {
      status: 200,
      body: { operation },
    });
    assert.deepEqual(submitted.workItemOperations, [{
      operation,
      input: {
        dispatchId,
        workerId: "acp-worker:primary",
        request: runtimeRequest,
      },
    }]);
  }
});

test("rejects ambiguous or drifting runtime requests before persistence", async () => {
  for (const submitted of [
    request({ url: "/v1/session-runtime/claims?limit=1" }),
    request({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
    }),
    request({
      url: `/v1/session-runtime/dispatches/${dispatchId}/permissions/${requestId}/poll`,
      readBody: async () => ({
        version: "codeops.session-runtime-permission-poll/v1",
        claimToken,
        requestId: "different-request",
      }),
    }),
    request({
      readBody: async () => ({
        version: "codeops.session-runtime-claim-request/v1",
        ...authority,
        leaseMs: 999,
      }),
    }),
    request({
      readBody: async () => {
        throw new SyntaxError("invalid JSON");
      },
    }),
    request({
      url: `/v1/session-runtime/dispatches/${dispatchId}/completions`,
      readBody: async () => ({
        version: "codeops.session-runtime-completion-request/v1",
        claimToken,
        completion: completion({
          dispatchId: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    }),
  ]) {
    await assert.rejects(submitted.promise, InvalidSessionRuntimeRequestError);
    assert.equal(submitted.claims.length, 0);
    assert.equal(submitted.completions.length, 0);
  }
});

test("ignores unrelated methods and paths", async () => {
  assert.equal(await request({ method: "GET" }).promise, null);
  assert.equal(await request({ url: "/v1/sessions" }).promise, null);
});
