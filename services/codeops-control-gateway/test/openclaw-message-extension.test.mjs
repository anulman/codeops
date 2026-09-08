import assert from "node:assert/strict";
import test from "node:test";
import { createOpenClawMessageExtension } from "../dist/openclaw-message-extension.js";
import { deliverSupervisorMessage } from "../dist/openclaw-supervisor-adapter.js";
import { parseSupervisorRoutes } from "../dist/agent-messages.js";
import { snapshot, repository, dispatchId, leaseId } from "./agent-message-fixtures.mjs";

const route = parseSupervisorRoutes([{
  id: "primary", version: "v1", repository, projectId: "66666666-6666-4666-8666-666666666666",
  ownerPrincipalId: "operator:example", supervisorPrincipalId: "supervisor:example",
  token: "s".repeat(32), openClawUrl: "https://supervisor.example/codeops/messages",
  sessions: [{ sessionId: snapshot().sessionId, workItemId: snapshot().identity.workItemId }],
}])[0];
const message = {
  version: "codeops.agent-message/v1", messageId: `sha256:${"a".repeat(64)}`,
  threadId: `sha256:${"a".repeat(64)}`, inReplyTo: null,
  scope: { repository, projectId: route.projectId, workItemId: snapshot().identity.workItemId },
  sessionId: snapshot().sessionId, generation: 1, leaseId, dispatchId, claimCount: 1,
  authorityDigest: `sha256:${"b".repeat(64)}`, sourceSha: "c".repeat(40),
  sender: snapshot().sessionId, recipient: route.supervisorPrincipalId,
  routeId: route.id, routeVersion: route.version,
  type: "question", body: "Which API version?", createdAt: "2099-08-15T10:05:00Z",
  state: "persisted", executionAuthority: false,
};
const event = { version: "codeops.openclaw-message-event/v1", message };
const request = (body = event, token = route.token) => new Request(route.openClawUrl, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": message.messageId }, body: JSON.stringify(body),
});

test("extension queues one bounded durable supervisor event across restart and rejects changed bytes", async () => {
  const persisted = new Map();
  const runtime = { async enqueueOnce(input) {
    const prior = persisted.get(input.key);
    if (prior) { assert.equal(prior.payloadDigestInput, input.payloadDigestInput); return "existing"; }
    assert.equal(input.maxTurns, 4); assert.equal(input.timeoutMs, 60_000);
    assert.deepEqual(input.tools, ["messages.inbox", "messages.reply", "messages.acknowledge"]);
    persisted.set(input.key, input); return "persisted";
  } };
  const extension = () => createOpenClawMessageExtension({ route, runtime, operate: async () => ({ messages: [] }) });
  assert.equal((await (await extension().handleEvent(request())).json()).disposition, "persisted");
  assert.equal((await (await extension().handleEvent(request())).json()).disposition, "existing");
  assert.equal(persisted.size, 1);
  const changed = { ...event, message: { ...message, body: "Changed." } };
  assert.equal((await extension().handleEvent(request(changed))).status, 409);
  assert.equal((await extension().handleEvent(request(event, "w".repeat(32)))).status, 401);
  assert.equal((await extension().handleEvent(request({ ...event, message: { ...message, routeVersion: "v2" } }))).status, 409);
});

test("extension tools cannot accept credentials, sender identity or execution grants", async () => {
  let calls = 0;
  const extension = createOpenClawMessageExtension({ route,
    runtime: { enqueueOnce: async () => "persisted" },
    operate: async () => { calls++; return { messages: [] }; },
  });
  await assert.rejects(extension.tools["messages.reply"]({ messageId: message.messageId, idempotencyKey: "answer", body: "v1", token: route.token }));
  assert.equal(calls, 0);
  await extension.tools["messages.inbox"]({}); assert.equal(calls, 1);
});

test("delivery retries immutable ID on ambiguous receipt and never marks a mismatched receipt delivered", async () => {
  for (const response of [
    () => { throw new Error("connection lost after enqueue"); },
    () => Response.json({ version: "codeops.openclaw-message-receipt/v1", messageId: `sha256:${"f".repeat(64)}`, routeId: route.id, routeVersion: route.version, disposition: "persisted" }),
  ]) {
    const writes = [];
    const db = { async query(sql, values) {
      if (sql.includes("SELECT * FROM codeops.agent_messages")) return { rows: [{ message_json: message, attempt_count: 0 }], rowCount: 1 };
      if (sql.includes("FROM codeops.work_item_admissions")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT snapshot_json")) return { rows: [{ snapshot_json: snapshot(), owner_principal_id: route.ownerPrincipalId }], rowCount: 1 };
      if (sql.includes("UPDATE")) writes.push({ sql, values });
      return { rows: [], rowCount: 1 };
    } };
    await deliverSupervisorMessage(db, route, async (_url, options) => {
      assert.equal(options.headers["idempotency-key"], message.messageId);
      assert.equal(options.redirect, "error");
      return response();
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /available_at/);
    assert.doesNotMatch(writes[0].sql, /delivered_at/);
    assert.deepEqual(writes[0].values, [message.messageId, 1, 5000]);
  }
});
