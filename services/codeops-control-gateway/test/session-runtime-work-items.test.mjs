import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertWorkItemPermissionIdentity,
  SessionRuntimeWorkItemConflictError,
} from "../dist/session-runtime-work-items.js";

function canonical(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

test("binds one work-item permission to its exact target and mutation", () => {
  const dispatch = { dispatchId: "33333333-3333-4333-8333-333333333333" };
  const input = {
    repository: "anulman/codeops",
    workItemId: "22222222-2222-4222-8222-222222222222",
    body: "Validated.",
  };
  const operation = {
    kind: "work_item",
    repository: input.repository,
    operation: "comment",
    targetWorkItemId: input.workItemId,
    payloadJson: canonical(input),
  };
  const permission = {
    acpSessionId: "codeops-work-items",
    request: {
      requestId: `workitem-${createHash("sha256")
        .update(canonical({ dispatchId: dispatch.dispatchId, operation: "comment", workItem: input }))
        .digest("hex")}`,
      operation,
      operationDigest: `sha256:${createHash("sha256")
        .update(canonical(operation))
        .digest("hex")}`,
    },
  };
  assert.doesNotThrow(() =>
    assertWorkItemPermissionIdentity(permission, dispatch, "comment", input));
  for (const drift of [
    { ...input, body: "Changed after approval." },
    { ...input, workItemId: "44444444-4444-4444-8444-444444444444" },
  ]) {
    assert.throws(
      () => assertWorkItemPermissionIdentity(permission, dispatch, "comment", drift),
      SessionRuntimeWorkItemConflictError,
    );
  }
});
