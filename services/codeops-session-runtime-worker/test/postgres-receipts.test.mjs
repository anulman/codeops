import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRuntimeExecutionReceiptStore } from "../dist/postgres-receipts.js";

const dispatchId = "44444444-4444-4444-8444-444444444444";
const digest = `sha256:${"a".repeat(64)}`;

function fakeDatabase(existing = null) {
  const state = { row: existing };
  const calls = [];
  return {
    calls,
    state,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("INSERT INTO")) {
        if (state.row === null) {
          state.row = {
            dispatch_id: values[0],
            dispatch_digest: values[1],
            result_json: JSON.parse(values[2]),
          };
        }
        return { rows: [] };
      }
      if (text.includes("SELECT dispatch_id::text")) {
        return { rows: state.row === null ? [] : [state.row] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

test("reads an absent or schema-valid durable receipt", async () => {
  const database = fakeDatabase();
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  assert.equal(await store.read(dispatchId), null);
  database.state.row = {
    dispatch_id: dispatchId,
    dispatch_digest: digest,
    result_json: { type: "prompt" },
  };
  assert.deepEqual(await store.read(dispatchId), {
    dispatchId,
    dispatchDigest: digest,
    result: { type: "prompt" },
  });
});

test("creates a receipt with insert-on-conflict then reads the winner", async () => {
  const database = fakeDatabase();
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  const proposed = {
    dispatchId,
    dispatchDigest: digest,
    result: { type: "prompt" },
  };
  assert.deepEqual(await store.create(proposed), proposed);
  assert.equal(database.calls.length, 2);
  assert.match(database.calls[0].text, /ON CONFLICT \(dispatch_id\) DO NOTHING/);
  assert.deepEqual(database.calls[0].values, [
    dispatchId,
    digest,
    JSON.stringify({ type: "prompt" }),
  ]);
});

test("returns an already committed conflicting winner for lifecycle rejection", async () => {
  const winner = {
    dispatch_id: dispatchId,
    dispatch_digest: `sha256:${"b".repeat(64)}`,
    result_json: { type: "prompt" },
  };
  const database = fakeDatabase(winner);
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  assert.deepEqual(
    await store.create({
      dispatchId,
      dispatchDigest: digest,
      result: { type: "prompt" },
    }),
    {
      dispatchId,
      dispatchDigest: winner.dispatch_digest,
      result: { type: "prompt" },
    },
  );
  assert.deepEqual(database.state.row, winner);
});
