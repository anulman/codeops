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
