import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionRuntimeRequestError,
  serveSessionRuntime,
} from "../dist/session-broker-runtime-http.js";

const token = "r".repeat(32);
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const requestId = "permission-1";
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
  return {
    claims,
    completions,
    permissionSubmissions,
    permissionPolls,
    workItems,
    workItemOperations,
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
