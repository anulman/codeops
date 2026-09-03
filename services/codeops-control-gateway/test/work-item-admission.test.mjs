import assert from "node:assert/strict";
import test from "node:test";
import { admitSessionRuntimeWorkItem, WorkItemAdmissionConflictError } from "../dist/work-item-admission.js";

const request = { version: "codeops.work-item-admission/v1",
  admissionId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  plan: { planId: "approved-plan", planDigest: `sha256:${"a".repeat(64)}`, permissionRequestId: "approve-plan" },
  workItem: { repository: "example-org/example-repository", provider: { kind: "plane",
    workspaceId: "33333333-3333-4333-8333-333333333333", projectId: "44444444-4444-4444-8444-444444444444" },
    workItemId: "55555555-5555-4555-8555-555555555555", workflowId: "workflow", runId: "run",
    sourceSha: "b".repeat(40), title: "Admit work", prompt: "Implement only this work item." },
  child: { sessionId: "session-child", leaseId: "66666666-6666-4666-8666-666666666666",
    holderId: "runtime-worker:child", dispatchId: "77777777-7777-4777-8777-777777777777",
    idempotencyKey: "88888888-8888-4888-8888-888888888888" } };
const materialization = { profile: "custom", release: "v0.5.0-alpha.58",
  agentImage: `registry.example/agent@sha256:${"a".repeat(64)}`,
  runtimeWorkerImage: `registry.example/worker@sha256:${"b".repeat(64)}` };

for (const code of ["23505", "40001", "40P01", "08006"]) {
  test(`preserves PostgreSQL ${code} without labeling it an admission conflict`, async () => {
    const calls = [];
    const failure = Object.assign(new Error("database failure"), { code });
    const client = { async query(text) {
      calls.push(text);
      if (text.startsWith("SELECT admission.*")) throw failure;
      return { rows: [], rowCount: 0 };
    } };
    await assert.rejects(admitSessionRuntimeWorkItem(client, {
      dispatchId: "99999999-9999-4999-8999-999999999999", workerId: "runtime-worker:parent", request,
      materialization,
    }), (error) => error === failure && !(error instanceof WorkItemAdmissionConflictError));
    assert.deepEqual(calls.slice(-1), ["ROLLBACK"]);
  });
}
