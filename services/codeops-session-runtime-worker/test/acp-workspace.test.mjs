import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  AcpSessionStateStore,
  appendAcpAssistantText,
  captureScratchArtifact,
  captureAcpTimelineUpdate,
  captureWorkspacePatch,
  captureWorkspaceCheckpoint,
  createAcpPermissionRelay,
  forkOrCreateAcpSession,
  mergeAcpPermissionToolCall,
  renderAcpPermissionOperation,
  recoverableModelFailure,
  SocketAcpWorkspaceLifecycle,
  waitForAcpSocket,
  workspacePromptContentBlocks,
} from "../dist/acp-workspace.js";

const execFileAsync = promisify(execFile);
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

test("rejects an invalid ACP readiness boundary before opening a socket", async () => {
  await assert.rejects(waitForAcpSocket("relative.sock", 1_000), /absolute path/);
  await assert.rejects(waitForAcpSocket("/run/codeops/agent.sock", 999), /between 1 and 60 seconds/);
});

test("collects ordered ACP assistant chunks within the transcript bound", () => {
  assert.equal(
    appendAcpAssistantText("I made ", "one safe edit."),
    "I made one safe edit.",
  );
  assert.equal(appendAcpAssistantText("x".repeat(200_000), ""), "x".repeat(200_000));
  assert.throws(
    () => appendAcpAssistantText("x".repeat(200_000), "y"),
    /exceeds 200000 characters/,
  );
});

test("reverifies context attachments and emits exact ACP embedded resources", () => {
  const text = Buffer.from("Exact brief.\n");
  const image = Buffer.from([0, 1, 2, 3]);
  const digest = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const blocks = workspacePromptContentBlocks("Inspect both attachments.", [
    {
      attachmentId: "context-brief",
      name: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: text.byteLength,
      digest: digest(text),
      content: text.toString("base64"),
    },
    {
      attachmentId: "context-image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: image.byteLength,
      digest: digest(image),
      content: image.toString("base64"),
    },
  ]);
  assert.deepEqual(blocks[0], { type: "text", text: "Inspect both attachments." });
  assert.equal(blocks[1].type, "resource");
  assert.equal(blocks[1].resource.text, "Exact brief.\n");
  assert.match(blocks[1].resource.uri, /^codeops-context:\/\/sha256\/[0-9a-f]{64}\/brief\.txt$/);
  assert.equal(blocks[2].resource.blob, image.toString("base64"));
  assert.throws(
    () => workspacePromptContentBlocks("Inspect.", [{
      attachmentId: "context-image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: image.byteLength,
      digest: `sha256:${"0".repeat(64)}`,
      content: image.toString("base64"),
    }]),
    /digest drifted/,
  );
});

const workspaceIdentity = (mode) => ({
  version: "codeops.session-workspace-identity/v1",
  policy: { mode },
});

test("injects exact architecture guidance after a Plan prompt and before ordered attachments", () => {
  const first = Buffer.from("First attachment.\n");
  const second = Buffer.from("Second attachment.\n");
  const attachment = (attachmentId, name, content) => ({
    attachmentId,
    name,
    mimeType: "text/plain",
    sizeBytes: content.byteLength,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    content: content.toString("base64"),
  });

  const blocks = workspacePromptContentBlocks(
    "Keep this original prompt exact.",
    [
      attachment("context-first", "first.txt", first),
      attachment("context-second", "second.txt", second),
    ],
    workspaceIdentity("plan"),
  );
  const exactGuidance = `Architecture planning default:
For each new non-critical architectural unit:
1. First assess reusable shared libraries, existing services, and cluster resources.
2. If none fit, assess relevant well-architected, actively maintained open-source projects or tools under a permissive license and compatible operational requirements.
3. Record an explicit reuse/adopt/build decision.
4. Compare fit, integration cost, security, operations, maintenance, and reversibility.
Do not recommend custom implementation until suitable internal and OSS alternatives are addressed.`;

  assert.deepEqual(blocks.map((block) => block.type), ["text", "text", "resource", "resource"]);
  assert.deepEqual(blocks[0], { type: "text", text: "Keep this original prompt exact." });
  assert.deepEqual(blocks[1], { type: "text", text: exactGuidance });
  assert.equal(blocks[2].resource.text, "First attachment.\n");
  assert.equal(blocks[3].resource.text, "Second attachment.\n");
});

test("leaves non-Plan workspace modes and non-workspace identities unchanged", () => {
  for (const mode of ["explore", "implement", "review"]) {
    assert.deepEqual(
      workspacePromptContentBlocks("Original prompt.", [], workspaceIdentity(mode)),
      [{ type: "text", text: "Original prompt." }],
    );
  }
  assert.deepEqual(
    workspacePromptContentBlocks("Original prompt.", [], {
      repository: "example-org/example-repository",
      branch: "main",
      baseSha: "a".repeat(40),
      workflowId: "legacy-workflow",
      runId: "legacy-run",
      parentSessionId: null,
      forkedAtCursor: null,
    }),
    [{ type: "text", text: "Original prompt." }],
  );
  assert.deepEqual(
    workspacePromptContentBlocks("Original prompt.", [], {
      version: "codeops.temporal-session-identity/v2",
    }),
    [{ type: "text", text: "Original prompt." }],
  );
});

test("normalizes ACP plans, tools, reasoning, message boundaries, and media", () => {
  const input = [
    { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "External " } },
    { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "prompt." } },
    { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "high", status: "in_progress" }] },
    { sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "Check " } },
    { sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "the contract." } },
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read contract", kind: "read", status: "in_progress", content: [], locations: [{ path: "/workspace/contract.ts", line: 9 }] },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Done." } }] },
    { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "First message." } },
    { sessionUpdate: "agent_message_chunk", messageId: "message-2", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
    { sessionUpdate: "agent_message_chunk", messageId: "message-2", content: { type: "text", text: "Second message." } },
  ];
  const capture = input.reduce(
    (current, update) => captureAcpTimelineUpdate(current, update),
    { response: "", updates: [] },
  );
  assert.equal(capture.response, "First message.Second message.");
  assert.equal(capture.updates.length, 7);
  assert.deepEqual(capture.updates[0], {
    kind: "user_content",
    messageId: "user-1",
    content: { type: "text", text: "External prompt." },
  });
  assert.deepEqual(capture.updates[2], {
    kind: "thought",
    messageId: "thought-1",
    content: { type: "text", text: "Check the contract." },
  });
  assert.deepEqual(capture.updates[3], {
    kind: "tool_call",
    toolCallId: "tool-1",
    title: "Read contract",
    toolKind: "read",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Done." } }],
    locations: [{ path: "/workspace/contract.ts", line: 9 }],
  });
  assert.deepEqual(capture.updates.slice(-3).map(({ kind, messageId }) => [kind, messageId]), [
    ["assistant_content", "message-1"],
    ["assistant_content", "message-2"],
    ["assistant_content", "message-2"],
  ]);
});

test("retains bounded ACP mode, configuration, command, and usage updates", () => {
  const updates = [
    {
      sessionUpdate: "current_mode_update",
      currentModeId: "code",
    },
    {
      sessionUpdate: "available_commands_update",
      availableCommands: [{
        name: "review",
        description: "Review the current workspace.",
        input: { hint: "optional focus" },
      }],
    },
    {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "sol",
          options: [{ value: "sol", name: "Sol" }],
        },
        {
          type: "boolean",
          id: "compact",
          name: "Compact output",
          currentValue: true,
        },
      ],
    },
    {
      sessionUpdate: "usage_update",
      used: 12_000,
      size: 272_000,
      cost: { amount: 1.25, currency: "USD" },
    },
  ];
  const capture = updates.reduce(
    (current, update) => captureAcpTimelineUpdate(current, update),
    { response: "", updates: [] },
  );
  assert.deepEqual(capture.updates.map(({ kind }) => kind), [
    "current_mode",
    "available_commands",
    "configuration",
    "usage",
  ]);
  assert.deepEqual(capture.updates[2].options.map(({ id, currentValue }) => [id, currentValue]), [
    ["model", "sol"],
    ["compact", true],
  ]);
  assert.equal(capture.updates[3].cost.currency, "USD");
  assert.throws(
    () => captureAcpTimelineUpdate(
      { response: "", updates: [] },
      { sessionUpdate: "usage_update", used: 2, size: 1 },
    ),
    /usage cannot exceed/,
  );
  assert.throws(
    () => captureAcpTimelineUpdate(
      { response: "", updates: [] },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "x".repeat(201), description: "Too long" }],
      },
    ),
  );
});

test("compacts more than 2000 updates for one ACP tool within the work bound", () => {
  let capture = captureAcpTimelineUpdate(
    { response: "", updates: [] },
    {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run checks",
      kind: "execute",
      status: "pending",
      locations: [{ path: "/workspace" }],
    },
  );
  for (let index = 0; index < 2_100; index += 1) {
    capture = captureAcpTimelineUpdate(capture, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: index === 2_099 ? "completed" : "in_progress",
    });
  }
  assert.deepEqual(capture.updates, [{
    kind: "tool_call",
    toolCallId: "tool-1",
    title: "Run checks",
    toolKind: "execute",
    status: "completed",
    locations: [{ path: "/workspace" }],
  }]);
});

test("drops timeline telemetry beyond the finite processed-work bound", () => {
  let capture = { response: "", updates: [] };
  for (let index = 0; index < 2_500; index += 1) {
    capture = captureAcpTimelineUpdate(capture, {
      sessionUpdate: "current_mode_update",
      currentModeId: index % 2 === 0 ? "code" : "review",
    });
  }
  assert.equal(capture.updates.length, 1);
  assert.deepEqual(Object.keys(capture), ["response", "updates"]);
  capture = captureAcpTimelineUpdate(capture, {
    sessionUpdate: "current_mode_update",
    currentModeId: "code",
  });
  assert.equal(capture.updates.length, 1);
});

test("rolls the oldest retained update after 2000 distinct ACP updates", () => {
  let capture = { response: "", updates: [] };
  for (let index = 0; index < 2_000; index += 1) {
    capture = captureAcpTimelineUpdate(capture, {
      sessionUpdate: "user_message_chunk",
      messageId: `user-${index}`,
      content: { type: "text", text: "x" },
    });
  }
  assert.equal(capture.updates.length, 2_000);
  assert.ok(Buffer.byteLength(JSON.stringify(capture.updates)) < 800_000);
  capture = captureAcpTimelineUpdate(capture, {
    sessionUpdate: "user_message_chunk",
    messageId: "user-2000",
    content: { type: "text", text: "x" },
  });
  assert.equal(capture.updates.length, 2_000);
  assert.equal(capture.updates[0].messageId, "user-1");
  assert.equal(capture.updates.at(-1).messageId, "user-2000");
});

test("rolls high-cardinality tool and plan identities at the retained bound", () => {
  for (const identity of ["tool", "plan"]) {
    let capture = { response: "", updates: [] };
    for (let index = 0; index < 2_000; index += 1) {
      capture = captureAcpTimelineUpdate(capture, identity === "tool"
        ? {
            sessionUpdate: "tool_call_update",
            toolCallId: `tool-${index}`,
            status: "pending",
          }
        : {
            sessionUpdate: "plan_removed",
            planId: `plan-${index}`,
          });
    }
    assert.equal(capture.updates.length, 2_000);
    capture = captureAcpTimelineUpdate(capture, identity === "tool"
      ? {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2000",
          status: "pending",
        }
      : {
          sessionUpdate: "plan_removed",
          planId: "plan-2000",
        });
    assert.equal(capture.updates.length, 2_000);
  }
});

test("bounds tool output and rolls timeline telemetry instead of failing completion", () => {
  let capture = captureAcpTimelineUpdate(
    { response: "", updates: [] },
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Inspect" },
  );
  for (let index = 0; index < 8; index += 1) {
    capture = captureAcpTimelineUpdate(capture, {
      sessionUpdate: "user_message_chunk",
      messageId: `large-${index}`,
      content: { type: "text", text: "x".repeat(99_000) },
    });
  }
  const retainedBytes = Buffer.byteLength(JSON.stringify(capture.updates));
  assert.ok(retainedBytes > 790_000 && retainedBytes < 800_000);
  capture = captureAcpTimelineUpdate(capture, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    content: [{
      type: "content",
      content: { type: "text", text: "y".repeat(10_000) },
    }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(capture.updates)) < 800_000);
  const tool = capture.updates.find(({ kind }) => kind === "tool_call");
  assert.match(tool.content[0].content.text, /timeline truncated/);
});

test("retains bounded summaries for many large edit calls", () => {
  let capture = { response: "", updates: [] };
  for (let index = 0; index < 40; index += 1) {
    capture = captureAcpTimelineUpdate(capture, {
      sessionUpdate: "tool_call",
      toolCallId: `edit-${index}`,
      title: "Editing files",
      kind: "edit",
      status: "completed",
      content: [{
        type: "diff",
        path: `/workspace/file-${index}.ts`,
        oldText: "a".repeat(100_000),
        newText: "b".repeat(100_000),
      }],
    });
  }
  assert.equal(capture.updates.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(capture.updates)) < 200_000);
  assert.match(capture.updates[0].content[0].newText, /timeline truncated/);
});

test("replays representative producer and strict-review fixtures deterministically", async () => {
  const fixture = async (name) => JSON.parse(await readFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    "utf8",
  ));
  const replay = (input) => input.reduce(
    (current, update) => captureAcpTimelineUpdate(current, update),
    { response: "", updates: [] },
  );
  const producer = await fixture("acp-timeline-producer.json");
  const producerCapture = replay(producer);
  assert.deepEqual(producerCapture.updates, [{
    kind: "tool_call",
    toolCallId: "producer-tool-1",
    title: "Inspect source tree",
    toolKind: "read",
    status: "completed",
    content: [{
      type: "content",
      content: { type: "text", text: "Inspection complete." },
    }],
    locations: [{ path: "/workspace" }],
  }]);
  assert.equal("rawInput" in producerCapture.updates[0], false);

  const strictReview = await fixture("acp-timeline-strict-review.json");
  const firstReplay = replay(strictReview);
  const secondReplay = replay(strictReview);
  assert.deepEqual(secondReplay, firstReplay);
  assert.deepEqual(firstReplay.updates.map(({ kind }) => kind), [
    "thought",
    "tool_call_update",
    "plan_removed",
    "current_mode",
    "thought",
    "available_commands",
    "usage",
    "plan_update",
  ]);
  assert.deepEqual(firstReplay.updates[1], {
    kind: "tool_call_update",
    toolCallId: "review-tool",
    title: "Run strict review",
    name: "strict-review",
    toolKind: "execute",
    status: "in_progress",
  });
  assert.deepEqual(firstReplay.updates[2], {
    kind: "plan_removed",
    planId: "review-plan",
  });
  assert.equal(firstReplay.updates[3].modeId, "code");
  assert.equal(firstReplay.updates[5].commands[0].name, "fix");
  assert.equal(firstReplay.updates[6].usedTokens, 1_800);
  assert.equal(firstReplay.updates[7].content.entries[0].status, "completed");
});

test("keeps singleton and plan identities in their first mixed-order slots", () => {
  const configuration = (currentValue) => ({
    sessionUpdate: "config_option_update",
    configOptions: [{
      type: "boolean",
      id: "strict",
      name: "Strict review",
      currentValue,
    }],
  });
  const input = [
    { sessionUpdate: "plan", entries: [{ content: "Initial", priority: "high", status: "pending" }] },
    configuration(false),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Keep me." } },
    { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-a", content: "First" } },
    { sessionUpdate: "current_mode_update", currentModeId: "review" },
    { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review." }] },
    { sessionUpdate: "usage_update", used: 10, size: 100 },
    { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-b", content: "Other" } },
    { sessionUpdate: "usage_update", used: 20, size: 100 },
    { sessionUpdate: "plan_removed", planId: "plan-a" },
    { sessionUpdate: "plan", entries: [{ content: "Latest", priority: "low", status: "completed" }] },
    configuration(true),
    { sessionUpdate: "available_commands_update", availableCommands: [{ name: "fix", description: "Fix." }] },
    { sessionUpdate: "current_mode_update", currentModeId: "code" },
  ];
  const capture = input.reduce(
    (current, update) => captureAcpTimelineUpdate(current, update),
    { response: "", updates: [] },
  );
  assert.deepEqual(capture.updates.map(({ kind }) => kind), [
    "plan",
    "configuration",
    "assistant_content",
    "plan_removed",
    "current_mode",
    "available_commands",
    "usage",
    "plan_update",
  ]);
  assert.equal(capture.updates[0].entries[0].content, "Latest");
  assert.equal(capture.updates[1].options[0].currentValue, true);
  assert.equal(capture.updates[3].planId, "plan-a");
  assert.equal(capture.updates[4].modeId, "code");
  assert.equal(capture.updates[5].commands[0].name, "fix");
  assert.equal(capture.updates[6].usedTokens, 20);
  assert.equal(capture.updates[7].planId, "plan-b");
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
    "resume", "fork", "archive",
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
      repository: "example-org/example-repository",
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

test("forwards the workspace Plan identity at the lifecycle prompt call site", async () => {
  const root = await workspace();
  const content = Buffer.from("Lifecycle attachment.\n");
  const contextAttachments = [{
    attachmentId: "context-lifecycle",
    name: "lifecycle.txt",
    mimeType: "text/plain",
    sizeBytes: content.byteLength,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    content: content.toString("base64"),
  }];
  const identity = {
    version: "codeops.session-workspace-identity/v1",
    policy: {
      version: "codeops.session-policy/v1",
      mode: "plan",
      workspaceAccess: "read-only",
      modelCalls: "allowed",
      modelPolicy: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    },
    contextAttachments: contextAttachments.map(({ content: _content, ...descriptor }) => descriptor),
    workspace: {
      version: "codeops.workspace/v1",
      sources: [],
      scratchPath: "scratch",
    },
    workflowId: "workspace-plan",
    runId: "workspace-plan-run",
    parentSessionId: null,
    forkedAtCursor: null,
  };
  let receivedPrompt;
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock",
    workspace: root,
    statePath: path.join(root, ".runtime", "sessions.json"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    connect: async (_runtimeDispatch, operation) => operation({
      newSession: async () => "acp-plan-session",
      loadSession: async () => {},
      prompt: async (_sessionId, prompt) => {
        receivedPrompt = prompt;
        return { response: "Plan ready.", stopReason: "end_turn" };
      },
      forkSession: async () => "unused",
    }),
  });

  await lifecycle.prompt(dispatch(
    "prompt",
    { prompt: "Plan the architecture.", contextAttachments },
    { identity },
  ));

  assert.deepEqual(
    receivedPrompt,
    workspacePromptContentBlocks(
      "Plan the architecture.",
      contextAttachments,
      identity,
    ),
  );
});

test("renews once and resumes the exact ACP session after typed model failures", async () => {
  for (const failure of [
    "model_proxy_token_expired",
    "provider_model_unavailable",
  ]) {
    const root = await workspace();
    const prepared = [];
    const cooldowns = [];
    const calls = [];
    let attempts = 0;
    const lifecycle = new SocketAcpWorkspaceLifecycle({
      socketPath: "/run/codeops/agent.sock",
      workspace: root,
      statePath: path.join(root, ".runtime", `sessions-${failure}.json`),
      permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
      prepareModelAuthority: async () => prepared.push(failure),
      providerCooldownMs: 1_000,
      delay: async (milliseconds) => cooldowns.push(milliseconds),
      connect: async (_runtimeDispatch, operation) => operation({
        newSession: async () => { calls.push(["new", "acp-exact"]); return "acp-exact"; },
        loadSession: async (sessionId) => { calls.push(["load", sessionId]); },
        prompt: async (sessionId) => {
          calls.push(["prompt", sessionId]);
          attempts += 1;
          if (attempts === 1) throw { code: -32000, data: { code: failure } };
          return { response: "recovered", stopReason: "end_turn" };
        },
        forkSession: async () => "unused",
      }),
    });
    const result = await lifecycle.prompt(dispatch("prompt", { prompt: "Exact prompt." }));
    assert.equal(result.material.response, "recovered");
    assert.equal(prepared.length, 2);
    assert.deepEqual(calls, [
      ["new", "acp-exact"],
      ["prompt", "acp-exact"],
      ["load", "acp-exact"],
      ["prompt", "acp-exact"],
    ]);
    assert.deepEqual(
      cooldowns,
      failure === "provider_model_unavailable" ? [1_000] : [],
    );
  }
  assert.equal(recoverableModelFailure(new Error("untyped HTTP 404")), null);
});

test("stops after one model-authority renewal", async () => {
  const root = await workspace();
  let prepared = 0;
  let connections = 0;
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock",
    workspace: root,
    statePath: path.join(root, ".runtime", "sessions-once.json"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    prepareModelAuthority: async () => { prepared += 1; },
    connect: async () => {
      connections += 1;
      throw { message: "model_proxy_token_expired" };
    },
  });
  await assert.rejects(lifecycle.prompt(dispatch("prompt", { prompt: "Exact prompt." })));
  assert.equal(prepared, 2);
  assert.equal(connections, 2);
});

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
        content: [{
          type: "diff",
          path: "README.md",
          oldText: "before\n",
          newText: "after\n",
        }],
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
  assert.deepEqual(submitted[0].request.operation, {
    kind: "file_change",
    changes: [{
      path: "README.md",
      oldText: "before\n",
      newText: "after\n",
    }],
  });
  assert.match(submitted[0].request.operationDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(submitted[0].request.options, [
    { optionId: "option-1", label: "Allow once" },
    { optionId: "option-2", label: "Reject" },
  ]);
  assert.deepEqual(submitted[0].options, [
    { optionId: "option-1", acpOptionId: "opaque-allow-once" },
    { optionId: "option-2", acpOptionId: "opaque-reject" },
  ]);
});

test("renders exact command, MCP, and prior file-change permission details", () => {
  const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
  assert.deepEqual(renderAcpPermissionOperation({
    sessionId: "acp-1",
    toolCall: {
      toolCallId: "command-1",
      kind: "execute",
      rawInput: { command: "npm test", cwd: "/workspace" },
    },
    options,
  }), { kind: "command", command: "npm test", cwd: "/workspace" });
  assert.deepEqual(renderAcpPermissionOperation({
    sessionId: "acp-1",
    toolCall: {
      toolCallId: "mcp-1",
      kind: "execute",
      rawInput: {
        server: "plane",
        tool: "comment",
        arguments: { body: "Ship this.", id: "item-1" },
      },
    },
    options,
  }), {
    kind: "mcp",
    server: "plane",
    tool: "comment",
    argumentsJson: '{"body":"Ship this.","id":"item-1"}',
  });
  const enriched = mergeAcpPermissionToolCall(
    { toolCallId: "edit-1", kind: "edit", status: "pending" },
    {
      toolCallId: "edit-1",
      title: "Editing files",
      kind: "edit",
      content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
    },
  );
  assert.deepEqual(renderAcpPermissionOperation({
    sessionId: "acp-1",
    toolCall: enriched,
    options,
  }), {
    kind: "file_change",
    changes: [{ path: "a.ts", oldText: "a", newText: "b" }],
  });
  assert.throws(() => renderAcpPermissionOperation({
    sessionId: "acp-1",
    toolCall: { toolCallId: "opaque-1", kind: "other" },
    options,
  }), /no safe operation renderer/);
});

test("captures tracked and untracked workspace changes in one bounded patch", async () => {
  const root = await workspace();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-private-capture-"));
  const baseSha = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "README.md"), "after\n");
  await writeFile(path.join(root, "new.txt"), "new\n");
  const patch = (await captureWorkspacePatch(root, baseSha, privateRoot)).toString("utf8");
  assert.match(patch, /README\.md/);
  assert.match(patch, /new\.txt/);
  assert.match(patch, /\+after/);
  assert.match(patch, /\+new/);
});

test("captures with isolated Git metadata without executing workspace configuration", async () => {
  const root = await workspace();
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-private-capture-"));
  const baseSha = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const marker = path.join(root, "fsmonitor-executed");
  const fsmonitor = path.join(root, "malicious-fsmonitor.sh");
  await writeFile(fsmonitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  await execFileAsync("git", ["-C", root, "config", "core.fsmonitor", fsmonitor]);
  const originalIndex = await readFile(path.join(root, ".git", "index"));
  await writeFile(path.join(root, "new.txt"), "new\n");

  const patch = (await captureWorkspacePatch(root, baseSha, privateRoot)).toString("utf8");

  assert.match(patch, /new\.txt/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), originalIndex);
  assert.deepEqual(await readdir(privateRoot), []);
});

test("captures exact per-source patches and a deterministic scratch artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-workspace-v1-"));
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-private-capture-"));
  const source = path.join(root, "sources", "repo-one");
  const scratch = path.join(root, "scratch");
  await mkdir(source, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await execFileAsync("git", ["-C", source, "init"]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(path.join(source, "README.md"), "before\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "base"]);
  const sha = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(source, "README.md"), "after\n");
  await writeFile(path.join(scratch, "script.mjs"), "console.log('ok')\n");
  const checkpoint = await captureWorkspaceCheckpoint(root, {
    version: "codeops.workspace/v1",
    sources: [{
      catalogKey: "repo-one",
      repository: "example-org/repo-one",
      checkoutPath: "sources/repo-one",
      requestedRef: "main",
      resolvedSha: sha,
    }],
    scratchPath: "scratch",
  }, privateRoot);
  assert.equal(checkpoint.sourcePatches[0].baseSha, sha);
  assert.match(checkpoint.sourcePatches[0].patchDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(checkpoint.scratchArtifactDigest, /^sha256:[0-9a-f]{64}$/);
});

test("rejects scratch links without reading outside the pinned directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-scratch-links-"));
  const outside = path.join(root, "outside.txt");
  const scratch = path.join(root, "scratch");
  await mkdir(scratch);
  await writeFile(outside, "must-not-be-captured\n");
  await symlink(outside, path.join(scratch, "linked.txt"));

  await assert.rejects(
    captureScratchArtifact(scratch),
    /must not contain symbolic links/,
  );
});

test("keeps a ten-megabyte scratch boundary within the durable encoded artifact limit", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "codeops-scratch-bound-"));
  await writeFile(path.join(scratch, "large.txt"), Buffer.alloc(10_000_000, 0x61));

  const artifact = await captureScratchArtifact(scratch);

  assert.equal(artifact.content.byteLength > 12_000_000, true);
  assert.equal(artifact.content.byteLength <= 16_000_000, true);
});

test("persists actual source patches and scratch files before committing a workspace checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-workspace-artifacts-"));
  const source = path.join(root, "sources", "repo-one");
  const scratch = path.join(root, "scratch");
  await mkdir(source, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await execFileAsync("git", ["-C", source, "init"]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
  await writeFile(path.join(source, "README.md"), "before\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "base"]);
  const sha = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(source, "README.md"), "after\n");
  await writeFile(path.join(scratch, "script.mjs"), "console.log('durable')\n");
  const manifest = {
    version: "codeops.workspace/v1",
    sources: [{
      catalogKey: "repo-one",
      repository: "example-org/repo-one",
      checkoutPath: "sources/repo-one",
      requestedRef: "main",
      resolvedSha: sha,
    }],
    scratchPath: "scratch",
  };
  const artifacts = [];
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock",
    workspace: root,
    statePath: path.join(root, ".runtime", "sessions.json"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    uuid: () => "99999999-9999-4999-8999-999999999999",
    artifacts: { put: async (artifact) => artifacts.push(artifact) },
    checkpointWorkspace: async () => ({
      jobUid: "88888888-8888-4888-8888-888888888888",
      resourceConfigurationDigest: `sha256:${"b".repeat(64)}`,
      workspaceConfigurationDigest: `sha256:${"a".repeat(64)}`,
    }),
    connect: async (_runtimeDispatch, operation) => operation({
      newSession: async () => "acp-workspace-session",
      loadSession: async () => {},
      prompt: async () => ({ response: "ready", stopReason: "end_turn" }),
      forkSession: async () => "unused",
    }),
  });
  const workspaceSnapshot = {
    identity: {
      version: "codeops.session-workspace-identity/v1",
      workspace: manifest,
      workflowId: "workspace-launch",
      runId: "launch-test",
      parentSessionId: null,
      forkedAtCursor: null,
    },
  };
  await lifecycle.prompt(dispatch(
    "prompt",
    { prompt: "Make durable changes." },
    workspaceSnapshot,
  ));
  const checkpoint = await lifecycle.checkpoint(
    dispatch("checkpoint", {}, workspaceSnapshot),
  );
  assert.deepEqual(checkpoint.material.evidenceReferences, [
    "artifact:99999999-9999-4999-8999-999999999999:source:repo-one",
    "artifact:99999999-9999-4999-8999-999999999999:scratch",
  ]);
  assert.equal(artifacts.length, 2);
  assert.match(artifacts[0].content.toString("utf8"), /\+after/);
  assert.match(artifacts[1].content.toString("utf8"), /Y29uc29sZS5sb2coJ2R1cmFibGUnKQo=/);
  assert.equal(checkpoint.material.version,
    "codeops.session-workspace-checkpoint-material/v2");
  assert.equal(artifacts[0].digest,
    checkpoint.material.descriptor.manifest.sourcePatches[0].digest);
  assert.equal(artifacts[1].digest,
    checkpoint.material.descriptor.manifest.scratchArtifact.digest);
  assert.equal(checkpoint.material.descriptor.manifest.totalBytes,
    artifacts[0].content.byteLength + artifacts[1].content.byteLength);
});

test("executes prompt, checkpoint, hibernate, resume, and fork through ACP identity", async () => {
  const root = await workspace();
  const baseSha = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const identity = { ...snapshot().identity, baseSha };
  await writeFile(path.join(root, "README.md"), "after\n");
  const calls = [];
  let authorityLoads = 0;
  const ids = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ];
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock",
    workspace: root,
    statePath: path.join(root, ".runtime", "sessions.json"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    now: () => new Date("2026-08-05T03:20:00.000Z"),
    uuid: () => ids.shift(),
    prepareModelAuthority: async () => { authorityLoads += 1; },
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
        return {
          response: "I made one safe edit.",
          stopReason: "end_turn",
        };
      },
      forkSession: async (sessionId, cwd) => {
        calls.push(["fork", sessionId, cwd]);
        return "acp-session-child";
      },
    }),
  });

  assert.deepEqual(
    await lifecycle.prompt(dispatch(
      "prompt",
      { prompt: "Make one safe edit." },
      { identity },
    )),
    {
      type: "prompt",
      material: {
        response: "I made one safe edit.",
        stopReason: "end_turn",
      },
    },
  );
  const checkpoint = await lifecycle.checkpoint(dispatch("checkpoint", {}, { identity }));
  assert.equal(checkpoint.type, "checkpoint");
  assert.equal(checkpoint.material.acpSessionId, "acp-session-parent");
  assert.match(checkpoint.material.patchDigest, /^sha256:[0-9a-f]{64}$/);
  const hibernate = await lifecycle.hibernate(dispatch("hibernate", {}, { identity }));
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
  assert.equal(forked.material.branch, "feat/agents-ui-fork-777777777777");
  const trustedFork = await lifecycle.fork(dispatch(
    "fork",
    {
      checkpointId: hibernate.material.checkpointId,
      parentEventCursor: 3,
      title: "Trusted Plane fork",
    },
    {
      ...hibernated,
      identity: {
        version: "codeops.temporal-session-identity/v2",
        ...identity,
        workItemId: "11111111-1111-4111-8111-111111111111",
        pullRequestNumber: 94,
        pullRequestHeadSha: baseSha,
        agentRole: "coding",
        round: 1,
        planeWorkItem: {
          version: "codeops.trusted-plane-work-item-reference/v1",
          apiOrigin: "https://plane.example.com/",
          workspaceSlug: "engineering",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          projectId: "33333333-3333-4333-8333-333333333333",
          projectIdentifier: "COAUTO",
          workItemId: "11111111-1111-4111-8111-111111111111",
          sequenceId: 19,
          reference: "COAUTO-19",
        },
      },
    },
  ));
  assert.equal(
    trustedFork.material.branch,
    "feat/agents-ui-fork-999999999999",
  );
  assert.equal("workspace" in trustedFork.material, false);
  assert.equal(authorityLoads, 2);
  assert.deepEqual(calls, [
    ["new", root],
    ["prompt", "acp-session-parent", [{ type: "text", text: "Make one safe edit." }]],
    ["load", "acp-session-parent", root],
    ["fork", "acp-session-parent", root],
    ["fork", "acp-session-parent", root],
  ]);
});

test("restores verified workspace bytes before loading ACP on the production resume path", async () => {
  const order = [];
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-resume-path-"));
  const fresh = path.join(root, "shared-recovery", ".codeops-restore-cccccccc-cccc-4ccc-8ccc-cccccccccccc-test");
  await mkdir(fresh, { recursive: true, mode: 0o700 });
  const lifecycle = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock", workspace: root,
    statePath: path.join(root, ".runtime/state.json"),
    recoveryRoot: path.join(root, "shared-recovery"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    restoreCheckpoint: async () => {
      order.push("restore");
      return { workspace: fresh, verification: {
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", descriptor: {} } };
    },
    connect: async (_dispatch, operation) => operation({
      newSession: async () => assert.fail(),
      loadSession: async (_id, cwd) => order.push(`load:${cwd}`),
      prompt: async () => assert.fail(), forkSession: async () => assert.fail(),
    }),
  });
  const state = { ...snapshot(), state: "hibernated",
    checkpoint: { checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      acpSessionId: "acp-restored" } };
  const result = await lifecycle.resume(dispatch("resume", {
    checkpointId: state.checkpoint.checkpointId,
  }, state));
  assert.deepEqual(order, ["restore", `load:${fresh}`]);
  assert.equal(result.material.restoreVerification.operationId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal("restoredPathSetDigest" in result.material, false);
  const next = new SocketAcpWorkspaceLifecycle({
    socketPath: "/run/codeops/agent.sock", workspace: root,
    statePath: path.join(root, ".runtime/state.json"),
    recoveryRoot: path.join(root, "shared-recovery"),
    permissions: { request: async () => ({ outcome: { outcome: "cancelled" } }) },
    connect: async (_dispatch, operation) => operation({
      loadSession: async (_id, cwd) => order.push(`reload:${cwd}`),
      newSession: async () => assert.fail(), forkSession: async () => assert.fail(),
      prompt: async () => ({ response: "continued", stopReason: "end_turn" }),
    }),
  });
  await next.prompt(dispatch("prompt", { generation: 2, prompt: "Continue." }, {
    ...state, generation: 2, state: "running",
  }));
  assert.equal(order.at(-1), `reload:${fresh}`);
});
