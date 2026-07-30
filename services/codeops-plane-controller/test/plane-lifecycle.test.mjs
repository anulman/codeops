import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaneLifecycleClient } from "../dist/index.js";

const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const workItemId = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const reviewStateId = "067b88e5-304b-4221-ba09-94340dcc36e5";
const completeStateId = "77777777-7777-4777-8777-777777777777";
const updatedAt = "2026-07-30T21:00:00.000Z";

function client(fetch, allowedTargetStateIds = [completeStateId]) {
  return createPlaneLifecycleClient({
    baseUrl: "https://plane.example.test",
    workspaceSlug: "codeops",
    apiKey: "plane_api_test-only-key",
    allowedTargetStateIds,
    fetch,
  });
}

test("changes only an allowed state from an exact observed snapshot", async () => {
  const calls = [];
  const lifecycle = client(async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    return new Response(
      JSON.stringify({
        id: workItemId,
        project: projectId,
        state: init.method === "PATCH" ? completeStateId : reviewStateId,
        updated_at:
          init.method === "PATCH" ? "2026-07-30T21:01:00.000Z" : updatedAt,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  assert.equal(
    await lifecycle.transition({
      projectId,
      workItemId,
      expectedStateId: reviewStateId,
      expectedUpdatedAt: updatedAt,
      targetStateId: completeStateId,
    }),
    "updated",
  );
  assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [
    { method: "GET", body: undefined },
    { method: "PATCH", body: { state: completeStateId } },
  ]);
});

test("is idempotent when the target state is already present", async () => {
  let calls = 0;
  const lifecycle = client(async () => {
    calls += 1;
    return Response.json({
      id: workItemId,
      project: projectId,
      state: completeStateId,
      updated_at: "2026-07-30T21:01:00.000Z",
    });
  });
  assert.equal(
    await lifecycle.transition({
      projectId,
      workItemId,
      expectedStateId: reviewStateId,
      expectedUpdatedAt: updatedAt,
      targetStateId: completeStateId,
    }),
    "already-applied",
  );
  assert.equal(calls, 1);
});

test("fails closed on unauthorized targets, stale snapshots, and unconfirmed writes", async () => {
  const snapshot = {
    id: workItemId,
    project: projectId,
    state: reviewStateId,
    updated_at: updatedAt,
  };
  const lifecycle = client(async (_url, init) =>
    Response.json(
      init.method === "PATCH" ? { ...snapshot, state: reviewStateId } : snapshot,
    ),
  );
  await assert.rejects(
    lifecycle.transition({
      projectId,
      workItemId,
      expectedStateId: reviewStateId,
      expectedUpdatedAt: updatedAt,
      targetStateId: "99999999-9999-4999-8999-999999999999",
    }),
    /outside configured authority/,
  );
  await assert.rejects(
    lifecycle.transition({
      projectId,
      workItemId,
      expectedStateId: reviewStateId,
      expectedUpdatedAt: "2026-07-30T20:59:00.000Z",
      targetStateId: completeStateId,
    }),
    /snapshot drifted/,
  );
  await assert.rejects(
    lifecycle.transition({
      projectId,
      workItemId,
      expectedStateId: reviewStateId,
      expectedUpdatedAt: updatedAt,
      targetStateId: completeStateId,
    }),
    /not confirmed/,
  );
});
