import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionBrokerMigration,
  stripTransactionEnvelope,
} from "../dist/session-broker-migration.js";

const migration = "BEGIN;\nCREATE TABLE example (id bigint);\nCOMMIT;\n";

function fakeClient(existingSha) {
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
