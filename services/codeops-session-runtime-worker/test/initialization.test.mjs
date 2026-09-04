import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJsonText } from "@codeops/codeops-contracts";
import {
  admittedChildInitialDispatchExecutor,
  SessionJobInitializer,
} from "../dist/initialization.js";
import { SessionRuntimeTransportError } from "../dist/transport.js";

const token = "i".repeat(32);
const leaseId = "11111111-1111-4111-8111-111111111111";

function request() {
  return {
    version: "codeops.session-job-initialization/v1",
    sessionId: "ses_video_1",
    identity: {
      repository: "example-org/example-repository",
      branch: "feat/agents-ui",
      baseSha: "a".repeat(40),
      workflowId: "video-proof-1",
      runId: "video-proof-job-1",
      parentSessionId: null,
      forkedAtCursor: null,
    },
    leaseId,
    holderId: "session-job:video-proof-1",
    ownerPrincipalId: "access:aidan@example.com",
  };
}

function runtimeRequest() {
  return {
    ...request(),
    version: "codeops.session-job-initialization/v3",
    runtimeProfileId: "standard-v1",
    runtimeReleaseDigest: `sha256:${"7".repeat(64)}`,
    runtimeCapabilityDigest: `sha256:${"8".repeat(64)}`,
    runtimeProfile: { version: "codeops.runtime-profile/v1", profileId: "standard-v1", releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"], capabilityDigest: `sha256:${"8".repeat(64)}`, resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 }, authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true }, compatibilityPolicyRevision: "policy-7", images: { agent: `example/agent@sha256:${"a".repeat(64)}`, worker: `example/worker@sha256:${"b".repeat(64)}`, sessionGateway: `example/gateway@sha256:${"c".repeat(64)}` } },
  };
}

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => ["prompt", "cancel", "checkpoint", "hibernate"].includes(action)
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function response(overrides = {}) {
  return {
    version: "codeops.session-job-initialization-result/v1",
    disposition: "created",
    snapshot: {
      version: "codeops.session-snapshot/v1",
      sessionId: "ses_video_1",
      generation: 1,
      state: "running",
      identity: request().identity,
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
      capabilities: capabilities(),
      updatedAt: "2026-08-05T03:15:00.000Z",
      ...overrides,
    },
  };
}

function hibernatedDuplicateResponse() {
  return {
    ...response({
      generation: 2,
      state: "hibernated",
      lease: {
        leaseId: "22222222-2222-4222-8222-222222222222",
        generation: 2,
        status: "released",
        releasedAt: "2026-08-05T03:20:00.000Z",
      },
      checkpoint: {
        version: "codeops.session-checkpoint/v1",
        checkpointId: "33333333-3333-4333-8333-333333333333",
        sessionId: "ses_video_1",
        generation: 2,
        baseSha: "a".repeat(40),
        patchDigest: `sha256:${"b".repeat(64)}`,
        acpSessionId: "acp-session-video-1",
        eventCursor: 10,
        evidenceReferences: [],
        createdAt: "2026-08-05T03:20:00.000Z",
      },
      eventCursor: 10,
      capabilities: capabilities().map((capability) =>
        capability.action === "resume" || capability.action === "fork"
          ? { action: capability.action, availability: "enabled" }
          : capability.action === "archive"
            ? { action: capability.action, availability: "enabled" }
            : { action: capability.action, availability: "disabled", reason: "Unavailable." }),
      updatedAt: "2026-08-05T03:20:00.000Z",
    }),
    disposition: "duplicate",
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

test("initializes one exact root session through the Job-only bearer", async () => {
  const calls = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return json(response());
    },
  });
  const result = await initializer.initialize(request());
  assert.equal(result.disposition, "created");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://codeops-control-gateway:8080/v1/session-jobs/initializations",
  );
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(calls[0].body, request());
});

test("never downgrades a bound initialization after an exact invalid request", async () => {
  const bodies = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return json({ status: "invalid-request" }, 400);
    },
  });
  await assert.rejects(
    initializer.initialize(runtimeRequest()),
    SessionRuntimeTransportError,
  );
  assert.deepEqual(bodies, [runtimeRequest()]);
});

test("uses the runtime tuple without retry through a new gateway", async () => {
  const calls = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return json(response());
    },
  });
  assert.equal((await initializer.initialize(runtimeRequest())).disposition, "created");
  assert.deepEqual(calls, [{
    url: "http://codeops-control-gateway:8080/v2/session-jobs/initializations",
    body: runtimeRequest(),
  }]);
});

test("retries the exact bound request across old and new gateway replicas", async () => {
  const calls = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    retryDelaysMs: [0, 0],
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return calls.length < 3
        ? json({ status: "not-found" }, 404)
        : json(response());
    },
  });
  assert.equal((await initializer.initialize(runtimeRequest())).disposition, "created");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url }) =>
    url === "http://codeops-control-gateway:8080/v2/session-jobs/initializations"));
  assert.ok(calls.every(({ body }) =>
    JSON.stringify(body) === JSON.stringify(runtimeRequest())));
});

test("recovers an ambiguous created request through the idempotent duplicate", async () => {
  const bodies = [];
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    retryDelaysMs: [0],
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) throw new TypeError("response connection closed");
      return json({ ...response(), disposition: "duplicate" });
    },
  });
  assert.equal((await initializer.initialize(runtimeRequest())).disposition, "duplicate");
  assert.deepEqual(bodies, [runtimeRequest(), runtimeRequest()]);
});

test("fails closed after old-only replicas and recovers on a later exact attempt", async () => {
  const bodies = [];
  let rolledOut = false;
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    retryDelaysMs: [],
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return rolledOut
        ? json({ ...response(), disposition: "duplicate" })
        : json({ status: "not-found" }, 404);
    },
  });
  await assert.rejects(
    initializer.initialize(runtimeRequest()),
    SessionRuntimeTransportError,
  );
  rolledOut = true;
  assert.equal((await initializer.initialize(runtimeRequest())).disposition, "duplicate");
  assert.deepEqual(bodies, [runtimeRequest(), runtimeRequest()]);
});

test("rejects a valid-looking response that drifts from the Job root", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(response({ sessionId: "ses_other" })),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

test("rejects drift in optional CodeOps session identity", async () => {
  const codeOpsRequest = {
    ...request(),
    identity: {
      ...request().identity,
      workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
      agentRole: "coding",
      round: 1,
    },
  };
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(response()),
  });
  await assert.rejects(
    initializer.initialize(codeOpsRequest),
    /root identity/,
  );
});

test("accepts an exact duplicate root whose successor lease was released", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json(hibernatedDuplicateResponse()),
  });
  const result = await initializer.initialize(request());
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.snapshot.state, "hibernated");
  assert.equal(result.snapshot.lease.status, "released");
  assert.notEqual(result.snapshot.lease.leaseId, request().leaseId);
});

test("rejects a created root without the exact requested active lease", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json({
      ...hibernatedDuplicateResponse(),
      disposition: "created",
    }),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

test("rejects immutable model authority injected at Job initialization", async () => {
  const initializer = new SessionJobInitializer({
    gatewayOrigin: "https://gateway.example.test",
    token,
    fetch: async () => json({ ...response(), modelProxyToken: "v1.stale.signature" }),
  });
  await assert.rejects(
    initializer.initialize(request()),
    SessionRuntimeTransportError,
  );
});

function admittedRequest() {
  const bytes = Buffer.from("exact admitted context\n");
  const descriptor = { attachmentId: "brief", name: "brief.txt", mimeType: "text/plain",
    sizeBytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  return { version: "codeops.session-job-initialization/v3",
    admissionId: "22222222-2222-4222-8222-222222222222",
    approvalId: "33333333-3333-4333-8333-333333333333",
    dispatchId: "44444444-4444-4444-8444-444444444444",
    inputDigest: `sha256:${"d".repeat(64)}`, sessionId: "session-child", generation: 1,
    identity: { version: "codeops.session-workspace-identity/v1",
      policy: { version: "codeops.session-policy/v1", mode: "implement",
        workspaceAccess: "bounded-writes", modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } },
      contextAttachments: [descriptor], workspace: { version: "codeops.workspace/v1",
        sources: [{ catalogKey: "codeops", repository: "example-org/example-repository",
          checkoutPath: "sources/codeops", requestedRef: "main", resolvedSha: "a".repeat(40) }],
        scratchPath: "scratch" }, workflowId: "workflow-1", runId: "run-1",
      parentSessionId: "session-parent", forkedAtCursor: 2 },
    leaseId, holderId: "runtime-worker:child", ownerPrincipalId: "access:aidan@example.com",
    parentSessionId: "session-parent", repository: "example-org/example-repository",
    sourceSha: "a".repeat(40), workItemId: "work-item-1", profile: "custom",
    release: "v0.5.0-alpha.58", images: {
      agent: `registry.example/agent@sha256:${"a".repeat(64)}`,
      runtimeWorker: `registry.example/worker@sha256:${"b".repeat(64)}` },
    runtimeProfileId: runtimeRequest().runtimeProfileId,
    runtimeReleaseDigest: runtimeRequest().runtimeReleaseDigest,
    runtimeCapabilityDigest: runtimeRequest().runtimeCapabilityDigest,
    runtimeProfile: runtimeRequest().runtimeProfile,
    attachment: { ...descriptor, content: bytes.toString("base64") } };
}

test("accepts exact admitted-child bytes and rejects missing or altered bytes", async () => {
  const { attachment, ...request } = admittedRequest();
  const initialDispatchDigest = dispatchDigest(admittedDispatch(request));
  const admittedResponse = { ...response({ sessionId: request.sessionId,
    identity: request.identity, lease: { leaseId, generation: 1, status: "active",
      holderId: request.holderId, acquiredAt: "2026-08-05T03:15:00.000Z",
      expiresAt: "2026-08-05T04:15:00.000Z" } }), disposition: "duplicate",
    contextAttachments: [attachment], initialDispatchDigest };
  const exact = new SessionJobInitializer({ gatewayOrigin: "https://gateway.example.test", token,
    fetch: async () => json(admittedResponse) });
  assert.equal((await exact.initialize(request)).contextAttachments[0].content, attachment.content);
  for (const contextAttachments of [undefined,
    [{ ...attachment, content: Buffer.from("altered").toString("base64") }]]) {
    const initializer = new SessionJobInitializer({ gatewayOrigin: "https://gateway.example.test", token,
      fetch: async () => json({ ...admittedResponse, contextAttachments }) });
    await assert.rejects(initializer.initialize(request), SessionRuntimeTransportError);
  }
});

function admittedDispatch(request, dispatchId = request.dispatchId, type = "prompt") {
  const snapshot = response({ sessionId: request.sessionId, identity: request.identity,
    lease: { leaseId, generation: 1, status: "active", holderId: request.holderId,
      acquiredAt: "2026-08-05T03:15:00.000Z", expiresAt: "2026-08-05T04:15:00.000Z" } }).snapshot;
  return { version: "codeops.session-runtime-dispatch/v1", dispatchId,
    principalId: request.ownerPrincipalId,
    command: { version: "codeops.session-command/v1", sessionId: request.sessionId,
      generation: 1, leaseId, idempotencyKey: "77777777-7777-4777-8777-777777777777",
      type, ...(type === "prompt" ? { prompt: "Implement it." } : {}) }, snapshot,
    dispatchedAt: "2026-08-05T03:20:00.000Z" };
}

function dispatchDigest(dispatch) {
  return `sha256:${createHash("sha256").update(canonicalJsonText(dispatch)).digest("hex")}`;
}

test("restores bytes only to the exact initial dispatch and passes later dispatches unchanged", async () => {
  const { attachment, ...request } = admittedRequest();
  const seen = []; const seenContexts = []; let permissionContinuations = 0;
  const initial = admittedDispatch(request);
  const execute = admittedChildInitialDispatchExecutor({
    initialDispatchDigest: dispatchDigest(initial), contextAttachments: [attachment],
    execute: async (dispatch, context) => {
      seen.push(dispatch); seenContexts.push(context);
      if (context.requestPermission !== undefined) await context.requestPermission();
      return { ok: true };
    } });
  await execute(initial, { isAdmittedInitialDispatch: true });
  assert.deepEqual(seen[0].command.contextAttachments, [attachment]);
  assert.equal(initial.command.contextAttachments, undefined);
  const laterPrompt = admittedDispatch(request, "99999999-9999-4999-8999-999999999999");
  const laterContinuation = admittedDispatch(request,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "checkpoint");
  const permissionContinuation = { isAdmittedInitialDispatch: false,
    requestPermission: async () => {
    permissionContinuations += 1; return { outcome: "selected", optionId: "allow" };
  } };
  await execute(laterPrompt, { isAdmittedInitialDispatch: false });
  await execute(laterContinuation, permissionContinuation);
  assert.equal(seen[1], laterPrompt);
  assert.equal(seen[2], laterContinuation);
  assert.equal(seenContexts[2], permissionContinuation);
  assert.equal(permissionContinuations, 1);
});

test("rejects a mismatched initial admitted dispatch before execution", async () => {
  const { attachment, ...request } = admittedRequest();
  let calls = 0;
  const initial = admittedDispatch(request);
  const execute = admittedChildInitialDispatchExecutor({ initialDispatchDigest: dispatchDigest(initial),
    contextAttachments: [attachment], execute: async () => { calls += 1; } });
  await assert.rejects(execute(admittedDispatch(request,
    "99999999-9999-4999-8999-999999999999"),
  { isAdmittedInitialDispatch: true }), /initial dispatch marker or identity drifted/);
  assert.equal(calls, 0);
});

test("rejects a same-ID initial dispatch with an altered prompt", async () => {
  const { attachment, ...request } = admittedRequest();
  const initial = admittedDispatch(request); let calls = 0;
  const execute = admittedChildInitialDispatchExecutor({ initialDispatchDigest: dispatchDigest(initial),
    contextAttachments: [attachment], execute: async () => { calls += 1; } });
  await assert.rejects(execute({ ...initial,
    command: { ...initial.command, prompt: "Altered after admission." } },
  { isAdmittedInitialDispatch: true }), /initial dispatch marker or identity drifted/);
  assert.equal(calls, 0);
});

test("rejects a forged false initial marker", async () => {
  const { attachment, ...request } = admittedRequest();
  const initial = admittedDispatch(request); let calls = 0;
  const execute = admittedChildInitialDispatchExecutor({ initialDispatchDigest: dispatchDigest(initial),
    contextAttachments: [attachment], execute: async () => { calls += 1; } });
  await assert.rejects(execute(initial, { isAdmittedInitialDispatch: false }),
    /initial dispatch marker or identity drifted/);
  assert.equal(calls, 0);
});

test("a replacement worker accepts a later dispatch after the initial row completed", async () => {
  const { attachment, ...request } = admittedRequest();
  const initial = admittedDispatch(request); let seen;
  const replacementExecute = admittedChildInitialDispatchExecutor({
    initialDispatchDigest: dispatchDigest(initial), contextAttachments: [attachment],
    execute: async (dispatch) => { seen = dispatch; },
  });
  const later = admittedDispatch(request, "99999999-9999-4999-8999-999999999999");
  await replacementExecute(later, { isAdmittedInitialDispatch: false });
  assert.equal(seen, later);
  assert.equal(seen.command.contextAttachments, undefined);
});

test("keeps empty admitted context attachments omitted from the initial command", async () => {
  const { attachment: _attachment, ...request } = admittedRequest();
  request.identity.contextAttachments = [];
  const initial = admittedDispatch(request); let seen;
  const execute = admittedChildInitialDispatchExecutor({
    initialDispatchDigest: dispatchDigest(initial), contextAttachments: [],
    execute: async (dispatch) => { seen = dispatch; },
  });
  await execute(initial, { isAdmittedInitialDispatch: true });
  assert.equal("contextAttachments" in seen.command, false);
});

test("inherits strict origin, token, status, type, and body bounds", async () => {
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://user@gateway.test",
      token,
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test/path",
      token,
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test",
      token: "short",
    }),
    SessionRuntimeTransportError,
  );
  for (const raw of [
    new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    json({}, 200, { "content-length": String(1024 * 1024 + 1) }),
  ]) {
    const initializer = new SessionJobInitializer({
      gatewayOrigin: "https://gateway.test",
      token,
      fetch: async () => raw,
    });
    await assert.rejects(
      initializer.initialize(request()),
      SessionRuntimeTransportError,
    );
  }
});
