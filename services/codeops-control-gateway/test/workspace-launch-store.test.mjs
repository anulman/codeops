import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresWorkspaceLaunchStore } from "../dist/workspace-launch-store.js";
import { WorkspaceLaunchQuotaError } from "../dist/workspace-launch.js";

const policy = {
  version: "codeops.session-policy/v1",
  mode: "implement",
  workspaceAccess: "bounded-writes",
  modelCalls: "allowed",
  modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
};

function sharedDatabase() {
  const state = { launches: [], tail: Promise.resolve() };
  return {
    state,
    client() {
      let release = () => {};
      return {
        async query(text, values = []) {
          if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE") return { rows: [], rowCount: 0 };
          if (text.includes("pg_advisory_xact_lock")) {
            const previous = state.tail;
            state.tail = new Promise((resolve) => { release = resolve; });
            await previous;
            return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
          }
          if (text.includes("WHERE principal_id = $1 AND idempotency_key = $2")) {
            const existing = state.launches.find(
              (launch) => launch.principalId === values[0] && launch.idempotencyKey === values[1],
            );
            return { rows: existing ? [{ launch_json: existing }] : [], rowCount: existing ? 1 : 0 };
          }
          if (text.includes("principal_count")) {
            const active = state.launches.filter(({ state: launchState }) =>
              launchState === "queued" || launchState === "provisioning");
            return {
              rows: [{
                principal_count: String(active.filter(({ principalId }) => principalId === values[0]).length),
                global_count: String(active.length),
              }],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO codeops.workspace_launches")) {
            const launch = JSON.parse(values[5]);
            state.launches.push(launch);
            return { rows: [{ launch_json: launch }], rowCount: 1 };
          }
          if (text === "COMMIT" || text === "ROLLBACK") {
            release();
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected query: ${text}`);
        },
      };
    },
  };
}

function admission(index, principalId) {
  const id = index.toString(16).padStart(24, "0");
  const uuid = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
  const occurredAt = "2026-08-13T12:00:00.000Z";
  return {
    launch: {
      version: "codeops.workspace-launch/v1",
      launchId: `launch-${id}`,
      idempotencyKey: uuid,
      principalId,
      requestDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
      policy,
      promptDigest: `sha256:${(index + 100).toString(16).padStart(64, "0")}`,
      workspace: { version: "codeops.workspace/v1", sources: [], scratchPath: "scratch" },
      state: "queued",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      deadlineAt: "2026-08-13T18:00:00.000Z",
      attemptCount: 0,
    },
    request: {
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: uuid,
      mode: "implement",
      prompt: `Prompt ${index}`,
      sources: [],
    },
    maximumActivePerPrincipal: 2,
    maximumActiveGlobal: 8,
  };
}

test("serializes concurrent quota admission across database clients", async () => {
  const database = sharedDatabase();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      createPostgresWorkspaceLaunchStore(database.client()).admit(
        admission(index + 1, `principal-${index}@example.com`),
      )),
  );
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 8);
  assert.equal(
    results.filter(
      (result) => result.status === "rejected" && result.reason instanceof WorkspaceLaunchQuotaError,
    ).length,
    2,
  );
  assert.equal(database.state.launches.length, 8);
});

test("serializes the per-principal quota under parallel requests", async () => {
  const database = sharedDatabase();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      createPostgresWorkspaceLaunchStore(database.client()).admit(
        admission(index + 1, "same-principal@example.com"),
      )),
  );
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 2);
  assert.equal(database.state.launches.length, 2);
});
