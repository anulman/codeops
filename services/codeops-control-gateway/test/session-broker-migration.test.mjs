import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionBrokerMigration,
  grantSessionRuntimeReceiptAccess,
  migrateSessionBroker,
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

test("applies broker runtime, lifecycle journal, and relays in order", async () => {
  const client = fakeClient();
  const results = await migrateSessionBroker(client);
  assert.deepEqual(results, ["applied", "applied", "applied", "applied", "applied", "applied"]);
  const inserts = client.calls
    .filter(({ text }) => text.includes("INSERT INTO codeops.schema_migrations"))
    .map(({ values }) => values[0]);
  assert.deepEqual(inserts, [
    "session-broker-v1",
    "session-broker-runtime-outbox-v1",
    "session-runtime-execution-receipts-v1",
    "session-job-initialization-v1",
    "session-runtime-permission-relay-v1",
    "work-item-lifecycle-journal-v1",
  ]);
});

test("grants the runtime role only execution-receipt access", async () => {
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
