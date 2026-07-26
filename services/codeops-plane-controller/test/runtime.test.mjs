import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  createPlaneWebhookRequestListener,
  createTemporalResearchEnqueuer,
} from "../dist/index.js";

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
