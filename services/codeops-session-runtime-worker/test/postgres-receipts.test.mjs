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
            result_json: null,
          };
          return { rows: [state.row] };
        }
        return { rows: [] };
      }
      if (text.includes("UPDATE codeops.session_runtime_execution_receipts")) {
        if (
          state.row !== null &&
          state.row.dispatch_id === values[0] &&
          state.row.dispatch_digest === values[1] &&
          state.row.result_json === null
        ) {
          state.row = { ...state.row, result_json: JSON.parse(values[2]) };
          return { rows: [state.row] };
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

test("atomically acquires a new started reservation", async () => {
  const database = fakeDatabase();
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  assert.deepEqual(await store.reserve({ dispatchId, dispatchDigest: digest }), {
    acquired: true,
    reservation: { dispatchId, dispatchDigest: digest, result: null },
  });
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].text, /ON CONFLICT \(dispatch_id\) DO NOTHING/);
  assert.deepEqual(database.calls[0].values, [dispatchId, digest]);
});

test("returns an existing reservation without acquiring execution authority", async () => {
  const winner = {
    dispatch_id: dispatchId,
    dispatch_digest: `sha256:${"b".repeat(64)}`,
    result_json: { type: "prompt" },
  };
  const database = fakeDatabase(winner);
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  assert.deepEqual(
    await store.reserve({ dispatchId, dispatchDigest: digest }),
    {
      acquired: false,
      reservation: {
        dispatchId,
        dispatchDigest: winner.dispatch_digest,
        result: { type: "prompt" },
      },
    },
  );
  assert.deepEqual(database.state.row, winner);
});

test("completes only the exact started reservation", async () => {
  const database = fakeDatabase({
    dispatch_id: dispatchId,
    dispatch_digest: digest,
    result_json: null,
  });
  const store = new PostgresRuntimeExecutionReceiptStore(database);
  const receipt = {
    dispatchId,
    dispatchDigest: digest,
    result: { type: "prompt" },
  };
  assert.deepEqual(await store.complete(receipt), receipt);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].text, /status = 'started'/);
  assert.deepEqual(database.calls[0].values, [
    dispatchId,
    digest,
    JSON.stringify({ type: "prompt" }),
  ]);
});
