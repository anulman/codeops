import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildSessionRuntimeCompletion,
  SessionRuntimeClaimUnavailableError,
  SessionRuntimeTransport,
  SessionRuntimeTransportError,
} from "../dist/transport.js";

const token = "w".repeat(32);
const dispatchId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const leaseId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const promptResult = {
  type: "prompt",
  material: {
    response: "I completed the bounded implementation.",
    stopReason: "end_turn",
  },
};

const canonical = (value) => JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key,
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) =>
          left.localeCompare(right)))
        : nested]),
));

const authority = {
  runtimeProfileId: "standard-v1",
  runtimeReleaseDigest: `sha256:${"7".repeat(64)}`,
  runtimeCapabilityDigest: `sha256:${"8".repeat(64)}`,
  runtimeProfile: { version: "codeops.runtime-profile/v1", profileId: "standard-v1", releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"], capabilityDigest: `sha256:${"8".repeat(64)}`, resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 }, authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true }, compatibilityPolicyRevision: "policy-7", images: { agent: `example/agent@sha256:${"a".repeat(64)}`, worker: `example/worker@sha256:${"b".repeat(64)}`, sessionGateway: `example/gateway@sha256:${"c".repeat(64)}` } },
  sessionId: "ses_91a4",
  generation: 3,
  leaseId,
  identity: {
    repository: "example-org/example-repository",
    branch: "feat/agents-ui",
    baseSha: "a".repeat(40),
    workflowId: "workflow-155",
    runId: "run-155",
    parentSessionId: null,
    forkedAtCursor: null,
  },
};

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function claim() {
  return {
    dispatch: {
      version: "codeops.session-runtime-dispatch/v1",
      dispatchId,
      principalId: "access:aidan@example.com",
      command: {
        version: "codeops.session-command/v1",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        prompt: "Continue the bounded implementation.",
      },
      snapshot: {
        version: "codeops.session-snapshot/v1",
        sessionId: "ses_91a4",
        generation: 3,
        state: "running",
        identity: {
          repository: "example-org/example-repository",
          branch: "feat/agents-ui",
          baseSha: "a".repeat(40),
          workflowId: "workflow-155",
          runId: "run-155",
          parentSessionId: null,
          forkedAtCursor: null,
        },
        lease: {
          leaseId,
          generation: 3,
          status: "active",
          holderId: "worker-3",
          acquiredAt: "2026-08-04T20:00:00.000Z",
          expiresAt: "2026-08-04T21:00:00.000Z",
        },
        checkpoint: null,
        pendingPermission: null,
        eventCursor: 184,
        capabilities: capabilities(),
        updatedAt: "2026-08-04T20:00:00.000Z",
      },
      dispatchedAt: "2026-08-04T20:00:00.000Z",
    },
    claimToken,
    claimExpiresAt: "2026-08-04T20:05:00.000Z",
    claimCount: 1,
    isAdmittedInitialDispatch: false,
    runtimeBinding: {
      version: "codeops.runtime-binding/v1",
      requirementDigest: `sha256:${"6".repeat(64)}`,
      compatibilityPolicyRevision: "policy-7",
      selectedProfileId: "standard-v1",
      selectedReleaseDigest: `sha256:${"7".repeat(64)}`,
     selectedCapabilityDigest: `sha256:${"8".repeat(64)}`,
      selectedProfile: { version: "codeops.runtime-profile/v1", profileId: "standard-v1", releaseDigest: `sha256:${"7".repeat(64)}`, capabilities: ["acp"], capabilityDigest: `sha256:${"8".repeat(64)}`, resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 }, authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true }, compatibilityPolicyRevision: "policy-7", images: { agent: `example/agent@sha256:${"a".repeat(64)}`, worker: `example/worker@sha256:${"b".repeat(64)}`, sessionGateway: `example/gateway@sha256:${"c".repeat(64)}` } },
      selectedAt: "2026-08-04T20:00:00.000Z",
    },
  };
}

test("renews an exact claim without changing its authority", async () => {
  const original = claim();
  const renewed = { ...original, claimExpiresAt: "2026-08-04T20:10:00.000Z" };
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080", token, authority,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return json({ version: "codeops.session-runtime-claim-renewal-result/v1", claim: renewed });
    },
  });
  assert.deepEqual(await transport.renewClaim(original, 600_000), renewed);
  assert.equal(requests[0].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/claim-renewal`);
  assert.deepEqual(requests[0].body, {
    version: "codeops.session-runtime-claim-renewal-request/v1", claimToken, leaseMs: 600_000,
  });
});

function completion(overrides = {}) {
  return {
    version: "codeops.session-runtime-completion/v1",
    dispatchId,
    sessionId: "ses_91a4",
    generation: 3,
    leaseId,
    idempotencyKey,
    observedEventCursor: 184,
    type: "prompt",
    material: promptResult.material,
    completedAt: "2026-08-04T20:03:00.000Z",
    ...overrides,
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

test("transports at most 2000 retained ACP timeline updates", () => {
  const updates = Array.from({ length: 2_000 }, () => ({
    kind: "current_mode",
    modeId: "code",
  }));
  assert.equal(buildSessionRuntimeCompletion(claim(), {
    ...promptResult,
    material: { ...promptResult.material, updates },
  }, new Date("2026-08-04T20:03:00.000Z")).material.updates.length, 2_000);
  assert.throws(() => buildSessionRuntimeCompletion(claim(), {
    ...promptResult,
    material: { ...promptResult.material, updates: [...updates, updates[0]] },
  }, new Date("2026-08-04T20:03:00.000Z")));
});

test("claims and completes one exact dispatch through the worker-only boundary", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    authority,
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      if (url.endsWith("/claims")) {
        return json({
          version: "codeops.session-runtime-claim-response/v2",
          claim: claim(),
        });
      }
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 186,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 186 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });

  const tokenOrder = [];
  const result = await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    onClaimAuthenticated: () => tokenOrder.push("claim-authenticated"),
    execute: async (runtimeDispatch) => {
      tokenOrder.push("execute");
      assert.deepEqual(runtimeDispatch, claim().dispatch);
      assert.equal("claimToken" in runtimeDispatch, false);
      return promptResult;
    },
  });
  assert.equal(result.disposition, "committed");
  assert.deepEqual(tokenOrder, ["claim-authenticated", "execute"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(requests[0].body, {
    version: "codeops.session-runtime-claim-request/v2",
    ...authority,
    leaseMs: 300_000,
  });
  assert.equal(
    requests[1].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/completions`,
  );
  assert.equal(requests[1].body.claimToken, claimToken);
  assert.deepEqual(requests[1].body.completion, completion());
});

test("returns null without invoking the executor when no dispatch is available", async () => {
  let executed = false;
  let authenticated = false;
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    authority,
    fetch: async () => json({
      version: "codeops.session-runtime-claim-response/v2",
      claim: null,
    }),
  });
  assert.equal(await transport.runOne({
    leaseMs: 1_000,
    execute: async () => {
      executed = true;
      return completion();
    },
    onClaimAuthenticated: () => { authenticated = true; },
  }), null);
  assert.equal(executed, false);
  assert.equal(authenticated, false);
});

test("rejects a claim proof from another same-profile release", async () => {
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    authority,
    fetch: async () => json({
      version: "codeops.session-runtime-claim-response/v2",
      claim: {
        ...claim(),
        runtimeBinding: {
          ...claim().runtimeBinding,
          selectedReleaseDigest: `sha256:${"9".repeat(64)}`,
          selectedProfile: {
            ...claim().runtimeBinding.selectedProfile,
            releaseDigest: `sha256:${"9".repeat(64)}`,
          },
        },
      },
    }),
  });
  await assert.rejects(transport.claim(1_000), /claim proof drifted/);
});

test("classifies old and unavailable gateway claim endpoints as rollout-retryable", async () => {
  for (const response of [
    json({ status: "invalid-request" }, 400),
    json({
      version: "codeops.session-runtime-claim-response/v1",
      claim: null,
    }),
  ]) {
    const transport = new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.example.test",
      token,
      authority,
      fetch: async () => response,
    });
    await assert.rejects(
      transport.claim(1_000),
      SessionRuntimeClaimUnavailableError,
    );
  }
});

test("loads fresh model authority only through the hidden live claim", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    authority,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith("/claims")) return json({
        version: "codeops.session-runtime-claim-response/v2",
        claim: claim(),
      });
      if (url.endsWith("/model-authority")) return json({
        version: "codeops.session-runtime-model-authority-result/v1",
        dispatchId,
        modelProxyToken: `v1.${"a".repeat(32)}.${"b".repeat(43)}`,
        expiresAt: "2026-08-04T20:45:00.000Z",
      });
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 186,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 186 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });
  await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    execute: async (_dispatch, context) => {
      assert.equal("claimToken" in context, false);
      const modelAuthority = await context.issueModelAuthority();
      assert.equal(modelAuthority.dispatchId, dispatchId);
      return promptResult;
    },
  });
  assert.equal(
    requests[1].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/model-authority`,
  );
  assert.deepEqual(requests[1].body, {
    version: "codeops.session-runtime-model-authority-request/v1",
    claimToken,
  });
});

test("relays permission through a claim-hidden executor callback", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    authority,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith("/claims")) {
        return json({
          version: "codeops.session-runtime-claim-response/v2",
          claim: claim(),
        });
      }
      if (url.endsWith("/permissions")) {
        return json({
          version: "codeops.session-runtime-permission-result/v1",
          dispatchId,
          requestId: "permission-1",
          disposition: "pending",
          decision: null,
        });
      }
      if (url.endsWith("/permissions/permission-1/poll")) {
        return json({
          version: "codeops.session-runtime-permission-result/v1",
          dispatchId,
          requestId: "permission-1",
          disposition: "decided",
          decision: {
            outcome: "selected",
            acpOptionId: "opaque-allow-once",
          },
        });
      }
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 186,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 186 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });
  const result = await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    execute: async (_dispatch, context) => {
      assert.equal("claimToken" in context, false);
      assert.deepEqual(await context.requestPermission({
        request: {
          requestId: "permission-1",
          title: "Allow write?",
          description: "The agent wants to update one file.",
          operation: {
            kind: "file_change",
            changes: [{ path: "README.md", oldText: "before", newText: "after" }],
          },
          operationDigest: `sha256:${"a".repeat(64)}`,
          options: [{ optionId: "allow-once", label: "Allow once" }],
          requestedAt: "2026-08-04T20:01:00.000Z",
        },
        acpSessionId: "acp-session-1",
        toolCallId: "tool-call-1",
        options: [{ optionId: "allow-once", acpOptionId: "opaque-allow-once" }],
      }), {
        outcome: "selected",
        acpOptionId: "opaque-allow-once",
      });
      return promptResult;
    },
  });
  assert.equal(result.disposition, "committed");
  assert.equal(requests[1].body.claimToken, claimToken);
  assert.equal(requests[2].body.claimToken, claimToken);
  assert.equal(requests[3].body.claimToken, claimToken);
});

test("relays a bounded GitHub read through hidden live-claim authority", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    authority,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith("/claims")) {
        return json({
          version: "codeops.session-runtime-claim-response/v2",
          claim: claim(),
        });
      }
      if (url.endsWith("/github-reads")) {
        return json({
          version: "codeops.github-search-result/v1",
          repository: "example-org/example-repository",
          kind: "pull_requests",
          query: "is:open runtime",
          items: [],
          truncated: false,
        });
      }
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 186,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 186 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });

  await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    execute: async (_dispatch, context) => {
      assert.equal("claimToken" in context, false);
      const result = await context.readGitHub({
        operation: "search",
        operationId: `githubread-${"b".repeat(64)}`,
        input: {
          repository: "example-org/example-repository",
          kind: "pull_requests",
          query: "is:open runtime",
          limit: 5,
        },
      });
      assert.equal(result.version, "codeops.github-search-result/v1");
      return promptResult;
    },
  });

  assert.equal(
    requests[1].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/github-reads`,
  );
  assert.deepEqual(requests[1].body, {
    version: "codeops.session-runtime-github-read-request/v1",
    claimToken,
    operation: "search",
    operationId: `githubread-${"b".repeat(64)}`,
    input: {
      repository: "example-org/example-repository",
      kind: "pull_requests",
      query: "is:open runtime",
      limit: 5,
    },
  });
});

test("relays a permission-bound GitHub mutation through hidden live-claim authority", async () => {
  const requests = [];
  const transport = new SessionRuntimeTransport({
    gatewayOrigin: "http://codeops-control-gateway:8080",
    token,
    authority,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith("/claims")) {
        return json({
          version: "codeops.session-runtime-claim-response/v2",
          claim: claim(),
        });
      }
      if (url.endsWith("/github-mutations")) {
        return json({
          version: "codeops.github-check-rerun-result/v1",
          repository: "example-org/example-repository",
          operationId: `githubmutation-${"b".repeat(64)}`,
          headSha: "a".repeat(40),
          checkRunId: 1234,
          accepted: true,
        });
      }
      return json({
        version: "codeops.session-command-result/v1",
        commandId: "66666666-6666-4666-8666-666666666666",
        sessionId: "ses_91a4",
        generation: 3,
        leaseId,
        idempotencyKey,
        type: "prompt",
        eventCursor: 186,
        snapshot: { ...claim().dispatch.snapshot, eventCursor: 186 },
        committedAt: "2026-08-04T20:03:01.000Z",
        disposition: "committed",
      });
    },
  });

  await transport.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:03:00.000Z"),
    execute: async (_dispatch, context) => {
      assert.equal("claimToken" in context, false);
      const boundInput = {
        repository: "example-org/example-repository",
        expectedHeadSha: "a".repeat(40), checkRunId: 1234,
      };
      assert.equal(context.bindGitHubMutationOperationId(
        "check_rerun", boundInput,
      ), `githubmutation-${createHash("sha256").update(canonical({
        dispatchId, claimToken, operation: "check_rerun", input: boundInput,
      })).digest("hex")}`);
      const result = await context.mutateGitHub({
        operation: "check_rerun",
        operationId: `githubmutation-${"b".repeat(64)}`,
        input: {
          repository: "example-org/example-repository",
          expectedHeadSha: "a".repeat(40),
          checkRunId: 1234,
        },
      });
      assert.equal(result.version, "codeops.github-check-rerun-result/v1");
      return promptResult;
    },
  });

  assert.equal(
    requests[1].url,
    `http://codeops-control-gateway:8080/v1/session-runtime/dispatches/${dispatchId}/github-mutations`,
  );
  assert.deepEqual(requests[1].body, {
    version: "codeops.session-runtime-github-mutation-request/v1",
    claimToken,
    operation: "check_rerun",
    operationId: `githubmutation-${"b".repeat(64)}`,
    input: {
      repository: "example-org/example-repository",
      expectedHeadSha: "a".repeat(40),
      checkRunId: 1234,
    },
  });
});

test("builds the completion envelope from the claim instead of trusting the executor", () => {
  assert.deepEqual(
    buildSessionRuntimeCompletion(
      claim(),
      promptResult,
      new Date("2026-08-04T20:03:00.000Z"),
    ),
    completion(),
  );
  assert.throws(
    () => buildSessionRuntimeCompletion(
      claim(),
      { ...promptResult, dispatchId: "77777777-7777-4777-8777-777777777777" },
      new Date("2026-08-04T20:03:00.000Z"),
    ),
  );
  assert.throws(
    () => buildSessionRuntimeCompletion(
      claim(),
      {
        type: "checkpoint",
        material: {
          checkpointId: "77777777-7777-4777-8777-777777777777",
          patchDigest: `sha256:${"a".repeat(64)}`,
          acpSessionId: "acp-7",
          evidenceReferences: [],
        },
      },
      new Date("2026-08-04T20:03:00.000Z"),
    ),
    SessionRuntimeTransportError,
  );
});

test("rejects identity drift and expired claims before completion crosses the network", async () => {
  let completeCalls = 0;
  const direct = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    authority,
    fetch: async () => {
      completeCalls += 1;
      return json({});
    },
  });
  await assert.rejects(
    direct.complete(
      claim(),
      completion({ dispatchId: "77777777-7777-4777-8777-777777777777" }),
      () => new Date("2026-08-04T20:03:00.000Z"),
    ),
    SessionRuntimeTransportError,
  );
  assert.equal(completeCalls, 0);

  let claimCalls = 0;
  let executed = false;
  const expired = new SessionRuntimeTransport({
    gatewayOrigin: "https://gateway.example.test",
    token,
    authority,
    fetch: async () => {
      claimCalls += 1;
      return json({
        version: "codeops.session-runtime-claim-response/v2",
        claim: claim(),
      });
    },
  });
  await assert.rejects(expired.runOne({
    leaseMs: 300_000,
    now: () => new Date("2026-08-04T20:05:00.000Z"),
    execute: async () => {
      executed = true;
      return promptResult;
    },
  }), SessionRuntimeTransportError);
  assert.equal(claimCalls, 1);
  assert.equal(executed, false);
});

test("fails closed on ambiguous origins, credentials, response types, and body bounds", async () => {
  for (const gatewayOrigin of [
    "https://user@gateway.test",
    "https://gateway.test/path",
    "ftp://gateway.test",
  ]) {
    assert.throws(
      () => new SessionRuntimeTransport({ gatewayOrigin, token, authority }),
      SessionRuntimeTransportError,
    );
  }
  assert.throws(
    () => new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token: " short ",
      authority,
    }),
    SessionRuntimeTransportError,
  );
  assert.throws(
    () => new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token,
      authority,
      requestTimeoutMs: 999,
    }),
    SessionRuntimeTransportError,
  );

  for (const response of [
    new Response("no", { status: 503, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    json({}, 200, { "content-length": String(1024 * 1024 + 1) }),
    new Response("x".repeat(1024 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const transport = new SessionRuntimeTransport({
      gatewayOrigin: "https://gateway.test",
      token,
      authority,
      fetch: async () => response,
    });
    await assert.rejects(transport.claim(1_000), SessionRuntimeTransportError);
  }
});
