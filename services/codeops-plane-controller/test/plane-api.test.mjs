import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaneApiClient } from "../dist/index.js";

const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const workItemId = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const labelId = "a6f8e562-49d2-4c19-bc4b-2bcb9d4f6a03";
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
      return jsonResponse({ id: workItemId, project: projectId, labels: [] });
    }
    if (call.url.endsWith(`/projects/${projectId}/`)) {
      return jsonResponse({ id: projectId, name: "Onboarding Auth QA" });
    }
    if (call.url.includes("/labels/")) {
      if (call.method === "GET") {
        return jsonResponse({
          results: [
            {
              id: labelId,
              name: "Auth",
              color: "#334455",
              description: "[codeops-key:auth]",
            },
          ],
          next_page_results: false,
        });
      }
      return jsonResponse({
        id: labelId,
        name: call.body.name,
        color: call.body.color,
        description: call.body.description,
      });
    }
    if (call.url.endsWith("/comments/")) {
      return jsonResponse({ id: "f3e29f26-708d-40f0-9209-7e0de44abc49" }, 201);
    }
    if (call.method === "POST" && call.url.endsWith("/work-items/")) {
      return jsonResponse(
        { id: workItemId, project: projectId, labels: call.body.labels ?? [] },
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
  assert.equal((await client.listLabels(projectId))[0].id, labelId);
  await client.createComment(projectId, workItemId, {
    comment_html: "<p>Research complete.</p>",
    external_source: "codeops",
    external_id: "deterministic-id",
  });
  await client.updateProject(projectId, {
    description: "Project contract.",
  });
  await client.updateWorkItem(projectId, workItemId, {
    name: "Clarify auth flow",
    labels: [labelId],
  });
  await client.createWorkItem(projectId, {
    name: "Follow-up",
    labels: [labelId],
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
