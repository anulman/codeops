import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSerialize,
  contractVersions,
  createEventId,
  createTransitionId,
} from "@codeops/codeops-contracts";
import {
  WORK_ITEM_LIFECYCLE_ROUTE,
  relayOneWorkItemLifecycleEvent,
} from "../dist/work-item-lifecycle-relay.js";

const firstNow = "2026-08-11T04:20:00.000Z";
const secondNow = "2026-08-11T04:20:01.000Z";

function lifecycleEvent() {
  const transitionId = createTransitionId({
    version: contractVersions.workItemLifecycleEvent,
    workflowId: "workflow-123",
    transitionKey: "lifecycle-ready",
  });
  return {
    version: contractVersions.workItemLifecycleEvent,
    eventId: createEventId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId: "workflow-123",
      transitionId,
    }),
    transitionId,
    transitionKey: "lifecycle-ready",
    command: "register",
    repository: { owner: "anulman", name: "codeops" },
    provider: {
      kind: "plane",
      workspaceId: "workspace_123",
      projectId: "project_456",
    },
    workItemId: "work_item_789",
    workflowId: "workflow-123",
    runId: "run-123",
    sequence: 1,
    previousState: null,
    state: { phase: "ready", attention: "clear" },
    sourceSha: "dcbc37dc01803d4105a9d463c0897f8f6a8b76e1",
    occurredAt: firstNow,
    summary: "The work item is ready.",
    evidence: [],
  };
}

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

test("publishes canonical event bytes with the immutable event ID and fences the database acknowledgment", async () => {
  const event = lifecycleEvent();
  const calls = [];
  const result = await relayOneWorkItemLifecycleEvent({
    async claim(input) {
      calls.push({ type: "claim", input });
      return {
        event,
        claimToken: "55555555-5555-4555-8555-555555555555",
        claimExpiresAt: "2026-08-11T04:20:30.000Z",
        claimCount: 1,
        isAdmittedInitialDispatch: false,
      };
    },
    async publish(input) {
      calls.push({ type: "publish", input });
      return {
        receipt: {
          driver: "jetstream",
          destination: "CODEOPS_LIFECYCLE",
          position: "42",
          metadata: { duplicate: false },
        },
      };
    },
    async acknowledge(input) {
      calls.push({ type: "acknowledge", input });
      return "published";
    },
  }, {
    relayId: "jetstream-relay-1",
    leaseMs: 30_000,
    now: clock(firstNow, secondNow),
  });

  assert.deepEqual(result, {
    status: "published",
    eventId: event.eventId,
    receipt: {
      driver: "jetstream",
      destination: "CODEOPS_LIFECYCLE",
      position: "42",
      metadata: { duplicate: false },
    },
    journalResult: "published",
  });
  assert.deepEqual(calls[0].input, {
    claimedBy: "jetstream-relay-1",
    now: firstNow,
    leaseMs: 30_000,
  });
  assert.equal(calls[1].input.route, WORK_ITEM_LIFECYCLE_ROUTE);
  assert.equal(calls[1].input.messageId, event.eventId);
  assert.equal(new TextDecoder().decode(calls[1].input.payload), canonicalSerialize(event));
  assert.deepEqual(calls[2].input, {
    eventId: event.eventId,
    claimToken: "55555555-5555-4555-8555-555555555555",
    receipt: {
      driver: "jetstream",
      destination: "CODEOPS_LIFECYCLE",
      position: "42",
      metadata: { duplicate: false },
    },
    publishedAt: secondNow,
  });
});

test("does not acknowledge when the JetStream publish fails", async () => {
  let acknowledged = false;
  await assert.rejects(
    relayOneWorkItemLifecycleEvent({
      async claim() {
        return {
          event: lifecycleEvent(),
          claimToken: "55555555-5555-4555-8555-555555555555",
          claimExpiresAt: "2026-08-11T04:20:30.000Z",
          claimCount: 1,
          isAdmittedInitialDispatch: false,
        };
      },
      async publish() { throw new Error("publish unavailable"); },
      async acknowledge() { acknowledged = true; return "published"; },
    }, {
      relayId: "jetstream-relay-1",
      leaseMs: 30_000,
      now: () => new Date(firstNow),
    }),
    /publish unavailable/,
  );
  assert.equal(acknowledged, false);
});

test("accepts JetStream deduplication after crash recovery and records the original stream sequence", async () => {
  const event = lifecycleEvent();
  const result = await relayOneWorkItemLifecycleEvent({
    async claim() {
      return {
        event,
        claimToken: "66666666-6666-4666-8666-666666666666",
        claimExpiresAt: "2026-08-11T04:21:30.000Z",
        claimCount: 2,
        isAdmittedInitialDispatch: false,
      };
    },
    async publish() {
      return {
        receipt: {
          driver: "jetstream",
          destination: "CODEOPS_LIFECYCLE",
          position: "42",
          metadata: { duplicate: true },
        },
      };
    },
    async acknowledge(input) {
      assert.equal(input.receipt.position, "42");
      return "published";
    },
  }, {
    relayId: "jetstream-relay-2",
    leaseMs: 30_000,
    now: () => new Date(secondNow),
  });
  assert.equal(result.receipt.metadata.duplicate, true);
  assert.equal(result.journalResult, "published");
});

test("returns idle without publishing when no committed event is claimable", async () => {
  let published = false;
  const result = await relayOneWorkItemLifecycleEvent({
    async claim() { return null; },
    async publish() { published = true; throw new Error("unexpected publish"); },
    async acknowledge() { throw new Error("unexpected acknowledgment"); },
  }, {
    relayId: "jetstream-relay-1",
    leaseMs: 30_000,
    now: () => new Date(firstNow),
  });
  assert.deepEqual(result, { status: "idle" });
  assert.equal(published, false);
});
