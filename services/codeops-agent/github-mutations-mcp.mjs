import readline from "node:readline";

const origin = process.env.CODEOPS_GITHUB_MUTATIONS_BROKER_ORIGIN ??
  "http://127.0.0.1:8093";
const parsedOrigin = new URL(origin);
if (
  parsedOrigin.protocol !== "http:" ||
  parsedOrigin.hostname !== "127.0.0.1" ||
  parsedOrigin.pathname !== "/" ||
  parsedOrigin.username ||
  parsedOrigin.password ||
  parsedOrigin.search ||
  parsedOrigin.hash
) {
  throw new Error("GitHub mutations MCP broker must be an exact loopback HTTP origin");
}

const repository = {
  type: "string",
  pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$",
  description: "Repository identity in owner/name form. It must be a source in this workspace.",
};
const pullRequestNumber = { type: "integer", minimum: 1, maximum: 2147483647 };
const expectedHeadSha = { type: "string", pattern: "^[0-9a-f]{40}$" };
const branch = { type: "string", minLength: 1, maxLength: 255 };
const tools = [
  {
    name: "github.branch_publish",
    path: "/v1/github-mutations/branch/publish",
    description: "Publish one branch from bounded text replacements after explicit allow-once permission. The complete serialized input must not exceed 262144 bytes (256 KiB). expectedHeadSha binds the admitted base snapshot. Fast-forward atomically compares expectedBranchHeadSha on the existing target branch.",
    inputSchema: {
      type: "object", additionalProperties: false,
      description: "Complete serialized input must not exceed 262144 bytes (256 KiB).",
      required: ["repository", "expectedHeadSha", "baseBranch", "branchName", "commitMessage", "changes"],
      allOf: [{
        if: { properties: { mode: { const: "fast_forward" } }, required: ["mode"] },
        then: { required: ["expectedBranchHeadSha", "expectedBranchHeadEffectId"] },
        else: { not: { anyOf: [{ required: ["expectedBranchHeadSha"] }, { required: ["expectedBranchHeadEffectId"] }] } },
      }],
      properties: {
        repository,
        expectedHeadSha: { ...expectedHeadSha, description: "Admitted base-branch snapshot checked during preflight; not the atomic target-ref fence for fast-forward publication." },
        baseBranch: branch, branchName: branch,
        mode: { type: "string", enum: ["create", "fast_forward"] },
        expectedBranchHeadSha: { ...expectedHeadSha, description: "Fast-forward only: exact target-branch commit atomically compared by GitHub." },
        expectedBranchHeadEffectId: { type: "string", pattern: "^githubmutation-[0-9a-f]{64}$", description: "Fast-forward only: durable successful CodeOps publication effect that produced the expected target head." },
        commitMessage: { type: "string", minLength: 1, maxLength: 500 },
        changes: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object", additionalProperties: false,
            required: ["path", "oldText", "newText"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 2000 },
              oldText: { type: "string", maxLength: 100000 },
              newText: { type: "string", maxLength: 100000 },
            },
          },
        },
      },
    },
  },
  {
    name: "github.pull_request_create",
    path: "/v1/github-mutations/pull-request/create",
    description: "Create one pull request after exact head/base ref preflight and explicit allow-once permission.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "expectedHeadSha", "expectedBaseSha", "headBranch", "baseBranch", "title", "body", "draft"],
      properties: {
        repository, expectedHeadSha, expectedBaseSha: expectedHeadSha,
        headBranch: branch, baseBranch: branch,
        title: { type: "string", minLength: 1, maxLength: 500 },
        body: { type: "string", maxLength: 50000 },
        draft: { type: "boolean" },
      },
    },
  },
  {
    name: "github.pull_request_update_branch",
    path: "/v1/github-mutations/pull-request/update-branch",
    description: "Update one pull-request branch only after explicit allow-once permission and exact-head preflight.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber", "expectedHeadSha"],
      properties: { repository, pullRequestNumber, expectedHeadSha },
    },
  },
  {
    name: "github.pull_request_update",
    path: "/v1/github-mutations/pull-request/update",
    description: "Update bounded pull-request title, body, or base fields after exact head/base preflight and explicit allow-once permission.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber", "expectedHeadSha", "expectedBaseSha"],
      anyOf: [{ required: ["title"] }, { required: ["body"] }, { required: ["baseBranch"] }],
      properties: {
        repository, pullRequestNumber, expectedHeadSha,
        expectedBaseSha: expectedHeadSha,
        title: { type: "string", minLength: 1, maxLength: 500 },
        body: { type: "string", maxLength: 50000 },
        baseBranch: branch,
      },
    },
  },
  {
    name: "github.review_thread_reply",
    path: "/v1/github-mutations/review-thread/reply",
    description: "Reply to one exact review thread after exact-head preflight and explicit allow-once permission.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber", "expectedHeadSha", "threadId", "body"],
      properties: {
        repository, pullRequestNumber, expectedHeadSha,
        threadId: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", minLength: 1, maxLength: 20000 },
      },
    },
  },
  {
    name: "github.check_rerun",
    path: "/v1/github-mutations/check/rerun",
    description: "Rerun one exact check after exact-head preflight and explicit allow-once permission.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "expectedHeadSha", "checkRunId"],
      properties: {
        repository, expectedHeadSha,
        checkRunId: { type: "integer", minimum: 1 },
      },
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codeops-github-mutations", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: tools.map(({ path: _path, ...tool }) => tool) },
    });
    return;
  }
  if (message.method === "tools/call") {
    const tool = tools.find(({ name }) => name === message.params?.name);
    if (tool === undefined) {
      error(message.id, -32602, "unknown GitHub mutation tool");
      return;
    }
    try {
      const response = await fetch(new URL(tool.path, parsedOrigin), {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(message.params.arguments ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json();
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: !response.ok,
          content: [{ type: "text", text: JSON.stringify(body) }],
        },
      });
    } catch {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "The GitHub mutation provider is unavailable." }],
        },
      });
    }
    return;
  }
  error(message.id, -32601, "method not found");
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    await handle(JSON.parse(line));
  } catch {
    error(null, -32700, "invalid JSON-RPC message");
  }
}
