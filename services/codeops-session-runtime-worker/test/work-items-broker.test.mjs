import assert from "node:assert/strict";
import test from "node:test";
import { WorkItemsBroker } from "../dist/work-items-broker.js";

const dispatch = {
  dispatchId: "11111111-1111-4111-8111-111111111111",
  command: { type: "prompt" },
};
const result = {
  version: "codeops.work-item-create-result/v1",
  provider: "plane",
  operationId: "workitem-result",
  repository: "anulman/codeops",
  workItemId: "22222222-2222-4222-8222-222222222222",
  disposition: "created",
};

test("triage creation uses the active prompt without a permission request", async () => {
  const broker = new WorkItemsBroker();
  const port = await broker.listen(0);
  let permissionCalls = 0;
  try {
    await broker.run(dispatch, {
      async requestPermission() { permissionCalls += 1; throw new Error("unexpected"); },
      async createWorkItem(input) { return { ...result, operationId: input.operationId }; },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository: "anulman/codeops",
          title: "Triage this",
          description: "Review this proposed task.",
        }),
      });
      assert.equal(response.status, 200);
      assert.match((await response.json()).operationId, /^workitem-[0-9a-f]{64}$/);
    });
    assert.equal(permissionCalls, 0);
  } finally {
    await broker.close();
  }
});

test("direct creation stops when durable permission is denied", async () => {
  const broker = new WorkItemsBroker();
  const port = await broker.listen(0);
  let createCalls = 0;
  try {
    await broker.run(dispatch, {
      async requestPermission() { return { outcome: "denied" }; },
      async createWorkItem() { createCalls += 1; return result; },
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository: "anulman/codeops",
          mode: "direct",
          title: "Create this",
          description: "Create this task now.",
        }),
      });
      assert.equal(response.status, 403);
    });
    assert.equal(createCalls, 0);
  } finally {
    await broker.close();
  }
});

test("reads without permission and gates every mutation on one durable decision", async () => {
  const broker = new WorkItemsBroker();
  const port = await broker.listen(0);
  const permissions = [];
  const calls = [];
  const workItemId = "22222222-2222-4222-8222-222222222222";
  const relatedWorkItemId = "33333333-3333-4333-8333-333333333333";
  const cases = [
    ["get", { repository: "anulman/codeops", workItemId }],
    ["search", { repository: "anulman/codeops", query: "provider" }],
    ["comment", { repository: "anulman/codeops", workItemId, body: "Validated." }],
    ["update", {
      repository: "anulman/codeops",
      workItemId,
      expectedRevision: `sha256:${"a".repeat(64)}`,
      title: "Updated",
    }],
    ["relate", {
      repository: "anulman/codeops",
      workItemId,
      relatedWorkItemId,
      relation: "relates_to",
    }],
  ];
  try {
    await broker.run(dispatch, {
      async requestPermission(input) {
        permissions.push(input.request);
        return { outcome: "selected", acpOptionId: "allow-once" };
      },
      async getWorkItem(input) { calls.push(["get", input]); return { ok: true }; },
      async searchWorkItems(input) { calls.push(["search", input]); return { ok: true }; },
      async commentWorkItem(input) { calls.push(["comment", input]); return { ok: true }; },
      async updateWorkItem(input) { calls.push(["update", input]); return { ok: true }; },
      async relateWorkItem(input) { calls.push(["relate", input]); return { ok: true }; },
    }, async () => {
      for (const [operation, body] of cases) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/work-items/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
      }
    });
    assert.deepEqual(calls.map(([operation]) => operation), [
      "get", "search", "comment", "update", "relate",
    ]);
    assert.equal(permissions.length, 3);
    assert.match(permissions[0].title, /^Comment work item/);
    assert.match(permissions[1].title, /^Update work item/);
    assert.match(permissions[2].title, /^Relate work item/);
    assert.deepEqual(permissions.map(({ operation }) => ({
      action: operation.operation,
      target: operation.targetWorkItemId,
      payload: JSON.parse(operation.payloadJson),
    })), cases.slice(2).map(([action, payload]) => ({
      action,
      target: payload.workItemId,
      payload,
    })));
    assert.ok(permissions.every(({ operationDigest }) =>
      /^sha256:[0-9a-f]{64}$/.test(operationDigest)));
    assert.ok(calls.every(([, input]) => /^workitem-[0-9a-f]{64}$/.test(input.operationId)));
  } finally {
    await broker.close();
  }
});
