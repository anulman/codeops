import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  AcpSessionStateStore,
  captureWorkspacePatch,
  createAcpPermissionRelay,
  forkOrCreateAcpSession,
  SocketAcpWorkspaceLifecycle,
  waitForAcpSocket,
} from "../dist/acp-workspace.js";

const execFileAsync = promisify(execFile);
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

test("rejects an invalid ACP readiness boundary before opening a socket", async () => {
  await assert.rejects(waitForAcpSocket("relative.sock", 1_000), /absolute path/);
  await assert.rejects(waitForAcpSocket("/run/codeops/agent.sock", 999), /between 1 and 60 seconds/);
});

test("falls back to a new ACP session only when session/fork is unsupported", async () => {
  const calls = [];
  assert.equal(await forkOrCreateAcpSession({
    fork: async () => {
      calls.push("fork");
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    create: async () => {
      calls.push("new");
      return "acp-session-child";
    },
  }), "acp-session-child");
  assert.deepEqual(calls, ["fork", "new"]);

  await assert.rejects(forkOrCreateAcpSession({
    fork: async () => {
      throw Object.assign(new Error("transport failed"), { code: -32000 });
    },
    create: async () => "must-not-run",
  }), /transport failed/);
});

function capabilities(enabled, hasCheckpoint = false) {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive", "delete",
  ].map((action) => enabled.includes(action)
    ? { action, availability: "enabled" }
    : {
        action,
        availability: "disabled",
        reason: hasCheckpoint ? "Unavailable now." : "Checkpoint required.",
      });
}

function snapshot(overrides = {}) {
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: "ses_video_1",
    generation: 1,
    state: "running",
    identity: {
      repository: "anulman/renoconcierge",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "video-proof-1",
      runId: "video-proof-job-1",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: {
      leaseId,
      generation: 1,
      status: "active",
      holderId: "session-job:video-proof-1",
      acquiredAt: "2026-08-05T03:15:00.000Z",
      expiresAt: "2026-08-05T04:15:00.000Z",
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 1,
    capabilities: capabilities(["prompt", "cancel", "checkpoint", "hibernate"]),
    updatedAt: "2026-08-05T03:15:00.000Z",
    ...overrides,
  };
}

function dispatch(type, command = {}, snapshotOverrides = {}) {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId: "33333333-3333-4333-8333-333333333333",
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "ses_video_1",
      generation: 1,
      leaseId,
      idempotencyKey,
      type,
      ...command,
    },
    snapshot: snapshot(snapshotOverrides),
    dispatchedAt: "2026-08-05T03:16:00.000Z",
  };
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-acp-workspace-"));
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "CodeOps Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "codeops@example.test"]);
  await writeFile(path.join(root, "README.md"), "before\n");
  await execFileAsync("git", ["-C", root, "add", "README.md"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

test("persists bounded broker-to-ACP session identity atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-acp-state-"));
  const statePath = path.join(root, "sessions.json");
  const store = new AcpSessionStateStore(statePath);
  assert.equal(await store.get("ses_video_1"), null);
  await store.set("ses_video_1", "acp-session-1");
  assert.equal(await store.get("ses_video_1"), "acp-session-1");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
    version: "codeops.acp-session-state/v1",
    sessions: { ses_video_1: "acp-session-1" },
  });
});

test("maps ACP options through opaque broker identities without exposing claim authority", async () => {
  const submitted = [];
  const relay = createAcpPermissionRelay({
    context: {
      requestPermission: async (input) => {
        submitted.push(input);
        return { outcome: "selected", acpOptionId: "opaque-allow-once" };
      },
    },
    now: () => new Date("2026-08-05T03:20:00.000Z"),
  });
  const response = await relay.request(
    dispatch("prompt", { prompt: "Make one safe edit." }),
    {
      sessionId: "acp-session-1",
      toolCall: {
        toolCallId: "tool-call-1",
        title: "Write README.md",
        kind: "edit",
      },
      options: [
        { optionId: "opaque-allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "opaque-reject", name: "Reject", kind: "reject_once" },
      ],
    },
  );
  assert.deepEqual(response, {
    outcome: { outcome: "selected", optionId: "opaque-allow-once" },
  });
  assert.equal(submitted.length, 1);
  assert.equal("claimToken" in submitted[0], false);
  assert.match(submitted[0].request.requestId, /^permission-[0-9a-f]{64}$/);
  assert.deepEqual(submitted[0].request.options, [
    { optionId: "option-1", label: "Allow once" },
    { optionId: "option-2", label: "Reject" },
  ]);
  assert.deepEqual(submitted[0].options, [
    { optionId: "option-1", acpOptionId: "opaque-allow-once" },
    { optionId: "option-2", acpOptionId: "opaque-reject" },
  ]);
});

test("captures tracked and untracked workspace changes in one bounded patch", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "README.md"), "after\n");
  await writeFile(path.join(root, "new.txt"), "new\n");
  const patch = (await captureWorkspacePatch(root)).toString("utf8");
  assert.match(patch, /README\.md/);
  assert.match(patch, /new\.txt/);
  assert.match(patch, /\+after/);
  assert.match(patch, /\+new/);
});

test("executes prompt, checkpoint, hibernate, resume, and fork through ACP identity", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "README.md"), "after\n");
  const calls = [];
  const ids = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock",
    workspace: root,
    statePath: path.join(root, ".runtime", "sessions.json"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    now: () => new Date("2026-08-05T03:20:00.000Z"),
    uuid: () => ids.shift(),
    connect: async (_runtimeDispatch, operation) => operation({
      newSession: async (cwd) => {
        calls.push(["new", cwd]);
        return "acp-session-parent";
      },
      loadSession: async (sessionId, cwd) => {
        calls.push(["load", sessionId, cwd]);
      },
      prompt: async (sessionId, prompt) => {
        calls.push(["prompt", sessionId, prompt]);
      },
      forkSession: async (sessionId, cwd) => {
        calls.push(["fork", sessionId, cwd]);
        return "acp-session-child";
      },
    }),
  });

  assert.deepEqual(
    await lifecycle.prompt(dispatch("prompt", { prompt: "Make one safe edit." })),
    { type: "prompt" },
  );
  const checkpoint = await lifecycle.checkpoint(dispatch("checkpoint"));
  assert.equal(checkpoint.type, "checkpoint");
  assert.equal(checkpoint.material.acpSessionId, "acp-session-parent");
  assert.match(checkpoint.material.patchDigest, /^sha256:[0-9a-f]{64}$/);
  const hibernate = await lifecycle.hibernate(dispatch("hibernate"));
  assert.equal(hibernate.type, "hibernate");

  const hibernated = {
    state: "hibernated",
    lease: { leaseId, generation: 1, status: "released", releasedAt: "2026-08-05T03:19:00.000Z" },
    checkpoint: {
      version: "codeops.session-checkpoint/v1",
      ...hibernate.material,
      sessionId: "ses_video_1",
      generation: 1,
      baseSha: "a".repeat(40),
      eventCursor: 3,
      createdAt: "2026-08-05T03:19:00.000Z",
    },
    eventCursor: 3,
    capabilities: capabilities(["resume", "fork", "archive"], true),
  };
  const resumed = await lifecycle.resume(dispatch(
    "resume",
    { checkpointId: hibernate.material.checkpointId },
    hibernated,
  ));
  assert.equal(resumed.type, "resume");
  assert.equal(resumed.material.leaseId, "66666666-6666-4666-8666-666666666666");

  const forked = await lifecycle.fork(dispatch(
    "fork",
    {
      checkpointId: hibernate.material.checkpointId,
      parentEventCursor: 3,
      title: "Video proof fork",
    },
    hibernated,
  ));
  assert.equal(forked.type, "fork");
  assert.equal(forked.material.sessionId, "ses_77777777777747778777777777777777");
  assert.equal(forked.material.leaseId, "88888888-8888-4888-8888-888888888888");
  assert.deepEqual(calls, [
    ["new", root],
    ["prompt", "acp-session-parent", "Make one safe edit."],
    ["load", "acp-session-parent", root],
    ["fork", "acp-session-parent", root],
  ]);
});
