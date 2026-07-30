import assert from "node:assert/strict";
import { test } from "node:test";
import { createTemporalCodingCanceller } from "../dist/index.js";

test("signals the exact Temporal workflow with a bounded cancellation reason", async () => {
  const calls = [];
  const cancel = createTemporalCodingCanceller({
    client: {
      workflow: {
        getHandle(workflowId) {
          calls.push(["handle", workflowId]);
          return {
            async signal(name, reason) {
              calls.push(["signal", name, reason]);
            },
          };
        },
      },
    },
  });
  await cancel({
    workflowId: "codeops-ready-123",
    reason: "  blocker moved\n to Paused  ",
  });
  assert.deepEqual(calls, [
    ["handle", "codeops-ready-123"],
    ["signal", "cancelWorkItem", "blocker moved to Paused"],
  ]);
});

test("refuses ambiguous workflow identities and cancellation reasons", async () => {
  const cancel = createTemporalCodingCanceller({
    client: {
      workflow: {
        getHandle() {
          throw new Error("must not be called");
        },
      },
    },
  });
  await assert.rejects(
    cancel({ workflowId: "../other", reason: "paused" }),
    /workflow identity/,
  );
  await assert.rejects(
    cancel({ workflowId: "codeops-ready-123", reason: " " }),
    /cancellation reason/,
  );
});
