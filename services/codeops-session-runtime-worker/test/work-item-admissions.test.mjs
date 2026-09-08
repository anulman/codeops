import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { sessionPolicyForMode, sha256CanonicalJsonDigest, buildWorkItemAdmissionPlan } from "@codeops/codeops-contracts";
import { createWorkItemAdmissionAdapter } from "../dist/work-item-admissions.js";

const id = "11111111-1111-4111-8111-111111111111";
const repository = "example-org/example-repository";
const proposal = { repository, workItemId: id, title: "Publish qualified candidate",
  prompt: "Publish the exact attached candidate using existing GitHub permissions." };
const attachmentBytes = Buffer.from('{"changes":[]}');
const attachment = { attachmentId: "candidate", name: "candidate.json", mimeType: "application/json",
  sizeBytes: attachmentBytes.length, digest: `sha256:${createHash("sha256").update(attachmentBytes).digest("hex")}`,
  content: attachmentBytes.toString("base64") };
const { content: _bytes, ...descriptor } = attachment;
function fixture() {
  const calls = [];
  let active = true;
  const dispatch = {
    version: "codeops.session-runtime-dispatch/v1", dispatchId: id, principalId: "operator:fixture",
    dispatchedAt: "2026-09-01T10:00:00.000Z",
    command: { version: "codeops.session-command/v1", type: "prompt", sessionId: "parent",
      generation: 1, leaseId: id, idempotencyKey: id, prompt: "Coordinate publication", contextAttachments: [attachment] },
    snapshot: { version: "codeops.session-snapshot/v1", sessionId: "parent", generation: 1, state: "running",
      identity: { version: "codeops.session-workspace-identity/v1", policy: sessionPolicyForMode("implement"),
        contextAttachments: [descriptor], workspace: { version: "codeops.workspace/v1", scratchPath: "scratch",
          sources: [{ repository, catalogKey: "example", checkoutPath: "sources/example", requestedRef: "main", resolvedSha: "a".repeat(40) }] },
        workflowId: "parent-workflow", runId: "parent-run", parentSessionId: null, forkedAtCursor: null },
      lease: { leaseId: id, generation: 1, status: "active", holderId: "worker",
        acquiredAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-09-01T11:00:00.000Z" },
      checkpoint: null, pendingPermission: null, eventCursor: 1,
      capabilities: ["prompt", "respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
        .map((action) => action === "prompt" ? { action, availability: "enabled" }
          : { action, availability: "disabled", reason: "Unavailable in fixture." }),
      updatedAt: "2026-09-01T10:00:00.000Z" },
  };
  const options = { dispatch, project: { repository, provider: { kind: "plane", workspaceId: id, projectId: id } },
    isActive: () => active,
    context: {
      async prepareWorkItemAdmission(proposal) {
        const plan = buildWorkItemAdmissionPlan(dispatch, proposal, { ...options.project, workItemId: proposal.workItemId });
        calls.push(["plan", plan.update]);
        return { version: "codeops.work-item-admission-plan-result/v1", request: plan.request,
          event: { version: "codeops.session-event/v1", eventId: plan.eventId, sessionId: "parent",
            generation: 1, cursor: 2, type: "acp_update", update: plan.update, occurredAt: "2026-09-01T10:01:00.000Z" } };
      },
      async requestPermission(value) { calls.push(["permission", value]); return { outcome: "selected", acpOptionId: "allow-once" }; },
      async admitWorkItem(value) {
        calls.push(["admission", value]);
        return { version: "codeops.work-item-admission-result/v1", admissionId: value.admissionId,
          disposition: "created", parentSessionId: "parent", childSessionId: value.child.sessionId,
          dispatchId: value.child.dispatchId, lifecycleEventId: `event:${"c".repeat(64)}`, supervisionEventId: `sha256:${"d".repeat(64)}` };
      },
    },
  };
  return { options, calls, stop: () => { active = false; } };
}

test("persists exact plan before permission, inherits source/context, maps success and coalesces duplicates", async () => {
  const f = fixture();
  const admit = createWorkItemAdmissionAdapter(f.options);
  const [first, second] = await Promise.all([admit(proposal), admit(proposal)]);
  assert.deepEqual(first, second);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["plan", "permission", "admission"]);
  const plan = f.calls[0][1];
  const permission = f.calls[1][1].request;
  const request = f.calls[2][1];
  assert.equal(permission.operation.kind, "project_plan");
  assert.equal(permission.operation.planDigest, sha256CanonicalJsonDigest(plan.content));
  assert.equal(request.plan.permissionRequestId, permission.requestId);
  assert.equal(request.plan.planDigest, permission.operation.planDigest);
  assert.equal(request.workItem.sourceSha, "a".repeat(40));
  assert.deepEqual(JSON.parse(plan.content.markdown).contextAttachments, [descriptor]);
  assert.equal(request.claimToken, undefined);
  assert.equal(first.childSessionId, request.child.sessionId);
  assert.equal(first.dispatchId, request.child.dispatchId);
});

for (const decision of [null, { outcome: "cancelled" }, { outcome: "selected", acpOptionId: "deny" },
  { outcome: "selected", acpOptionId: "allow-always" }]) {
  test(`rejects missing/wrong permission ${JSON.stringify(decision)}`, async () => {
    const f = fixture();
    f.options.context.requestPermission = async () => decision;
    await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /permission denied/);
    assert.equal(f.calls.some(([kind]) => kind === "admission"), false);
  });
}

test("does not request permission before the durable event receipt", async () => {
  const f = fixture();
  f.options.context.prepareWorkItemAdmission = async () => { throw new Error("unknown plan write"); };
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /unknown plan/);
  assert.deepEqual(f.calls, []);
});

test("rejects plan receipt drift before permission", async () => {
  const f = fixture();
  const persist = f.options.context.prepareWorkItemAdmission;
  f.options.context.prepareWorkItemAdmission = async (proposal) => { const result = await persist(proposal); return { ...result, event: { ...result.event, sessionId: "wrong-parent" } }; };
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /plan drifted/);
  assert.equal(f.calls.length, 1);
});

test("stale dispatch after permission cannot admit", async () => {
  const f = fixture();
  f.options.context.requestPermission = async () => { f.stop(); return { outcome: "selected", acpOptionId: "allow-once" }; };
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /active prompt required/);
  assert.equal(f.calls.some(([kind]) => kind === "admission"), false);
});

test("rejects source/project drift and agent authority fields before effects", async () => {
  const f = fixture();
  const admit = createWorkItemAdmissionAdapter(f.options);
  for (const raw of [{ ...proposal, repository: "other/repository" },
    ...["claimToken", "provider", "sourceSha", "parentDispatchId", "plan", "approvalId", "child", "contextAttachments"]
      .map((key) => ({ ...proposal, [key]: "forged" }))]) await assert.rejects(admit(raw));
  f.options.project.repository = "other/repository";
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /membership or source drifted/);
  assert.deepEqual(f.calls, []);
});

test("reconciles an unknown admission using the identical approved request", async () => {
  const f = fixture();
  const send = f.options.context.admitWorkItem;
  const attempts = [];
  f.options.context.admitWorkItem = async (request) => {
    attempts.push(structuredClone(request));
    if (attempts.length === 1) throw new Error("unknown outcome");
    return { ...await send(request), disposition: "replayed" };
  };
  const admit = createWorkItemAdmissionAdapter(f.options);
  await assert.rejects(admit(proposal), /unknown outcome/);
  assert.equal((await admit(proposal)).disposition, "replayed");
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(f.calls.filter(([kind]) => kind === "plan").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "permission").length, 1);
});

test("rejects admission response identity drift", async () => {
  const f = fixture();
  const send = f.options.context.admitWorkItem;
  f.options.context.admitWorkItem = async (request) => ({ ...await send(request), childSessionId: "wrong-child" });
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal), /result drifted/);
});

test("rejects changed attachment bytes before any plan or permission", async () => {
  const f = fixture();
  f.options.dispatch.command.contextAttachments = [{ ...attachment, content: Buffer.from("different").toString("base64") }];
  await assert.rejects(createWorkItemAdmissionAdapter(f.options)(proposal));
  assert.deepEqual(f.calls, []);
});

test("unknown permission response reuses the same durable plan and permission identity", async () => {
  const f = fixture(); const submissions = [];
  f.options.context.requestPermission = async (submission) => {
    submissions.push(structuredClone(submission));
    if (submissions.length === 1) throw new Error("permission response lost");
    return { outcome: "selected", acpOptionId: "allow-once" };
  };
  const admit = createWorkItemAdmissionAdapter(f.options);
  await assert.rejects(admit(proposal), /response lost/);
  await admit(proposal);
  assert.deepEqual(submissions[0], submissions[1]);
  await assert.rejects(admit({ ...proposal, prompt: "Changed child" }), /content drifted/);
});

test("installed work-items broker admits only through the fixed active route", async () => {
  const { WorkItemsBroker } = await import("../dist/work-items-broker.js");
  const f = fixture(); const broker = new WorkItemsBroker(); const port = await broker.listen(0);
  const post = (body) => fetch(`http://127.0.0.1:${port}/v1/work-items/admit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post(proposal)).status, 409);
    await broker.run(f.options.dispatch, f.options.context, async () => {
      assert.equal((await post({ ...proposal, claimToken: id })).status, 400);
      const response = await post(proposal);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).disposition, "created");
    });
    assert.equal((await post(proposal)).status, 409);
  } finally { await broker.close(); }
});
