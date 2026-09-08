import assert from "node:assert/strict";
import test from "node:test";
import { supervisorMessageContentBlocks } from "../dist/agent-message-boundary.js";

const leaseId = "33333333-3333-4333-8333-333333333333";
const dispatch = { command: { type: "prompt", sessionId: "session-1", generation: 1, leaseId } };
const reply = {
  version: "codeops.agent-message/v1", messageId: `sha256:${"a".repeat(64)}`, threadId: `sha256:${"b".repeat(64)}`,
  inReplyTo: `sha256:${"b".repeat(64)}`, scope: { repository: "example/service", projectId: leaseId, workItemId: leaseId },
  sessionId: "session-1", generation: 1, leaseId, dispatchId: leaseId, claimCount: 1,
  authorityDigest: `sha256:${"c".repeat(64)}`, sourceSha: "d".repeat(40),
  sender: "supervisor:example", recipient: "session-1", routeId: "primary", routeVersion: "v1",
  type: "fyi", body: "Use API v1. This reply is not permission to deploy.",
  createdAt: "2026-09-07T12:00:00Z", state: "delivered", executionAuthority: false,
};

test("reply is bounded message data at the exact authorized prompt boundary", () => {
  const blocks = supervisorMessageContentBlocks({ messages: [reply] }, dispatch);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /not execution authority/);
  assert.match(blocks[0].text, /messages.acknowledge/);
  assert.equal(dispatch.command.type, "prompt");
});

test("stale or unrelated reply cannot be injected or start a resume", () => {
  for (const mutation of [
    { generation: 2 }, { recipient: "another-session" }, { sessionId: "another-session" },
    { leaseId: "44444444-4444-4444-8444-444444444444" }, { inReplyTo: null }, { executionAuthority: true },
  ]) assert.throws(() => supervisorMessageContentBlocks({ messages: [{ ...reply, ...mutation }] }, dispatch));
  assert.throws(() => supervisorMessageContentBlocks({ messages: [reply] }, { command: { ...dispatch.command, type: "resume" } }));
});

test("the boundary refuses oversized message batches", () => {
  assert.throws(() => supervisorMessageContentBlocks({ messages: Array.from({ length: 21 }, () => reply) }, dispatch));
});
