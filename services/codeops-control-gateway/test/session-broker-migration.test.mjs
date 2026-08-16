import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionBrokerMigration,
  grantLifecycleRelayAccess,
  grantModelProxyLedgerAccess,
  grantSessionRuntimeReceiptAccess,
  migrateSessionBroker,
  lifecycleRelayDatabaseCredentials,
  modelProxyDatabaseCredentials,
  sessionRuntimeDatabaseCredentials,
  stripTransactionEnvelope,
} from "../dist/session-broker-migration.js";

const migration = "BEGIN;\nCREATE TABLE example (id bigint);\nCOMMIT;\n";

function fakeClient(existingSha, roleExists = false) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("SELECT sha256")) {
        return {
          rowCount: existingSha === undefined ? 0 : 1,
          rows: existingSha === undefined ? [] : [{ sha256: existingSha }],
        };
      }
      if (text.includes("FROM pg_catalog.pg_roles")) {
        return {
          rowCount: roleExists ? 1 : 0,
          rows: roleExists ? [{ present: 1 }] : [],
        };
      }
      return { rowCount: null, rows: [] };
    },
  };
}

test("strips only the migration's outer transaction envelope", () => {
  assert.equal(
    stripTransactionEnvelope(migration),
    "CREATE TABLE example (id bigint);",
  );
  assert.throws(() => stripTransactionEnvelope("SELECT 1;"), /BEGIN\/COMMIT/);
});

test("grants the lifecycle relay only claim and acknowledgment access", async () => {
  const client = fakeClient();
  await grantLifecycleRelayAccess(
    client,
    "codeops_lifecycle_relay",
    "relay_password_0123456789abcdefghi",
  );
  const sql = client.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /CREATE ROLE "codeops_lifecycle_relay" LOGIN PASSWORD/);
  assert.match(sql, /GRANT SELECT \(event_id, event_json\) ON codeops\.work_item_lifecycle_events/);
  assert.match(sql, /GRANT SELECT \(event_id, status, available_at, claim_token, claim_expires_at, claim_count, delivery_receipt_digest, delivery_receipt_json\)/);
  assert.match(sql, /GRANT UPDATE \(status, claim_token, claimed_by, claimed_at, claim_expires_at, claim_count, delivery_driver/);
  assert.doesNotMatch(sql, /GRANT (INSERT|DELETE)/);
  assert.doesNotMatch(sql, /session_runtime_execution_receipts TO/);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("serializes and records a first migration in one transaction", async () => {
  const client = fakeClient();
  assert.equal(await applySessionBrokerMigration(client, migration), "applied");
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.match(client.calls[1].text, /pg_advisory_xact_lock/);
  assert.equal(client.calls.at(-1).text, "COMMIT");
  assert.equal(
    client.calls.filter(
      ({ text }) => text === "CREATE TABLE example (id bigint);",
    ).length,
    1,
  );
  const insert = client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.schema_migrations"),
  );
  assert.equal(insert.values[0], "session-broker-v1");
  assert.match(insert.values[1], /^[0-9a-f]{64}$/);
});

test("treats an exact previously applied migration as current", async () => {
  const first = fakeClient();
  await applySessionBrokerMigration(first, migration);
  const digest = first.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.schema_migrations"),
  ).values[1];
  const retry = fakeClient(digest);
  assert.equal(await applySessionBrokerMigration(retry, migration), "current");
  assert.equal(retry.calls.at(-1).text, "COMMIT");
  assert.equal(
    retry.calls.some(
      ({ text }) => text === "CREATE TABLE example (id bigint);",
    ),
    false,
  );
});

test("rolls back when stored migration bytes drift", async () => {
  const client = fakeClient("0".repeat(64));
  await assert.rejects(
    applySessionBrokerMigration(client, migration),
    /migration digest drift/,
  );
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("records a caller-supplied immutable migration identity", async () => {
  const client = fakeClient();
  await applySessionBrokerMigration(
    client,
    migration,
    "session-broker-runtime-outbox-v1",
  );
  const insert = client.calls.find(({ text }) =>
    text.includes("INSERT INTO codeops.schema_migrations"));
  assert.equal(insert.values[0], "session-broker-runtime-outbox-v1");
});

test("applies broker runtime, lifecycle journal, launches, and notifications in order", async () => {
  const client = fakeClient();
  const results = await migrateSessionBroker(client);
  assert.deepEqual(results, [
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
  ]);
  const inserts = client.calls
    .filter(({ text }) => text.includes("INSERT INTO codeops.schema_migrations"))
    .map(({ values }) => values[0]);
  assert.deepEqual(inserts, [
    "session-broker-v1",
    "session-broker-runtime-outbox-v1",
    "session-runtime-execution-receipts-v1",
    "workspace-checkpoint-artifacts-v1",
    "session-job-initialization-v1",
    "session-runtime-permission-relay-v1",
    "session-runtime-github-mutations-v1",
    "session-runtime-github-mutations-request-scoped-v2",
    "work-item-lifecycle-journal-v1",
    "workspace-launch-v1",
    "runtime-egress-pod-observations-v1",
    "session-notifications-v1",
    "session-model-budget-ledger-v2",
    "session-model-budget-ledger-functions-v1",
    "session-model-budget-recovery-v1",
  ]);
});

test("grants the model proxy only fixed ledger function execution", async () => {
  const client = fakeClient();
  await grantModelProxyLedgerAccess(
    client,
    "codeops_model_proxy",
    "proxy_password_0123456789abcdefghi",
  );
  const sql = client.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /CREATE ROLE "codeops_model_proxy" LOGIN PASSWORD/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA codeops/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION codeops\.reserve_session_model_budget/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION codeops\.settle_session_model_budget/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION codeops\.charge_stale_session_model_budget_reservations/);
  assert.doesNotMatch(sql, /GRANT (SELECT|INSERT|UPDATE|DELETE)/);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("grants the runtime role only receipt and checkpoint-artifact access", async () => {
  const client = fakeClient();
  await grantSessionRuntimeReceiptAccess(
    client,
    "agents_session_runtime",
    "runtime_password_0123456789abcdef",
  );
  const sql = client.calls.map(({ text }) => text).join("\n");
  assert.match(sql, /CREATE ROLE "agents_session_runtime" LOGIN PASSWORD 'runtime_password_0123456789abcdef' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA codeops/);
  assert.match(sql, /GRANT SELECT \(dispatch_id, dispatch_digest, status, result_json\)/);
  assert.match(sql, /GRANT INSERT \(dispatch_id, dispatch_digest, status\)/);
  assert.match(sql, /GRANT UPDATE \(status, result_json, completed_at\)/);
  assert.match(sql, /GRANT SELECT \(artifact_id, session_id, generation, checkpoint_id/);
  assert.match(sql, /GRANT INSERT \(artifact_id, session_id, generation, checkpoint_id/);
  assert.doesNotMatch(sql, /session_runtime_outbox/);
  assert.equal(client.calls.at(-1).text, "COMMIT");
  const existing = fakeClient(undefined, true);
  await grantSessionRuntimeReceiptAccess(
    existing,
    "agents_session_runtime",
    "rotated_password_0123456789abcdef",
  );
  const existingSql = existing.calls.map(({ text }) => text).join("\n");
  assert.match(existingSql, /ALTER ROLE "agents_session_runtime" LOGIN PASSWORD 'rotated_password_0123456789abcdef'/);
  assert.doesNotMatch(existingSql, /CREATE ROLE/);
  await assert.rejects(
    grantSessionRuntimeReceiptAccess(
      fakeClient(),
      'unsafe"role',
      "runtime_password_0123456789abcdef",
    ),
    /role is invalid/,
  );
});

test("binds the receipt-only role to one in-cluster runtime database URL", () => {
  assert.deepEqual(
    sessionRuntimeDatabaseCredentials(
      "postgres://agents_session_runtime:runtime_password_0123456789abcdef@qualification-codeops-postgresql:5432/agents",
      "agents_session_runtime",
      "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents?sslmode=disable",
    ),
    {
      role: "agents_session_runtime",
      password: "runtime_password_0123456789abcdef",
    },
  );
  for (const value of [
    "postgres://other:runtime_password_0123456789abcdef@qualification-codeops-postgresql:5432/agents",
    "postgres://agents_session_runtime:runtime_password_0123456789abcdef@example.com:5432/agents",
    "postgres://agents_session_runtime:runtime_password_0123456789abcdef@qualification-codeops-postgresql:5433/agents",
    "postgres://agents_session_runtime:runtime_password_0123456789abcdef@qualification-codeops-postgresql:5432/other",
    "postgres://agents_session_runtime:short@qualification-codeops-postgresql:5432/agents",
  ]) {
    assert.throws(
      () => sessionRuntimeDatabaseCredentials(
        value,
        "agents_session_runtime",
        "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents",
      ),
      /receipt-only boundary|password is invalid/,
    );
  }
});

test("binds the relay-only role to the authoritative database", () => {
  assert.deepEqual(
    lifecycleRelayDatabaseCredentials(
      "postgres://codeops_lifecycle_relay:relay_password_0123456789abcdefghi@qualification-codeops-postgresql:5432/agents",
      "codeops_lifecycle_relay",
      "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents",
    ),
    {
      role: "codeops_lifecycle_relay",
      password: "relay_password_0123456789abcdefghi",
    },
  );
  assert.throws(
    () => lifecycleRelayDatabaseCredentials(
      "postgres://other:relay_password_0123456789abcdefghi@example.com:5432/agents",
      "codeops_lifecycle_relay",
      "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents",
    ),
    /relay-only boundary/,
  );
});

test("binds the ledger-only role to the authoritative database", () => {
  assert.deepEqual(
    modelProxyDatabaseCredentials(
      "postgres://codeops_model_proxy:proxy_password_0123456789abcdefghi@qualification-codeops-postgresql:5432/agents",
      "codeops_model_proxy",
      "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents",
    ),
    {
      role: "codeops_model_proxy",
      password: "proxy_password_0123456789abcdefghi",
    },
  );
  assert.throws(
    () => modelProxyDatabaseCredentials(
      "postgres://other:proxy_password_0123456789abcdefghi@example.com:5432/agents",
      "codeops_model_proxy",
      "postgresql://agents:control_password@qualification-codeops-postgresql:5432/agents",
    ),
    /ledger-only boundary/,
  );
});
