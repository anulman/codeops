import assert from "node:assert/strict";
import test from "node:test";
import {
  listInteractiveRuntimeCandidates,
  attestInteractiveRuntimeRelease,
  listRetainedInteractiveRuntimeJobUids,
  observeInteractiveRuntimeTerminal,
  recordInteractiveRuntimeJobProgress,
  reconcileInteractiveRuntimeTerminal,
} from "../dist/session-runtime-terminal-reconciler.js";
import { kubernetesIdentityLabel } from "../dist/kubernetes.js";

const sessionId = "ses_0123456789abcdef01234567";
const generation = 1;
const runId = "launch-0123456789abcdef01234567";
const leaseId = "698fb182-3365-4a09-84b3-7cd90bfcec72";
const jobName = "workspace-0123456789abcdef01234567";
const jobUid = "22222222-2222-4222-8222-222222222222";
const podUid = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-08-27T12:05:00.000Z";
const requestDigest = `sha256:${"a".repeat(64)}`;
const runtimeRelease = `ghcr.io/example/runtime-worker@sha256:${"c".repeat(64)}`;
const candidate = { sessionId, generation, leaseId, runId, jobName,
  requestDigest };

function capabilities(state) {
  const enabled = state === "running"
    ? ["prompt", "cancel", "checkpoint", "hibernate"]
    : state === "waiting_permission"
      ? ["respond_permission", "cancel", "checkpoint", "hibernate"]
      : state === "hibernated" ? ["archive"] : [];
  return ["prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive"].map((action) => enabled.includes(action)
      ? { action, availability: "enabled" }
      : { action, availability: "disabled", reason: "Unavailable." });
}

function snapshot(overrides = {}) {
  const state = overrides.state ?? "running";
  return {
    version: "codeops.session-snapshot/v1", sessionId, generation, state,
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: { version: "codeops.session-policy/v1", mode: "implement",
        workspaceAccess: "bounded-writes", modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } },
      workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
      workflowId: "workspace-launch", runId, parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: { leaseId, generation, status: "active",
      holderId: `session-job:${sessionId}`,
      acquiredAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T18:00:00.000Z" },
    checkpoint: null, pendingPermission: null, eventCursor: 4,
    capabilities: capabilities(state), updatedAt: "2026-08-27T12:04:00.000Z",
    ...overrides,
  };
}

function hibernatedSnapshot() {
  return snapshot({ state: "hibernated", capabilities: capabilities("hibernated"),
    lease: { leaseId, generation, status: "released",
      releasedAt: "2026-08-27T12:04:00.000Z" } });
}

function job(status = {}, metadata = {}) {
  return { metadata: { name: jobName, uid: jobUid, resourceVersion: "42",
    creationTimestamp: "2026-08-27T11:59:00.000Z",
    labels: { "codeops.example/resource-role": "workspace-runtime",
      "codeops.example/session-id": sessionId, "codeops.example/run-id": runId },
    annotations: { "codeops.example/request-digest": requestDigest,
      "codeops.example/resource-configuration-digest": `sha256:${"d".repeat(64)}`,
      "codeops.example/principal-digest": "b".repeat(64),
      "codeops.example/session-generation": String(generation),
      "codeops.example/session-lease-id": leaseId,
      "codeops.example/session-run-id": runId }, ...metadata }, status };
}

function retainedJob(status = {}, metadata = {}) {
  const retained = job(status, metadata);
  delete retained.metadata.annotations["codeops.example/session-generation"];
  delete retained.metadata.annotations["codeops.example/session-lease-id"];
  delete retained.metadata.annotations["codeops.example/session-run-id"];
  return retained;
}

function pod({ phase = "Failed", reason, uid = podUid, exitCode = 1 } = {}) {
  return { metadata: { name: `${jobName}-${uid.slice(0, 4)}`, uid,
    resourceVersion: "41",
    ownerReferences: [{ kind: "Job", uid: jobUid, controller: true }] },
    spec: { containers: [{ name: "runtime-worker", image: runtimeRelease }] },
    status: { phase, ...(reason ? { reason } : {}),
      containerStatuses: [{ name: "runtime-worker", imageID: `docker-pullable://${runtimeRelease}`, state: { terminated: {
        exitCode, reason: exitCode === 0 ? "Completed" : "Error",
        message: exitCode === 0 ? "done" : "HTTP 409" } } }] } };
}

test("attests the configured immutable runtime against the observed Pod image digest", () => {
  assert.equal(attestInteractiveRuntimeRelease({ pods: [pod()], jobUid,
    configuredRuntimeRelease: runtimeRelease }), runtimeRelease);
  const forged = pod();
  forged.spec.containers[0].image = `ghcr.io/example/runtime-worker@sha256:${"d".repeat(64)}`;
  assert.equal(attestInteractiveRuntimeRelease({ pods: [forged], jobUid,
    configuredRuntimeRelease: runtimeRelease }), null);
  const drifted = pod();
  drifted.status.containerStatuses[0].imageID = `docker-pullable://ghcr.io/example/runtime-worker@sha256:${"e".repeat(64)}`;
  assert.equal(attestInteractiveRuntimeRelease({ pods: [drifted], jobUid,
    configuredRuntimeRelease: runtimeRelease }), null);
});

function observation(type = "failed") {
  const complete = type === "completed";
  return observeInteractiveRuntimeTerminal({ candidate,
    job: job({ conditions: [{ type: complete ? "Complete" : "Failed",
      status: "True", reason: complete ? "Complete" : "BackoffLimitExceeded",
      lastTransitionTime: "2026-08-27T12:04:30.000Z" }] }),
    pods: [pod(complete ? { phase: "Succeeded", exitCode: 0 } : {})], observedAt });
}

test("deletion alone is never cancellation authority", () => {
  assert.equal(observeInteractiveRuntimeTerminal({ candidate,
    job: job({}, { deletionTimestamp: "2026-08-27T12:04:30.000Z" }),
    pods: [], observedAt }), null);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({ conditions: [{ type: "Failed", status: "True", reason: "Cancelled",
      lastTransitionTime: "2026-08-27T12:04:30.000Z" }] }),
    pods: [pod()], observedAt }), /cannot authorize Session cancellation/);
});

test("ambiguous terminal Job and Pod evidence fails closed", () => {
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({ conditions: [
      { type: "Complete", status: "True" },
      { type: "Failed", status: "True" },
    ] }), pods: [], observedAt }), /conditions are ambiguous/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({ conditions: [{ type: "Failed", status: "True" }] }),
    pods: [pod({ reason: "Evicted" })], observedAt }), /evidence conflict/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({}), pods: [pod(), pod({ uid: "44444444-4444-4444-8444-444444444444" })],
    observedAt }), /multiple owned terminal Pods/);
  const eviction = observeInteractiveRuntimeTerminal({ candidate, job: job({}),
    pods: [pod({ reason: "Evicted" })], observedAt });
  assert.equal(eviction.cause.type, "evicted");
});

test("an Evicted Pod conflicts with another owned Running Pod and an active Job", () => {
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({ active: 1 }),
    pods: [pod({ reason: "Evicted" }), pod({ phase: "Running",
      uid: "44444444-4444-4444-8444-444444444444" })],
    observedAt }), /active or additional owned Pods/);
});

test("captures retained legacy Job UIDs once and does not resnapshot on restart", async () => {
  let migrated = false;
  let reads = 0;
  const client = { async query(text) {
    if (text.includes("to_regclass")) {
      return { rowCount: 1, rows: [{ table_name: "codeops.schema_migrations" }] };
    }
    if (text.includes("FROM codeops.schema_migrations")) {
      return { rowCount: migrated ? 1 : 0, rows: migrated ? [{ present: 1 }] : [] };
    }
    if (text.includes("FROM codeops.workspace_launches")) {
      return { rowCount: 1, rows: [{ launch_id: runId,
        request_digest: requestDigest, snapshot_json: snapshot() }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  assert.deepEqual(await listRetainedInteractiveRuntimeJobUids(client,
    async () => { reads += 1; return retainedJob({ active: 1 }); }), [jobUid]);
  migrated = true;
  assert.equal(await listRetainedInteractiveRuntimeJobUids(client,
    async () => { reads += 1; return retainedJob({}, {
      uid: "66666666-6666-4666-8666-666666666666" }); }), undefined);
  assert.equal(reads, 1);
});

test("fair discovery advances a durable cursor and admits released hibernation identity", async () => {
  let cursor = "ses_early";
  const client = { calls: [], async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("SELECT last_session_id")) {
      assert.match(text, /FOR UPDATE/);
      return { rowCount: 1, rows: [{ last_session_id: cursor }] };
    }
    if (text.includes("FROM codeops.workspace_launches")) {
      assert.deepEqual(values, ["ses_early", 100, ["launch-222222222222222222222222"], ["ses_222222222222222222222222"]]);
      assert.match(text, /ORDER BY \(session\.session_id > \$1\) DESC/);
      assert.match(text, /'hibernated'/);
      assert.match(text, /admitted_child_materializations/);
      assert.match(text, /materialization\.state IN \('success-finalizing','ready'\)/);
      assert.match(text, /workspaceRuntime,uid/);
      assert.match(text, /workspaceRuntime,configDigest/);
      assert.match(text, /SELECT session\.launch_id,session\.request_digest,session\.snapshot_json,\s*session\.runtime_uid,session\.runtime_config_digest/);
      return { rowCount: 1, rows: [{ launch_id: runId,
        request_digest: requestDigest,
        snapshot_json: hibernatedSnapshot() }] };
    }
    if (text.includes("UPDATE codeops.session_runtime_reconciliation_scan")) {
      cursor = values[0];
    }
    return { rowCount: 1, rows: [] };
  } };
  assert.deepEqual(await listInteractiveRuntimeCandidates(client), [candidate]);
  assert.equal(cursor, sessionId);
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("admitted terminal evidence retains the persisted runtime UID and configuration digest", () => {
  const runtimeConfigDigest = `sha256:${"c".repeat(64)}`;
  const admittedCandidate = { ...candidate, runtimeUid: jobUid, runtimeConfigDigest };
  const admittedJob = job({ active: 1 }, { labels: {
    "codeops.example/resource-role": "workspace-runtime",
    "codeops.example/session-id": kubernetesIdentityLabel(sessionId),
    "codeops.example/run-id": kubernetesIdentityLabel(runId),
  }, annotations: { ...job().metadata.annotations,
    "codeops.example/resource-configuration-digest": runtimeConfigDigest } });
  assert.equal(observeInteractiveRuntimeTerminal({ candidate: admittedCandidate,
    job: admittedJob, pods: [], observedAt }), null);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate: admittedCandidate,
    job: { ...admittedJob, metadata: { ...admittedJob.metadata,
      uid: "99999999-9999-4999-8999-999999999999" } }, pods: [], observedAt }),
  /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate: admittedCandidate,
    job: { ...admittedJob, metadata: { ...admittedJob.metadata, annotations: {
      ...admittedJob.metadata.annotations,
      "codeops.example/resource-configuration-digest": `sha256:${"d".repeat(64)}`,
    } } }, pods: [], observedAt }), /identity drifted/);
});

test("later Sessions progress beyond a full batch and the durable cursor wraps", async () => {
  const identities = [
    ["ses_001", "launch-000000000000000000000001"],
    ["ses_002", "launch-000000000000000000000002"],
    ["ses_101", "launch-000000000000000000000101"],
  ];
  let cursor = "";
  const row = ([id, launchId]) => ({ launch_id: launchId,
    request_digest: requestDigest,
    snapshot_json: snapshot({ sessionId: id,
      identity: { ...snapshot().identity, runId: launchId } }) });
  const client = { async query(text, values = []) {
    if (text.includes("SELECT last_session_id")) {
      return { rowCount: 1, rows: [{ last_session_id: cursor }] };
    }
    if (text.includes("FROM codeops.workspace_launches")) {
      const ordered = identities.filter(([id]) => id > cursor)
        .concat(identities.filter(([id]) => id <= cursor));
      return { rowCount: Math.min(values[1], ordered.length),
        rows: ordered.slice(0, values[1]).map(row) };
    }
    if (text.includes("UPDATE codeops.session_runtime_reconciliation_scan")) {
      cursor = values[0];
    }
    return { rowCount: 1, rows: [] };
  } };
  assert.deepEqual((await listInteractiveRuntimeCandidates(client, 2))
    .map(({ sessionId }) => sessionId), ["ses_001", "ses_002"]);
  assert.deepEqual((await listInteractiveRuntimeCandidates(client, 2))
    .map(({ sessionId }) => sessionId), ["ses_101", "ses_001"]);
  assert.deepEqual((await listInteractiveRuntimeCandidates(client, 2))
    .map(({ sessionId }) => sessionId), ["ses_002", "ses_101"]);
});

class ReconciliationClient {
  constructor(current, jobProgress = { lease_id: leaseId, run_id: runId,
    job_name: jobName, job_uid: jobUid, job_resource_version: "42",
    resource_configuration_digest: null }) {
    this.current = current;
    this.calls = [];
    this.jobProgress = jobProgress;
    this.terminalObservation = null;
    this.retainedJobUids = new Set([jobUid]);
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM codeops.sessions") && text.includes("FOR UPDATE")) {
      return { rowCount: 1, rows: [{ snapshot_json: this.current }] };
    }
    if (text.includes("SET resource_configuration_digest=NULL")) {
      this.jobProgress.resource_configuration_digest = null;
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("FROM codeops.session_runtime_job_progress")) {
      return { rowCount: this.jobProgress === null ? 0 : 1,
        rows: this.jobProgress === null ? [] : [this.jobProgress] };
    }
    if (text.includes("FROM codeops.session_runtime_legacy_job_allowlist")) {
      return this.retainedJobUids.has(values[0])
        ? { rowCount: 1, rows: [{ job_uid: values[0] }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes("INSERT INTO codeops.session_runtime_job_progress")) {
      this.jobProgress = { lease_id: values[2], run_id: values[3],
        job_name: values[4], job_uid: values[5], job_resource_version: values[6],
        resource_configuration_digest: values[8] };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("FROM codeops.session_runtime_terminal_observations")) {
      return { rowCount: this.terminalObservation === null ? 0 : 1,
        rows: this.terminalObservation === null ? []
          : [{ observation_json: this.terminalObservation }] };
    }
    if (text.startsWith("UPDATE codeops.sessions")) {
      this.current = JSON.parse(values[0]);
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("INSERT INTO codeops.session_runtime_terminal_observations")) {
      this.terminalObservation = JSON.parse(values[6]);
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

test("retained base-shaped failed Job releases the exact active lease once", async () => {
  const failedJob = retainedJob({ conditions: [{ type: "Failed", status: "True",
    reason: "BackoffLimitExceeded",
    lastTransitionTime: "2026-08-27T12:04:30.000Z" }] });
  assert.equal(failedJob.metadata.annotations["codeops.example/request-digest"],
    requestDigest);
  const client = new ReconciliationClient(snapshot(), null);
  assert.equal(await recordInteractiveRuntimeJobProgress(client, {
    candidate, job: failedJob, observedAt }), "registered");
  const retainedObservation = observeInteractiveRuntimeTerminal({ candidate,
    job: failedJob, pods: [pod()], observedAt });
  assert.equal(retainedObservation.cause.message, "HTTP 409");
  assert.equal(await reconcileInteractiveRuntimeTerminal(client,
    retainedObservation), "committed");
  assert.equal(client.current.state, "failed");
  assert.equal(client.current.lease.status, "released");
  assert.equal(client.current.lease.leaseId, leaseId);
  const abandoned = client.calls.find(({ text }) =>
    text.includes("SET state = 'not_attempted'"));
  assert.ok(abandoned);
  assert.match(abandoned.text, /attempted_at IS NULL/);
  assert.deepEqual(abandoned.values, [
    retainedObservation.observedAt, sessionId, generation, leaseId,
  ]);
  assert.equal(await reconcileInteractiveRuntimeTerminal(client,
    retainedObservation), "duplicate");
  assert.equal(client.calls.filter(({ text }) =>
    text.startsWith("UPDATE codeops.sessions")).length, 1);
});

test("first post-upgrade legacy replacement Job UID fails closed", async () => {
  const replacementUid = "66666666-6666-4666-8666-666666666666";
  const client = new ReconciliationClient(snapshot(), null);
  await assert.rejects(recordInteractiveRuntimeJobProgress(client, {
    candidate,
    job: retainedJob({ active: 1 }, {
      uid: replacementUid,
      creationTimestamp: "2026-08-27T12:00:01.000Z",
    }),
    observedAt,
  }), /was not retained at the upgrade/);
  assert.equal(client.jobProgress, null);
  assert.equal(client.calls.some(({ text, values }) =>
    text.includes("INSERT INTO codeops.session_runtime_job_progress") &&
    values.includes(replacementUid)), false);
});

test("retained Job compatibility identity fails closed", () => {
  const partial = retainedJob();
  partial.metadata.annotations["codeops.example/session-generation"] =
    String(generation);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: partial, pods: [], observedAt }), /identity drifted/);
  const mismatchedDigest = retainedJob({}, { annotations: {
    "codeops.example/request-digest": `sha256:${"b".repeat(64)}`,
  } });
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: mismatchedDigest, pods: [], observedAt }), /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: job({}, { annotations: {
      "codeops.example/request-digest": requestDigest,
      "codeops.example/session-generation": String(generation),
      "codeops.example/session-lease-id":
        "55555555-5555-4555-8555-555555555555",
      "codeops.example/session-run-id": runId,
    } }), pods: [], observedAt }), /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({
    candidate: { ...candidate, generation: 2 }, job: retainedJob(), pods: [],
    observedAt }), /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({
    candidate: { ...candidate,
      leaseId: "55555555-5555-4555-8555-555555555555" },
    job: retainedJob(), pods: [], observedAt }), /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: retainedJob({}, { name: `${jobName}-replacement` }), pods: [],
    observedAt }), /identity drifted/);
  assert.throws(() => observeInteractiveRuntimeTerminal({ candidate,
    job: retainedJob({}, { labels: {
      "codeops.example/resource-role": "workspace-runtime",
      "codeops.example/session-id": sessionId,
      "codeops.example/run-id": "launch-ffffffffffffffffffffffff",
    } }), pods: [], observedAt }), /identity drifted/);
});

test("durable Job UID and resource version fencing rejects replacement and reorder", async () => {
  const client = new ReconciliationClient(snapshot(), null);
  assert.equal(await recordInteractiveRuntimeJobProgress(client, {
    candidate, job: retainedJob({ active: 1 }), observedAt }), "registered");
  await assert.rejects(recordInteractiveRuntimeJobProgress(client, {
    candidate, job: retainedJob({ active: 1 }, {
      uid: "66666666-6666-4666-8666-666666666666",
      resourceVersion: "43",
    }), observedAt }), /identity drifted from Kubernetes/);
  assert.equal(await recordInteractiveRuntimeJobProgress(client, {
    candidate, job: retainedJob({ active: 1 }, { resourceVersion: "41" }),
    observedAt }), "stale");
});

test("progress timestamps are strict RFC3339", async () => {
  const client = new ReconciliationClient(snapshot(), null);
  await assert.rejects(recordInteractiveRuntimeJobProgress(client, {
    candidate, job: job({ active: 1 }), observedAt: "2026-08-27 12:05:00Z",
  }), /not RFC3339/);
  await assert.rejects(recordInteractiveRuntimeJobProgress(client, {
    candidate, job: job({ active: 1 }), observedAt: "2026-08-27T12:05:00",
  }), /not RFC3339/);
});

test("hibernated exact released lease reconciles to completion without resurrection", async () => {
  const client = new ReconciliationClient(hibernatedSnapshot());
  assert.equal(await reconcileInteractiveRuntimeTerminal(client, observation("completed")), "committed");
  assert.equal(client.current.state, "completed");
  assert.equal(client.current.lease.status, "released");
  assert.equal(client.current.lease.releasedAt, "2026-08-27T12:04:00.000Z");

  const failed = new ReconciliationClient(hibernatedSnapshot());
  assert.equal(await reconcileInteractiveRuntimeTerminal(failed, observation("failed")), "committed");
  assert.equal(failed.current.state, "failed");

  const cancelled = observation("failed");
  cancelled.cause = { ...cancelled.cause, type: "cancelled", reason: "Cancelled" };
  const rejected = new ReconciliationClient(hibernatedSnapshot());
  assert.equal(await reconcileInteractiveRuntimeTerminal(rejected, cancelled), "stale");

  for (const state of ["completed", "failed", "cancelled", "archived"]) {
    const terminal = snapshot({ state, capabilities: capabilities(state),
      lease: { leaseId, generation, status: "released",
        releasedAt: "2026-08-27T12:04:00.000Z" } });
    const existing = new ReconciliationClient(terminal);
    assert.equal(await reconcileInteractiveRuntimeTerminal(existing, observation()), "already_terminal");
    assert.equal(existing.calls.some(({ text }) => text.startsWith("UPDATE codeops.sessions")), false);
  }
});

test("progress registration preserves active and hibernated lease fencing", async () => {
  for (const current of [snapshot(), hibernatedSnapshot()]) {
    const client = { async query(text) {
      if (text.includes("FROM codeops.sessions")) return { rowCount: 1, rows: [{ snapshot_json: current }] };
      if (text.includes("FROM codeops.session_runtime_job_progress")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    } };
    assert.equal(await recordInteractiveRuntimeJobProgress(client, {
      candidate, job: job({ active: 1 }), observedAt }), "registered");
  }
  const drifted = hibernatedSnapshot();
  drifted.lease = { ...drifted.lease, leaseId: "55555555-5555-4555-8555-555555555555" };
  const client = { async query(text) {
    if (text.includes("FROM codeops.sessions")) return { rowCount: 1, rows: [{ snapshot_json: drifted }] };
    return { rowCount: 1, rows: [] };
  } };
  assert.equal(await recordInteractiveRuntimeJobProgress(client, {
    candidate, job: job({ active: 1 }), observedAt }), "stale");
});

test("preserved incident identities refuse direct progress and retry before SQL", async () => {
  const client = { async query() { assert.fail("preserved identity reached SQL"); } };
  for (const identity of [
    { runId: "launch-222222222222222222222222" },
    { sessionId: "ses_222222222222222222222222" },
  ]) {
    assert.equal(await recordInteractiveRuntimeJobProgress(client, {
      candidate: { ...candidate, ...identity }, job: job(), observedAt,
    }), "stale");
    for (const type of ["failed", "completed"]) {
      assert.equal(await reconcileInteractiveRuntimeTerminal(client, {
        ...observation(type), ...identity,
      }, { configured: runtimeRelease, observed: runtimeRelease }), "stale");
    }
  }
});

test("checkpoint Job binding requires canonical configuration, without blocking legacy terminal observation", async () => {
  const { kubernetesResourceConfigurationDigest } = await import("../dist/kubernetes.js");
  const resource = { ...job(), apiVersion: "batch/v1", kind: "Job",
    metadata: { ...job().metadata, namespace: "checkpoint-test" },
    spec: { template: { metadata: { labels: {} }, spec: { restartPolicy: "Never",
      containers: [{ name: "runtime", image: runtimeRelease }] } } } };
  const digest = kubernetesResourceConfigurationDigest(resource);
  resource.metadata.annotations["codeops.example/resource-configuration-digest"] = digest;
  const client = new ReconciliationClient(snapshot(), null);
  assert.equal(await recordInteractiveRuntimeJobProgress(client, { candidate, job: resource, observedAt }), "registered");
  assert.equal(client.jobProgress.job_uid, jobUid);
  assert.equal(client.jobProgress.resource_configuration_digest, digest);
  const tampered = structuredClone(resource);
  tampered.spec.template.spec.containers[0].image = `example/changed@sha256:${"f".repeat(64)}`;
  assert.equal(await recordInteractiveRuntimeJobProgress(client, { candidate, job: tampered, observedAt }), "advanced");
  assert.equal(client.jobProgress.resource_configuration_digest, null);
  const legacy = new ReconciliationClient(snapshot(), null);
  assert.equal(await recordInteractiveRuntimeJobProgress(legacy, { candidate, job: job(), observedAt }), "registered");
  assert.equal(legacy.jobProgress.resource_configuration_digest, null);
});
