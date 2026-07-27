import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaneApiClient } from "../dist/index.js";

const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const workItemId = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const apiKey = "plane_api_test-only-key";

function jsonResponse(value, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    if (call.url.endsWith(`/work-items/${workItemId}/`)) {
      return jsonResponse({
        id: workItemId,
        project: projectId,
        labels: [],
        name: "Source ticket",
        description_html: "<p>Source.</p>",
      });
    }
    if (call.url.includes(`/projects/${projectId}/work-items/?`)) {
      return jsonResponse({
        results: [
          {
            id: workItemId,
            project: projectId,
            labels: [],
            name: "Source ticket",
            description_html: "<p>Source.</p>",
          },
        ],
      });
    }
    if (
      call.method === "POST" &&
      call.url.endsWith(`/projects/${projectId}/work-items/`)
    ) {
      return jsonResponse(
        {
          id: "77777777-7777-4777-8777-777777777777",
          project: projectId,
          labels: [],
          name: call.body.name,
          description_html: call.body.description_html,
        },
        201,
      );
    }
    if (call.url.endsWith(`/projects/${projectId}/`)) {
      return jsonResponse({ id: projectId, name: "Onboarding Auth QA" });
    }
    if (call.url.endsWith(`/work-items/${workItemId}/relations/`)) {
      return jsonResponse({
        blocking: [],
        blocked_by: [],
        duplicate: [],
        relates_to: [],
        start_after: [],
        start_before: [],
        finish_after: [],
        finish_before: [],
      });
    }
    if (call.url.includes("/comments/")) {
      if (call.method === "GET") {
        return jsonResponse({
          results: [
            {
              id: "4933ed92-5aac-43da-b87d-c439ea2eb957",
              external_source: null,
              external_id: null,
            },
          ],
        });
      }
      return jsonResponse(
        {
          id: "f3e29f26-708d-40f0-9209-7e0de44abc49",
          external_source: call.body.external_source,
          external_id: call.body.external_id,
        },
        201,
      );
    }
    return jsonResponse(undefined, 204);
  };
  return { calls, fetch };
}

test("maps the content-only client to Plane work-item endpoints", async () => {
  const recorder = recordingFetch();
  const client = createPlaneApiClient({
    baseUrl: "https://plane.example.test",
    workspaceSlug: "codeops",
    apiKey,
    fetch: recorder.fetch,
  });

  assert.equal((await client.getWorkItem(projectId, workItemId)).id, workItemId);
  assert.equal(
    (await client.getWorkItemSnapshot(projectId, workItemId)).id,
    workItemId,
  );
  assert.equal((await client.getProjectSnapshot(projectId)).id, projectId);
  assert.equal(
    (await client.getWorkItemComments(projectId, workItemId)).length,
    1,
  );
  assert.deepEqual(
    await client.getWorkItemRelations(projectId, workItemId),
    {
      blocking: [],
      blocked_by: [],
      duplicate: [],
      relates_to: [],
      start_after: [],
      start_before: [],
      finish_after: [],
      finish_before: [],
    },
  );
  assert.equal((await client.listProjectWorkItems(projectId)).length, 1);
  assert.equal(
    (
      await client.createWorkItem(projectId, {
        name: "Bound OTP verification attempts",
        description_html: "<p>Evidence-backed task.</p>",
      })
    ).project,
    projectId,
  );
  await client.createComment(projectId, workItemId, {
    comment_html: "<p>Research complete.</p>",
    external_source: "codeops",
    external_id: "deterministic-id",
  });
  await client.updateWorkItem(projectId, workItemId, {
    description_html: "<p>Clarified auth flow.</p>",
  });

  assert.ok(
    recorder.calls.every(
      (call) =>
        call.url.startsWith(
          "https://plane.example.test/api/v1/workspaces/codeops/projects/",
        ) && call.headers["x-api-key"] === apiKey,
    ),
  );
  assert.ok(
    recorder.calls.some(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith(`/work-items/${workItemId}/comments/`) &&
        call.body.access === "INTERNAL" &&
        call.body.external_id === "deterministic-id",
    ),
  );
  assert.equal(
    recorder.calls.some((call) =>
      Object.prototype.hasOwnProperty.call(call.body ?? {}, "state"),
    ),
    false,
  );
});

test("fails closed on unsafe origins, lifecycle fields, and API failures", async () => {
  assert.throws(
    () =>
      createPlaneApiClient({
        baseUrl: "http://plane.example.test",
        workspaceSlug: "codeops",
        apiKey,
      }),
    /HTTPS origin/,
  );

  const recorder = recordingFetch();
  const client = createPlaneApiClient({
    baseUrl: "https://plane.example.test",
    workspaceSlug: "codeops",
    apiKey,
    fetch: recorder.fetch,
  });
  await assert.rejects(
    client.updateWorkItem(projectId, workItemId, {
      state: "067b88e5-304b-4221-ba09-94340dcc36e5",
    }),
    /lifecycle field/,
  );
  assert.deepEqual(recorder.calls, []);

  const failing = createPlaneApiClient({
    baseUrl: "https://plane.example.test",
    workspaceSlug: "codeops",
    apiKey,
    fetch: async () => new Response("secret-shaped upstream text", { status: 403 }),
  });
  await assert.rejects(
    failing.getWorkItem(projectId, workItemId),
    /failed with 403/,
  );
});

test("reconciles a previously created external comment before retrying POST", async () => {
  const calls = [];
  const commentId = "f3e29f26-708d-40f0-9209-7e0de44abc49";
  const client = createPlaneApiClient({
    baseUrl: "https://plane.example.test",
    workspaceSlug: "codeops",
    apiKey,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return jsonResponse({
        results: [
          {
            id: commentId,
            external_source: "codeops",
            external_id: "deterministic-id",
          },
        ],
      });
    },
  });
  assert.equal(
    (
      await client.createComment(projectId, workItemId, {
        comment_html: "<p>Research complete.</p>",
        external_source: "codeops",
        external_id: "deterministic-id",
      })
    ).id,
    commentId,
  );
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});
