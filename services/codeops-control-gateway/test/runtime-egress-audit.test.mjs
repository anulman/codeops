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
const runtimeWorkerImage = `ghcr.io/example/runtime-worker@sha256:${"c".repeat(64)}`;

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
    spec: { containers: [{ name: "runtime-worker", image: runtimeWorkerImage }], ...overrides.spec },
    status: { podIP, containerStatuses: [{ name: "runtime-worker",
      imageID: `docker-pullable://${runtimeWorkerImage}` }], ...overrides.status },
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

test("rejects a successor Pod whose observed runtime image differs from stored authority", () => {
  const drifted = pod("pod-a", "10.42.1.8", { status: { containerStatuses: [{
    name: "runtime-worker",
    imageID: `docker-pullable://ghcr.io/example/runtime-worker@sha256:${"d".repeat(64)}`,
  }] } });
  assert.throws(() => workspaceRuntimePodObservations({
    ...identity,
    expectedRuntimeWorkerImage: runtimeWorkerImage,
    pods: [drifted],
  }), /runtime Pod image drifted/);
});

test("waits when a successor Pod has an IP but its startup image is not yet attestable", () => {
  const starting = pod("pod-a", "10.42.1.8", {
    status: {
      phase: "Pending",
      containerStatuses: [{ name: "runtime-worker", state: { waiting: {
        reason: "ContainerCreating",
      } } }],
    },
  });
  assert.throws(() => workspaceRuntimePodObservations({
    ...identity,
    expectedRuntimeWorkerImage: runtimeWorkerImage,
    pods: [starting],
  }), /not yet attestable/);
});

test("fails closed when a terminal successor Pod has no reported image", () => {
  const failed = pod("pod-a", "10.42.1.8", {
    status: {
      phase: "Failed",
      containerStatuses: [{ name: "runtime-worker", state: { terminated: {
        exitCode: 1,
      } } }],
    },
  });
  assert.throws(() => workspaceRuntimePodObservations({
    ...identity,
    expectedRuntimeWorkerImage: runtimeWorkerImage,
    pods: [failed],
  }), /runtime Pod image drifted/);
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
