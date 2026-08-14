import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceLaunchConflictError,
  WorkspaceLaunchQuotaError,
  admitWorkspaceLaunch,
  createCatalogSourceResolver,
  readyWorkspaceLaunch,
} from "../dist/workspace-launch.js";

const request = {
  version: "codeops.workspace-launch-request/v1",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  mode: "implement",
  prompt: "Implement the bounded change.",
  sources: [{ catalogKey: "codeops" }],
};

const implementPolicy = {
  version: "codeops.session-policy/v1",
  mode: "implement",
  workspaceAccess: "bounded-writes",
  modelCalls: "allowed",
  modelPolicy: {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
};

function store({ existing = null, principalActive = 0, globalActive = 0 } = {}) {
  let created = null;
  return {
    get created() {
      return created;
    },
    async findByIdempotencyKey() {
      return existing;
    },
    async admit(input) {
      if (
        principalActive >= input.maximumActivePerPrincipal ||
        globalActive >= input.maximumActiveGlobal
      ) {
        throw new WorkspaceLaunchQuotaError("quota");
      }
      created = input;
      return input.launch;
    },
  };
}

const resolver = createCatalogSourceResolver({
  entries: new Map([
    ["codeops", { repository: "anulman/codeops", defaultRef: "main" }],
  ]),
  resolveHead: async () => "a".repeat(40),
});

test("admits one exact catalog-bound workspace launch", async () => {
  const target = store();
  const launch = await admitWorkspaceLaunch({
    request,
    principalId: "anulman@gmail.com",
    resolver,
    store: target,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(launch.state, "queued");
  assert.equal(launch.workspace.sources[0].resolvedSha, "a".repeat(40));
  assert.deepEqual(launch.policy, implementPolicy);
  assert.equal(target.created.request.prompt, request.prompt);
  assert.equal("prompt" in launch, false);
});

test("admits a scratch workspace without resolving a source", async () => {
  const target = store();
  const launch = await admitWorkspaceLaunch({
    request: { ...request, sources: [] },
    principalId: "anulman@gmail.com",
    resolver: { resolve: async () => assert.fail("must not resolve") },
    store: target,
  });
  assert.deepEqual(launch.workspace.sources, []);
});

test("binds the global launch identity to the authenticated principal", async () => {
  const first = await admitWorkspaceLaunch({
    request,
    principalId: "first@example.com",
    resolver,
    store: store(),
  });
  const second = await admitWorkspaceLaunch({
    request,
    principalId: "second@example.com",
    resolver,
    store: store(),
  });
  assert.notEqual(first.launchId, second.launchId);
});

test("replays an identical idempotent launch and rejects request drift", async () => {
  const firstStore = store();
  const first = await admitWorkspaceLaunch({
    request,
    principalId: "anulman@gmail.com",
    resolver,
    store: firstStore,
  });
  assert.equal(
    await admitWorkspaceLaunch({
      request,
      principalId: "anulman@gmail.com",
      resolver,
      store: store({ existing: first }),
    }),
    first,
  );
  await assert.rejects(
    admitWorkspaceLaunch({
      request: { ...request, prompt: "Different request." },
      principalId: "anulman@gmail.com",
      resolver,
      store: store({ existing: first }),
    }),
    WorkspaceLaunchConflictError,
  );
});

test("enforces principal and global active launch quotas", async () => {
  await assert.rejects(
    admitWorkspaceLaunch({
      request,
      principalId: "anulman@gmail.com",
      resolver,
      store: store({ principalActive: 2 }),
    }),
    WorkspaceLaunchQuotaError,
  );
  await assert.rejects(
    admitWorkspaceLaunch({
      request,
      principalId: "anulman@gmail.com",
      resolver,
      store: store({ globalActive: 8 }),
    }),
    WorkspaceLaunchQuotaError,
  );
});

test("rejects unknown sources and keeps paths server-derived", async () => {
  await assert.rejects(
    admitWorkspaceLaunch({
      request: { ...request, sources: [{ catalogKey: "unknown" }] },
      principalId: "anulman@gmail.com",
      resolver,
      store: store(),
    }),
    /not admitted/,
  );
});

test("marks a provisioned launch ready with one initial prompt identity", () => {
  const launch = {
    version: "codeops.workspace-launch/v1",
    launchId: "launch-1",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    principalId: "anulman@gmail.com",
    requestDigest: `sha256:${"a".repeat(64)}`,
    policy: implementPolicy,
    promptDigest: `sha256:${"b".repeat(64)}`,
    workspace: {
      version: "codeops.workspace/v1",
      sources: [],
      scratchPath: "scratch",
    },
    state: "provisioning",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
    deadlineAt: "2026-08-13T18:00:00.000Z",
    attemptCount: 0,
  };
  const ready = readyWorkspaceLaunch(launch, {
    sessionId: "session-1",
    initialPromptCommandId: "22222222-2222-4222-8222-222222222222",
    now: () => new Date("2026-08-13T12:01:00.000Z"),
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.sessionId, "session-1");
});
