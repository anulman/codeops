import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  createPlaneWebhookRequestListener,
  createGitHubHeadQualifier,
  createGitHubReviewCommentsLoader,
  createGitHubStackLinker,
  createGitHubStackLoader,
  createTemporalCodingEnqueuer,
  createTemporalResearchEnqueuer,
} from "../dist/index.js";

test("reads and links native stacks only through bounded internal capabilities", async () => {
  const stack = {
    version: "codeops.github-pull-request-stack-snapshot/v1",
    repository: "anulman/renoconcierge",
    number: 42,
    baseRef: "main",
    open: true,
    pullRequests: [
      {
        number: 155,
        state: "open",
        draft: true,
        mergedAt: null,
        head: { ref: "feat/base", sha: "a".repeat(40) },
        base: { ref: "main", sha: "0".repeat(40) },
      },
      {
        number: 158,
        state: "open",
        draft: false,
        mergedAt: null,
        head: { ref: "feat/child", sha: "b".repeat(40) },
        base: { ref: "feat/base", sha: "a".repeat(40) },
      },
    ],
  };
  const calls = [];
  const load = createGitHubStackLoader({
    origin: "http://codeops-control-gateway:8080",
    token: "r".repeat(64),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(stack);
    },
  });
  assert.equal((await load(42)).number, 42);
  const link = createGitHubStackLinker({
    origin: "http://codeops-control-gateway:8080",
    token: "p".repeat(64),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(stack);
    },
  });
  assert.equal(
    (
      await link({
        version: "codeops.github-pull-request-stack-link/v1",
        repository: { owner: "anulman", name: "renoconcierge" },
        parent: {
          number: 155,
          headSha: "a".repeat(40),
          headRef: "feat/base",
          baseRef: "main",
        },
        child: {
          number: 158,
          headSha: "b".repeat(40),
          headRef: "feat/child",
          baseRef: "feat/base",
        },
      })
    ).number,
    42,
  );
  assert.equal(
    calls[0].url,
    "http://codeops-control-gateway:8080/v1/pull-request-stacks/42",
  );
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${"p".repeat(64)}`);
});

test("loads review comments only through the bounded internal repository reader", async () => {
  const calls = [];
  const load = createGitHubReviewCommentsLoader({
    origin: "http://codeops-control-gateway:8080",
    token: "r".repeat(64),
    repository: "anulman/renoconcierge",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          version: "codeops.github-review-comments/v1",
          comments: [
            {
              id: 7001,
              body: "Cover this branch.",
              path: "services/codeops-plane-controller/src/github-events.ts",
              line: 42,
              side: "RIGHT",
              createdAt: "2026-07-30T22:45:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(
    (
      await load({
        repository: "anulman/renoconcierge",
        number: 158,
        reviewId: 9001,
      })
    )[0].id,
    7001,
  );
  assert.equal(
    calls[0].url,
    "http://codeops-control-gateway:8080/v1/pull-requests/158/reviews/9001/comments",
  );
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"r".repeat(64)}`);
  await assert.rejects(
    load({
      repository: "other/repository",
      number: 158,
      reviewId: 9001,
    }),
    /outside configured scope/,
  );
});

test("qualifies one exact pull request and head through the bounded internal reader", async () => {
  const calls = [];
  const qualify = createGitHubHeadQualifier({
    origin: "http://codeops-control-gateway:8080",
    token: "r".repeat(64),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          version: "codeops.github-pull-request-qualification/v1",
          pullRequestNumber: 155,
          headSha: "a".repeat(40),
          qualified: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(
    await qualify({
      pullRequestNumber: 155,
      headSha: "a".repeat(40),
    }),
    true,
  );
  assert.equal(
    calls[0].url,
    `http://codeops-control-gateway:8080/v1/pull-requests/155/heads/${"a".repeat(40)}/qualification`,
  );
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"r".repeat(64)}`);
});

const request = {
  version: "codeops.research-request/v2",
  requestId: `research-request:${"a".repeat(64)}`,
  projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
  workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  triggerCommentId: "4797f841-c731-4e55-971f-d9cfe1938dfb",
  requestedBy: "88fc36c8-73b0-4547-81c7-96b70f61835e",
  repository: { owner: "anulman", name: "renoconcierge" },
  baseSha: "8f3d2c033f70be04b4b2dc8a005683806e84e209",
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  personas: ["@ai-security", "@ai-web"],
  brief: "Cross-check the auth boundary and route guards.",
  requestedAt: "2026-07-26T18:50:00.000Z",
};

const codingRequest = {
  version: "codeops.coding-request/v2",
  requestId: "coding-123",
  eventId: "ready-event:123",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId: request.projectId,
  requestedBy: request.requestedBy,
  planeRevisionDigest: request.planeRevisionDigest,
  workItem: {
    version: "codeops.work-item/v1",
    workItemId: request.workItemId,
    workflowId: "coding-123",
    runId: "coding-123",
    repository: request.repository,
    baseSha: request.baseSha,
    branch: "codeops/088a83b9-123456789abc",
    summary: "Implement the admitted auth boundary",
    acceptanceCriteria: ["The route guard is deterministic."],
    secretReferences: [],
    requestedAt: request.requestedAt,
  },
};

test("starts the researcher workflow with the request ID and full bound request", async () => {
  const starts = [];
  const enqueue = createTemporalResearchEnqueuer({
    client: {
      workflow: {
        start: async (...args) => {
          starts.push(args);
          return {};
        },
      },
    },
    taskQueue: "codeops-trial0",
  });
  assert.equal(
    await enqueue({ workflowId: request.requestId, request }),
    "enqueued",
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], "workItemWorkflow");
  assert.equal(starts[0][1].workflowId, request.requestId);
  assert.equal(starts[0][1].workflowIdReusePolicy, "REJECT_DUPLICATE");
  assert.equal(starts[0][1].workflowIdConflictPolicy, "FAIL");
  assert.equal(starts[0][1].workflowRunTimeout, "1 hour");
  assert.equal(starts[0][1].args[0].role, "qa-contract-researcher");
  assert.match(starts[0][1].args[0].summary, /@ai-security, @ai-web/);
  assert.deepEqual(starts[0][1].args[0].researchRequest, request);
});

test("maps only Temporal's already-started error to idempotent success", async () => {
  const enqueue = createTemporalResearchEnqueuer({
    client: {
      workflow: {
        start: async () => {
          throw new WorkflowExecutionAlreadyStartedError(
            "duplicate",
            request.requestId,
            "workItemWorkflow",
          );
        },
      },
    },
    taskQueue: "codeops-trial0",
  });
  assert.equal(
    await enqueue({ workflowId: request.requestId, request }),
    "already-enqueued",
  );

  const failing = createTemporalResearchEnqueuer({
    client: {
      workflow: {
        start: async () => {
          throw new Error("connection refused");
        },
      },
    },
    taskQueue: "codeops-trial0",
  });
  await assert.rejects(
    failing({ workflowId: request.requestId, request }),
    /connection refused/,
  );
});

test("starts coding directly under the human Ready authorization", async () => {
  const starts = [];
  const enqueue = createTemporalCodingEnqueuer({
    client: {
      workflow: {
        start: async (...args) => {
          starts.push(args);
          return {};
        },
      },
    },
    taskQueue: "codeops-trial0",
  });
  assert.equal(
    await enqueue({
      workflowId: codingRequest.workItem.workflowId,
      request: codingRequest,
    }),
    "enqueued",
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], "workItemWorkflow");
  assert.equal(starts[0][1].workflowId, "coding-123");
  assert.equal(starts[0][1].workflowRunTimeout, "24 hours");
  assert.equal(starts[0][1].args[0].role, "coding-agent");
  assert.deepEqual(starts[0][1].args[0].codingRequest, codingRequest);
  await assert.rejects(
    enqueue({ workflowId: "coding-drift", request: codingRequest }),
    /identity/,
  );
});

test("keeps terminal workflow projection internal and contract-bound", async () => {
  const notices = [];
  const token = "t".repeat(64);
  const notice = {
    version: "codeops.workflow-transition-notice/v1",
    workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
    projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
    workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
    workflowId: "coding-123",
    state: "failed",
    sequence: 4,
    summary: "Agent Job dispatch failed closed before workload execution",
  };
  const listener = createPlaneWebhookRequestListener({
    process: async () => ({ status: "ignored" }),
    transitionProjection: {
      token,
      process: async (value) => {
        notices.push(value);
      },
    },
  });
  const server = createServer((incoming, response) => {
    void listener(incoming, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/v1/workflow-transitions`;
    const denied = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"x".repeat(64)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notice),
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notice),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      version: "codeops.workflow-transition-result/v1",
      status: "applied",
      workflowId: "coding-123",
    });
    assert.deepEqual(notices, [notice]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("serves health and preserves the exact raw Plane body and headers", async () => {
  const seen = [];
  const listener = createPlaneWebhookRequestListener({
    process: async (input) => {
      seen.push(input);
      return {
        status: "enqueued",
        requestId: request.requestId,
        duplicate: false,
      };
    },
  });
  const server = createServer((incoming, response) => {
    void listener(incoming, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);

    const rawBody = '{"spacing":  "must survive"}';
    const response = await fetch(`${origin}/webhooks/plane`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plane-Delivery": "delivery",
        "X-Plane-Event": "event",
        "X-Plane-Signature": "signature",
      },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rawBody.toString("utf8"), rawBody);
    assert.deepEqual(seen[0].headers, {
      delivery: "delivery",
      event: "event",
      signature: "signature",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("accepts only signed bounded GitHub pull-request events", async () => {
  const seen = [];
  const secret = "g".repeat(64);
  const body = JSON.stringify({
    action: "closed",
    repository: { full_name: "anulman/renoconcierge" },
    pull_request: {
      number: 158,
      merged: true,
      head: { sha: "a".repeat(40), ref: "feat/a" },
      base: { ref: "main" },
    },
  });
  const signature = `sha256=${createHmac("sha256", secret)
    .update(body)
    .digest("hex")}`;
  const listener = createPlaneWebhookRequestListener({
    process: async () => ({ status: "ignored" }),
    github: {
      secret,
      process: async (event) => seen.push(event),
    },
  });
  const server = createServer((incoming, response) => {
    void listener(incoming, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/webhooks/github`;
    const denied = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "delivery-1",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
      },
      body,
    });
    assert.equal(denied.status, 401);

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "delivery-1",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": signature,
      },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: "accepted" });
    const reviewBody = JSON.stringify({
      action: "submitted",
      repository: { full_name: "anulman/renoconcierge" },
      pull_request: {
        number: 158,
        head: { sha: "b".repeat(40), ref: "feat/reviewed" },
        base: { ref: "main" },
      },
      review: {
        id: 9001,
        body: "Please cover the stale-head case.",
        commit_id: "b".repeat(40),
        state: "changes_requested",
        submitted_at: "2026-07-30T22:45:00.000Z",
        user: { id: 6723643628, login: "anulman", type: "User" },
      },
    });
    const reviewResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "delivery-2",
        "X-GitHub-Event": "pull_request_review",
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret)
          .update(reviewBody)
          .digest("hex")}`,
      },
      body: reviewBody,
    });
    assert.equal(reviewResponse.status, 200);
    assert.deepEqual(seen, [
      {
        delivery: "delivery-1",
        event: {
          kind: "pull_request",
          repository: "anulman/renoconcierge",
          number: 158,
          action: "closed",
          merged: true,
          headSha: "a".repeat(40),
          headRef: "feat/a",
          baseRef: "main",
          stack: null,
        },
      },
      {
        delivery: "delivery-2",
        event: {
          kind: "pull_request_review",
          repository: "anulman/renoconcierge",
          number: 158,
          action: "submitted",
          reviewId: 9001,
          state: "changes_requested",
          body: "Please cover the stale-head case.",
          reviewerId: 6723643628,
          reviewerLogin: "anulman",
          reviewedHeadSha: "b".repeat(40),
          currentHeadSha: "b".repeat(40),
          headRef: "feat/reviewed",
          baseRef: "main",
          stack: null,
          submittedAt: "2026-07-30T22:45:00.000Z",
        },
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("returns retry guidance for busy claims and hides processing failures", async () => {
  const busyListener = createPlaneWebhookRequestListener({
    process: async () => ({
      status: "busy",
      scope: "event",
      leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
    }),
  });
  const failingListener = createPlaneWebhookRequestListener({
    process: async () => {
      throw new Error("sensitive upstream detail");
    },
  });

  for (const [listener, expected] of [
    [busyListener, 409],
    [failingListener, 503],
  ]) {
    const server = createServer((incoming, response) => {
      void listener(incoming, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/webhooks/plane`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Plane-Delivery": "delivery",
            "X-Plane-Event": "event",
            "X-Plane-Signature": "signature",
          },
          body: "{}",
        },
      );
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /sensitive upstream detail/);
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});

test("keeps research projection internal and exact-bearer authenticated", async () => {
  const packets = [];
  const token = "p".repeat(64);
  const listener = createPlaneWebhookRequestListener({
    process: async () => ({ status: "ignored" }),
    projection: {
      token,
      process: async (packet) => {
        packets.push(packet);
        return {
          status: "applied",
          requestId: "research-request-1",
          mutationCount: 1,
        };
      },
    },
  });
  const server = createServer((incoming, response) => {
    void listener(incoming, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/v1/research-packets`;
    const denied = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"x".repeat(64)}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    assert.equal(packets.length, 0);

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: '{"requestId":"research-request-1"}',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      version: "codeops.research-projection-result/v1",
      status: "applied",
      requestId: "research-request-1",
      mutationCount: 1,
    });
    assert.deepEqual(packets, [{ requestId: "research-request-1" }]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
