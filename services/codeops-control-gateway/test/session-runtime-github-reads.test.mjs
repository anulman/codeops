import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authorizeSessionRuntimeGitHubRead,
  createGitHubReadProviderClient,
  SessionRuntimeGitHubReadConflictError,
} from "../dist/session-runtime-github-reads.js";

const dispatchId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const workerId = "acp-worker:primary";
const repository = "anulman/codeops";

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

function capabilities() {
  return [
    "prompt", "respond_permission", "cancel", "checkpoint", "hibernate",
    "resume", "fork", "archive",
  ].map((action) => action === "prompt"
    ? { action, availability: "enabled" }
    : { action, availability: "disabled", reason: "Unavailable." });
}

function dispatch() {
  return {
    version: "codeops.session-runtime-dispatch/v1",
    dispatchId,
    principalId: "access:aidan@example.com",
    command: {
      version: "codeops.session-command/v1",
      sessionId: "session-github-read",
      generation: 1,
      leaseId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      type: "prompt",
      prompt: "Inspect the exact pull request head.",
    },
    snapshot: {
      version: "codeops.session-snapshot/v1",
      sessionId: "session-github-read",
      generation: 1,
      state: "running",
      identity: {
        version: "codeops.session-workspace-identity/v1",
        policy: {
          version: "codeops.session-policy/v1",
          mode: "review",
          workspaceAccess: "read-only",
          modelCalls: "allowed",
          modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
        },
        workspace: {
          version: "codeops.workspace/v1",
          sources: [{
            catalogKey: "codeops",
            repository,
            checkoutPath: "sources/codeops",
            requestedRef: "main",
            resolvedSha: "a".repeat(40),
          }],
          scratchPath: "scratch",
        },
        workflowId: "workspace-launch",
        runId: "launch-github-read",
        displayName: "Inspect CodeOps",
        parentSessionId: null,
        forkedAtCursor: null,
      },
      lease: {
        leaseId: "33333333-3333-4333-8333-333333333333",
        generation: 1,
        status: "active",
        holderId: "runtime-worker",
        acquiredAt: "2026-08-14T15:00:00.000Z",
        expiresAt: "2026-08-14T16:00:00.000Z",
      },
      checkpoint: null,
      pendingPermission: null,
      eventCursor: 2,
      capabilities: capabilities(),
      updatedAt: "2026-08-14T15:01:00.000Z",
    },
    dispatchedAt: "2026-08-14T15:01:00.000Z",
  };
}

function request(input = {
  repository,
  kind: "pull_requests",
  query: "runtime",
  limit: 5,
}) {
  const operation = "search";
  return {
    version: "codeops.session-runtime-github-read-request/v1",
    claimToken,
    operation,
    operationId: `githubread-${createHash("sha256")
      .update(canonical({ dispatchId, operation, input }))
      .digest("hex")}`,
    input,
  };
}

class Client {
  constructor(overrides = {}) {
    this.row = {
      dispatch_json: dispatch(),
      status: "claimed",
      claim_token: claimToken,
      claimed_by: workerId,
      claim_expires_at: "2026-08-14T15:30:00.000Z",
      owner_principal_id: "access:aidan@example.com",
      ...overrides,
    };
  }

  async query() {
    return { rowCount: 1, rows: [this.row] };
  }
}

test("authorizes only a deterministic read inside the exact workspace source", async () => {
  const provider = await authorizeSessionRuntimeGitHubRead(new Client(), {
    dispatchId,
    workerId,
    request: request(),
    now: () => new Date("2026-08-14T15:05:00.000Z"),
  });
  assert.equal(provider.operation, "search");
  assert.equal(provider.operationId, request().operationId);
  assert.equal(provider.input.repository, repository);
  assert.match(provider.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(provider.provenance.sessionId, "session-github-read");
  assert.match(provider.provenance.principalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal("claimToken" in provider, false);
});

test("rejects repository, operation identity, and live-claim drift", async () => {
  const outside = request({
    repository: "anulman/other",
    kind: "issues",
    query: "runtime",
    limit: 5,
  });
  for (const [client, githubRead] of [
    [new Client(), outside],
    [new Client(), { ...request(), operationId: `githubread-${"f".repeat(64)}` }],
    [new Client({ claim_token: "99999999-9999-4999-8999-999999999999" }), request()],
    [new Client({ claim_expires_at: "2026-08-14T15:05:00.000Z" }), request()],
  ]) {
    await assert.rejects(authorizeSessionRuntimeGitHubRead(client, {
      dispatchId,
      workerId,
      request: githubRead,
      now: () => new Date("2026-08-14T15:05:00.000Z"),
    }), SessionRuntimeGitHubReadConflictError);
  }
});

test("calls only the internal repository route with one provider bearer", async () => {
  const calls = [];
  const providerRequest = await authorizeSessionRuntimeGitHubRead(new Client(), {
    dispatchId,
    workerId,
    request: request(),
    now: () => new Date("2026-08-14T15:05:00.000Z"),
  });
  const read = createGitHubReadProviderClient({
    origin: "http://team-a-codeops-control-gateway:8080",
    token: "provider-token-with-sufficient-distinct-length",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        version: "codeops.github-search-result/v1",
        repository,
        kind: "pull_requests",
        query: "runtime",
        items: [],
        truncated: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal((await read(providerRequest)).version, "codeops.github-search-result/v1");
  assert.equal(
    calls[0].url,
    "http://team-a-codeops-control-gateway:8080/v1/repositories/anulman/codeops/github-reads",
  );
  assert.equal(
    calls[0].init.headers.authorization,
    "Bearer provider-token-with-sufficient-distinct-length",
  );
  assert.deepEqual(calls[0].body, providerRequest);
  assert.throws(() => createGitHubReadProviderClient({
    origin: "https://api.github.com",
    token: "provider-token-with-sufficient-distinct-length",
  }));
});
