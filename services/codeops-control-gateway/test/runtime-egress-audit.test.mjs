import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recordRuntimeEgressPodObservations,
  workspaceRuntimePodObservations,
} from "../dist/runtime-egress-audit.js";

const identity = {
  sessionId: "ses_0123456789abcdef01234567",
  generation: 1,
  runId: "launch-0123456789abcdef01234567",
  jobName: "workspace-0123456789abcdef01234567",
  observedAt: "2026-08-15T22:10:00.000Z",
};

function pod(uid, podIP, overrides = {}) {
  return {
    metadata: {
      uid,
      labels: { "codeops.example/run-id": identity.runId },
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "Job",
        name: identity.jobName,
        controller: true,
      }],
      ...overrides.metadata,
    },
    status: { podIP, ...overrides.status },
  };
}

test("binds each assigned runtime Pod IP to the exact durable session identity", () => {
  assert.deepEqual(
    workspaceRuntimePodObservations({
      ...identity,
      pods: [pod("pod-b", "10.42.1.9"), pod("pod-a", "10.42.1.8")],
    }),
    [
      { ...identity, podUid: "pod-a", podIp: "10.42.1.8" },
      { ...identity, podUid: "pod-b", podIp: "10.42.1.9" },
    ].map(({ runId: _runId, jobName: _jobName, ...entry }) => entry),
  );
});

test("rejects foreign owners and waits for an assigned Pod IP", () => {
  assert.throws(
    () => workspaceRuntimePodObservations({
      ...identity,
      pods: [pod("pod-a", "10.42.1.8", {
        metadata: { ownerReferences: [{
          apiVersion: "batch/v1",
          kind: "Job",
          name: "other-job",
          controller: true,
        }] },
      })],
    }),
    /owner identity drifted/,
  );
  assert.throws(
    () => workspaceRuntimePodObservations({
      ...identity,
      pods: [pod("pod-a", undefined)],
    }),
    /no assigned network identity/,
  );
});

test("records bounded observations atomically and idempotently", async () => {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  };
  const observations = workspaceRuntimePodObservations({
    ...identity,
    pods: [pod("pod-a", "10.42.1.8")],
  });
  await recordRuntimeEgressPodObservations(client, observations);
  assert.equal(calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(calls[1].text, /ON CONFLICT .* DO NOTHING/);
  assert.deepEqual(calls[1].values, [
    identity.sessionId,
    1,
    "pod-a",
    "10.42.1.8",
    identity.observedAt,
  ]);
  assert.equal(calls.at(-1).text, "COMMIT");
});
