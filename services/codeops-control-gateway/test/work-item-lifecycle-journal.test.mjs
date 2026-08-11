import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalSerialize,
  contractVersions,
  createEventId,
  createTransitionId,
} from "@renoconcierge/codeops-contracts";
import {
  ImmutableLifecycleEventConflictError,
  LifecycleCompareAndSwapError,
  LifecyclePublicationClaimConflictError,
  acknowledgeWorkItemLifecyclePublication,
  appendWorkItemLifecycleEvent,
  claimWorkItemLifecyclePublication,
} from "../dist/work-item-lifecycle-journal.js";

const now = "2026-08-11T04:20:00.000Z";
const sha = "dcbc37dc01803d4105a9d463c0897f8f6a8b76e1";

function lifecycleEvent(overrides = {}) {
  const transitionKey = overrides.transitionKey ?? "lifecycle-ready";
  const transitionId = overrides.transitionId ?? createTransitionId({
    version: contractVersions.workItemLifecycleEvent,
    workflowId: "workflow-123",
    transitionKey,
  });
  return {
    version: contractVersions.workItemLifecycleEvent,
    eventId: createEventId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId: "workflow-123",
      transitionId,
    }),
    transitionId,
    transitionKey,
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
    sourceSha: sha,
    occurredAt: now,
    summary: "The work item is ready.",
    evidence: [],
    ...overrides,
  };
}

class AppendClient {
  constructor({ existingEvent = null, aggregate = null, updateCount = 1 } = {}) {
    this.existingEvent = existingEvent;
    this.aggregate = aggregate;
    this.updateCount = updateCount;
    this.calls = [];
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.work_item_lifecycle_events")) {
      return {
        rowCount: this.existingEvent ? 1 : 0,
        rows: this.existingEvent ? [this.existingEvent] : [],
      };
    }
    if (text.includes("FROM codeops.work_item_lifecycle\n")) {
      return {
        rowCount: this.aggregate ? 1 : 0,
        rows: this.aggregate ? [this.aggregate] : [],
      };
    }
    if (text.startsWith("UPDATE codeops.work_item_lifecycle")) {
      return { rowCount: this.updateCount, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

test("commits the first aggregate revision, immutable event, and relay row together", async () => {
  const client = new AppendClient();
  const event = lifecycleEvent();
  assert.equal(await appendWorkItemLifecycleEvent(client, event), "appended");
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /work_item_lifecycle_events[\s\S]*FOR UPDATE/);
  assert.match(client.calls[2].text, /work_item_lifecycle[\s\S]*FOR UPDATE/);
  assert.ok(client.calls.some(({ text }) => text.includes("INSERT INTO codeops.work_item_lifecycle\n")));
  assert.ok(client.calls.some(({ text }) => text.includes("INSERT INTO codeops.work_item_lifecycle_events")));
  assert.ok(client.calls.some(({ text }) => text.includes("INSERT INTO codeops.work_item_lifecycle_publications")));
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("replays identical event bytes and rejects the same ID with different bytes", async () => {
  const event = lifecycleEvent();
  const digest = createHash("sha256")
    .update(canonicalSerialize(event))
    .digest("hex");
  const replay = new AppendClient({
    existingEvent: { event_digest: digest, event_json: event },
  });
  assert.equal(await appendWorkItemLifecycleEvent(replay, event), "replayed");
  assert.equal(replay.calls.at(-1).text, "COMMIT");
  assert.equal(replay.calls.some(({ text }) => text.includes("INSERT INTO")), false);

  const conflict = new AppendClient({
    existingEvent: { event_digest: "0".repeat(64), event_json: event },
  });
  await assert.rejects(
    appendWorkItemLifecycleEvent(conflict, event),
    ImmutableLifecycleEventConflictError,
  );
  assert.equal(conflict.calls.at(-1).text, "ROLLBACK");
});

test("compares the next event with the exact aggregate state and sequence", async () => {
  const previousState = { phase: "ready", attention: "clear" };
  const transitionId = createTransitionId({
    version: contractVersions.workItemLifecycleEvent,
    workflowId: "workflow-123",
    transitionKey: "lifecycle-start",
  });
  const event = lifecycleEvent({
    transitionId,
    eventId: createEventId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId: "workflow-123",
      transitionId,
    }),
    transitionKey: "lifecycle-start",
    command: "start_work",
    sequence: 2,
    previousState,
    state: { phase: "in_progress", attention: "clear" },
    summary: "Work started.",
  });
  const aggregate = {
    workflow_id: event.workflowId,
    run_id: event.runId,
    phase: previousState.phase,
    attention: previousState.attention,
    sequence: "1",
  };
  const client = new AppendClient({ aggregate });
  assert.equal(await appendWorkItemLifecycleEvent(client, event), "appended");
  assert.ok(client.calls.some(({ text }) => text.startsWith("UPDATE codeops.work_item_lifecycle")));

  const drift = new AppendClient({
    aggregate: { ...aggregate, phase: "in_review" },
  });
  await assert.rejects(
    appendWorkItemLifecycleEvent(drift, event),
    LifecycleCompareAndSwapError,
  );
  assert.equal(drift.calls.at(-1).text, "ROLLBACK");
});

test("claims one pending or expired publication with a fenced relay lease", async () => {
  const event = lifecycleEvent();
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      return {
        rowCount: 1,
        rows: [{
          event_json: event,
          claim_token: values[1],
          claim_expires_at: values[3],
          claim_count: "2",
        }],
      };
    },
  };
  const claim = await claimWorkItemLifecyclePublication(client, {
    claimedBy: "jetstream-relay-1",
    now,
    leaseMs: 30_000,
  });
  assert.equal(claim.event.eventId, event.eventId);
  assert.equal(claim.claimCount, 2);
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/);
  assert.equal(claim.claimExpiresAt, "2026-08-11T04:20:30.000Z");
  assert.match(calls[0].text, /FOR UPDATE OF publication SKIP LOCKED/);
  assert.match(calls[0].text, /claim_expires_at <= \$1::timestamptz/);
  assert.match(calls[0].text, /claim_count = publication\.claim_count \+ 1/);
});

test("acknowledges only the fenced JetStream publication and replays its exact result", async () => {
  const claimToken = "55555555-5555-4555-8555-555555555555";
  const input = {
    eventId: lifecycleEvent().eventId,
    claimToken,
    stream: "CODEOPS_LIFECYCLE",
    streamSequence: 42,
    publishedAt: now,
  };
  const published = {
    async query(text) {
      if (text.startsWith("UPDATE")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  assert.equal(
    await acknowledgeWorkItemLifecyclePublication(published, input),
    "published",
  );

  const duplicate = {
    async query(text) {
      if (text.startsWith("UPDATE")) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          status: "published",
          jetstream_stream: input.stream,
          jetstream_sequence: "42",
        }],
      };
    },
  };
  assert.equal(
    await acknowledgeWorkItemLifecyclePublication(duplicate, input),
    "duplicate",
  );

  const stolen = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };
  await assert.rejects(
    acknowledgeWorkItemLifecyclePublication(stolen, input),
    LifecyclePublicationClaimConflictError,
  );
});
