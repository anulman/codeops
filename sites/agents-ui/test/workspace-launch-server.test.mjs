import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createWorkspaceLaunchClient,
} from "../src/lib/workspaceLaunch.server.ts";

const token = "l".repeat(32);
const contextAttachment = {
  attachmentId: "context-estimator-notes",
  name: "estimator-notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  digest: `sha256:${"c".repeat(64)}`,
  content: "aGVsbG8=",
};
const contextAttachmentDescriptor = (({ content: _content, ...descriptor }) => descriptor)(contextAttachment);
const launch = {
  version: "codeops.workspace-launch/v1",
  launchId: "launch-91a4",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  principalId: "operator@example.com",
  requestDigest: `sha256:${"a".repeat(64)}`,
  policy: {
    version: "codeops.session-policy/v1",
    mode: "plan",
    workspaceAccess: "read-only",
    modelCalls: "allowed",
    modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
  },
  contextAttachments: [contextAttachmentDescriptor],
  promptDigest: `sha256:${"b".repeat(64)}`,
  workspace: {
    version: "codeops.workspace/v1",
    sources: [],
    scratchPath: "scratch",
  },
  state: "queued",
  createdAt: "2026-08-13T13:00:00.000Z",
  updatedAt: "2026-08-13T13:00:00.000Z",
  deadlineAt: "2026-08-13T19:00:00.000Z",
  attemptCount: 0,
};
const launchDetail = {
  version: "codeops.workspace-launch-detail/v1",
  launch,
  initialPrompt: "Create a one-off script.",
  initialPromptStatus: "accepted",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("launch client keeps authority server-side and binds the principal", async () => {
  const calls = [];
  const client = createWorkspaceLaunchClient({
    baseUrl: new URL("https://launcher.example/"),
    token,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return json(launch, 202);
    },
  });
  const request = {
    version: "codeops.workspace-launch-request/v1",
    idempotencyKey: launch.idempotencyKey,
    mode: "plan",
    prompt: "Create a one-off script.",
    contextAttachments: [contextAttachment],
    sources: [],
  };
  assert.deepEqual(
    await client.createLaunch({ request, principalId: launch.principalId }),
    launch,
  );
  assert.equal(calls[0].url, "https://launcher.example/v1/workspace-launches");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers["X-CodeOps-Principal"], launch.principalId);
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal("prompt" in launch, false);
  assert.equal("content" in launch.contextAttachments[0], false);
});

test("catalog and launch reads validate responses and exact identities", async () => {
  const catalog = {
    version: "codeops.workspace-catalog/v1",
    repositories: [{
      key: "codeops",
      label: "CodeOps",
      repository: "anulman/codeops",
      defaultRef: "main",
    }],
  };
  const responses = [json(catalog), json(launchDetail)];
  const calls = [];
  const client = createWorkspaceLaunchClient({
    baseUrl: new URL("https://launcher.example/"),
    token,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return responses.shift();
    },
  });
  assert.deepEqual(await client.getCatalog(), catalog);
  assert.deepEqual(
    await client.getLaunch({
      launchId: launch.launchId,
      principalId: launch.principalId,
    }),
    launchDetail,
  );
  assert.equal(calls[1].url, `https://launcher.example/v1/workspace-launches/${launch.launchId}`);
  assert.equal(calls[1].init.headers["X-CodeOps-Principal"], launch.principalId);
});

test("launch server functions bind the private UI context and no browser token", async () => {
  const [dataSource, routeSource, sessionRouteSource, identitySource] = await Promise.all([
    readFile(new URL("../src/lib/workspaceLaunch.data.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/new.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/sessions.$sessionId.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/sessionIdentity.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(
    (dataSource.match(/\.middleware\(\[sessionOwnerContextMiddleware\]\)/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(dataSource, /TOKEN_FILE|readFile/);
  assert.match(routeSource, /Scratch workspace/);
  assert.match(routeSource, /Create session/);
  assert.match(routeSource, /Session mode/);
  assert.match(routeSource, /Validate is deterministic and uses no model/);
  assert.match(routeSource, /Context files/);
  assert.match(routeSource, /contextAttachments/);
  assert.match(sessionRouteSource, /ContextAttachmentList/);
  assert.match(routeSource, /crypto\.randomUUID\(\)/);
  assert.match(routeSource, /workspaceLaunchSessionId\(launch\.launchId\)/);
  assert.doesNotMatch(routeSource, /launch\.state === "ready"/);
  assert.match(sessionRouteSource, /Preparing your workspace/);
  assert.match(sessionRouteSource, /Initial prompt/);
  assert.match(sessionRouteSource, /initialPromptStatus === "accepted"/);
  assert.match(sessionRouteSource, /getWorkspaceLaunch/);
  assert.match(sessionRouteSource, /router\.invalidate\(\)/);
  assert.match(identitySource, /identity\.displayName \?\? identity\.runId/);
  assert.doesNotMatch(routeSource, /cloneUrl|image|serviceAccount|token/i);
});

test("optional metadata refuses only transport outages, preserving auth and schema errors", async () => {
  const { readOptionalLaunch } = await import("../src/lib/workspaceLaunch.server.ts");
  const input = { launchId: launch.launchId, principalId: launch.principalId };
  const client = (fetch) => createWorkspaceLaunchClient({baseUrl: new URL("https://launcher.example/"), token, fetch});
  for (const status of [502,503,504]) {
    assert.deepEqual(await readOptionalLaunch(client(async () => json({},status)), input), { unavailable:true, detail:null });
  }
  for (const error of [new DOMException("timeout", "TimeoutError"), new TypeError("fetch failed", {cause:{code:"ECONNREFUSED"}})]) {
    assert.deepEqual(await readOptionalLaunch(client(async () => {throw error}), input), {unavailable:true,detail:null});
  }
  for (const status of [401,403,500]) {
    await assert.rejects(readOptionalLaunch(client(async () => json({},status)),input), /returned status/);
  }
  await assert.rejects(readOptionalLaunch(client(async () => json({invalid:true})),input));
  await assert.rejects(readOptionalLaunch(client(async () => {throw new TypeError("bug")}),input), /bug/);
  assert.deepEqual(await readOptionalLaunch(client(async () => json({},404)),input), {unavailable:false,detail:null});
  assert.deepEqual(await readOptionalLaunch(client(async () => json(launchDetail)),input), {unavailable:false,detail:launchDetail});
});
