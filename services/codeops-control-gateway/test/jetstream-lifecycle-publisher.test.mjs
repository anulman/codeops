import assert from "node:assert/strict";
import test from "node:test";

import { createJetStreamLifecyclePublisher } from "../dist/jetstream-lifecycle-publisher.js";

test("publishes the lifecycle route with the immutable message ID", async () => {
  const calls = [];
  const publish = createJetStreamLifecyclePublisher({
    async publish(subject, payload, options) {
      calls.push({ subject, payload, options });
      return { stream: "CODEOPS_LIFECYCLE", seq: 42, duplicate: false };
    },
  }, {
    stream: "CODEOPS_LIFECYCLE",
    subject: "codeops.lifecycle.v1.events",
  });
  const payload = new TextEncoder().encode("event");
  const result = await publish({
    route: "codeops.lifecycle.v1.events",
    payload,
    messageId: "event-123",
  });

  assert.deepEqual(calls, [{
    subject: "codeops.lifecycle.v1.events",
    payload,
    options: { msgID: "event-123" },
  }]);
  assert.deepEqual(result, {
    receipt: {
      driver: "jetstream",
      destination: "CODEOPS_LIFECYCLE",
      position: "42",
      metadata: { duplicate: false, subject: "codeops.lifecycle.v1.events" },
    },
  });
});

test("retains the original sequence from a duplicate acknowledgment", async () => {
  const publish = createJetStreamLifecyclePublisher({
    async publish() {
      return { stream: "CODEOPS_LIFECYCLE", seq: 42, duplicate: true };
    },
  }, {
    stream: "CODEOPS_LIFECYCLE",
    subject: "codeops.lifecycle.v1.events",
  });
  const result = await publish({
    route: "codeops.lifecycle.v1.events",
    payload: new Uint8Array(),
    messageId: "event-123",
  });
  assert.equal(result.receipt.position, "42");
  assert.equal(result.receipt.metadata.duplicate, true);
});

test("fails closed on route, stream, subject, or acknowledgment drift", async () => {
  assert.throws(
    () => createJetStreamLifecyclePublisher({ publish: async () => ({}) }, {
      stream: "bad.stream",
      subject: "codeops.lifecycle.v1.events",
    }),
    /stream is invalid/,
  );
  assert.throws(
    () => createJetStreamLifecyclePublisher({ publish: async () => ({}) }, {
      stream: "CODEOPS_LIFECYCLE",
      subject: "codeops.*.events",
    }),
    /subject is invalid/,
  );
  const publish = createJetStreamLifecyclePublisher({
    async publish() {
      return { stream: "OTHER", seq: 1, duplicate: false };
    },
  }, {
    stream: "CODEOPS_LIFECYCLE",
    subject: "codeops.lifecycle.v1.events",
  });
  await assert.rejects(
    publish({ route: "other.v1.events", payload: new Uint8Array(), messageId: "event" }),
    /route is unsupported/,
  );
  await assert.rejects(
    publish({ route: "codeops.lifecycle.v1.events", payload: new Uint8Array(), messageId: "event" }),
    /acknowledgment is invalid/,
  );
});
