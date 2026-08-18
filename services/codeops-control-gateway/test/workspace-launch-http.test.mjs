import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidWorkspaceLaunchRequestError,
  serveWorkspaceLaunch,
} from "../dist/workspace-launch-http.js";
import {
  WorkspaceLaunchConflictError,
  WorkspaceLaunchQuotaError,
} from "../dist/workspace-launch.js";

const token = "launch-token-0123456789-abcdefghijklmnop";
const policy = {
  version: "codeops.session-policy/v1",
  mode: "implement",
  workspaceAccess: "bounded-writes",
  modelCalls: "allowed",
  modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" },
};
const catalog = {
  version: "codeops.workspace-catalog/v1",
  repositories: [
    {
      key: "codeops",
      label: "CodeOps",
      repository: "anulman/codeops",
      defaultRef: "main",
    },
  ],
};
const launch = {
  version: "codeops.workspace-launch/v1",
  launchId: "launch-1",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  principalId: "anulman@gmail.com",
  requestDigest: `sha256:${"a".repeat(64)}`,
  policy,
  promptDigest: `sha256:${"b".repeat(64)}`,
  workspace: {
    version: "codeops.workspace/v1",
    sources: [],
    scratchPath: "scratch",
  },
  state: "queued",
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T12:00:00.000Z",
  deadlineAt: "2026-08-13T18:00:00.000Z",
  attemptCount: 0,
};
const launchDetail = {
  version: "codeops.workspace-launch-detail/v1",
  launch,
  initialPrompt: "Implement the bounded change.",
  initialPromptStatus: "accepted",
};

function request(overrides = {}) {
  return {
    method: "POST",
    url: "/v1/workspace-launches",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-codeops-principal": "anulman@gmail.com",
    },
    token,
    readBody: async () => ({
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      mode: "implement",
      prompt: "Implement the bounded change.",
      sources: [],
    }),
    catalog,
    admit: async () => launch,
    load: async () => launchDetail,
    ...overrides,
  };
}

test("serves a credential-free repository catalog", async () => {
  const result = await serveWorkspaceLaunch(
    request({ method: "GET", url: "/v1/workspace-catalog" }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.repositories[0].repository, "anulman/codeops");
  assert.equal(JSON.stringify(result.body).includes("token"), false);
});

test("creates a principal-bound launch with the launch-only bearer", async () => {
  let admitted;
  const result = await serveWorkspaceLaunch(
    request({
      admit: async (body, principalId) => {
        admitted = { body, principalId };
        return launch;
      },
    }),
  );
  assert.equal(result.status, 202);
  assert.deepEqual(admitted, {
    body: {
      version: "codeops.workspace-launch-request/v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      mode: "implement",
      prompt: "Implement the bounded change.",
      sources: [],
    },
    principalId: "anulman@gmail.com",
  });
});

test("loads only a launch owned by the authenticated principal", async () => {
  let loaded;
  const result = await serveWorkspaceLaunch(
    request({
      method: "GET",
      url: "/v1/workspace-launches/launch-1",
      load: async (launchId, principalId) => {
        loaded = { launchId, principalId };
        return launchDetail;
      },
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(loaded, {
    launchId: "launch-1",
    principalId: "anulman@gmail.com",
  });
  assert.equal(result.body.initialPrompt, "Implement the bounded change.");
  assert.equal(result.body.initialPromptStatus, "accepted");
});

test("rejects missing launch authority, principal, and JSON media type", async () => {
  assert.equal(
    (await serveWorkspaceLaunch(request({ headers: {} }))).status,
    401,
  );
  await assert.rejects(
    serveWorkspaceLaunch(
      request({
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      }),
    ),
    /principal/,
  );
  assert.equal(
    (
      await serveWorkspaceLaunch(
        request({
          headers: {
            authorization: `Bearer ${token}`,
            "x-codeops-principal": "anulman@gmail.com",
          },
        }),
      )
    ).status,
    415,
  );
});

test("ignores unrelated routes", async () => {
  assert.equal(
    await serveWorkspaceLaunch(request({ method: "GET", url: "/healthz" })),
    null,
  );
});

test("returns stable conflict and quota statuses without exposing internals", async () => {
  const conflict = await serveWorkspaceLaunch(request({
    admit: async () => {
      throw new WorkspaceLaunchConflictError("private conflict detail");
    },
  }));
  assert.deepEqual(conflict, {
    status: 409,
    body: { status: "idempotency-conflict" },
  });

  const quota = await serveWorkspaceLaunch(request({
    admit: async () => {
      throw new WorkspaceLaunchQuotaError("private quota detail");
    },
  }));
  assert.deepEqual(quota, {
    status: 429,
    body: { status: "quota-exceeded" },
  });
});

test("keeps malformed input at 400 but preserves infrastructure failures as retryable", async () => {
  await assert.rejects(
    serveWorkspaceLaunch(request({
      admit: async () => {
        throw new SyntaxError("bad json");
      },
    })),
    InvalidWorkspaceLaunchRequestError,
  );
  const upstream = new Error("GitHub resolution unavailable");
  await assert.rejects(
    serveWorkspaceLaunch(request({ admit: async () => { throw upstream; } })),
    (error) => error === upstream,
  );
});
