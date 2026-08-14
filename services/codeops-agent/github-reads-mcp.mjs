import readline from "node:readline";

const origin = process.env.CODEOPS_GITHUB_READS_BROKER_ORIGIN ?? "http://127.0.0.1:8092";
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
  throw new Error("GitHub reads MCP broker must be an exact loopback HTTP origin");
}

const repository = {
  type: "string",
  pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$",
  description: "Repository identity in owner/name form. It must be a source in this workspace.",
};
const pullRequestNumber = { type: "integer", minimum: 1, maximum: 2147483647 };
const headSha = { type: "string", pattern: "^[0-9a-f]{40}$" };
const maxBytes = { type: "integer", minimum: 1, maximum: 200000, default: 200000 };
const tools = [
  {
    name: "github.pull_request_get",
    path: "/v1/github/pull-request/get",
    description: "Read bounded metadata for one pull request.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber"],
      properties: { repository, pullRequestNumber },
    },
  },
  {
    name: "github.pull_request_diff",
    path: "/v1/github/pull-request/diff",
    description: "Read a bounded diff only when the pull request still has the expected exact head SHA.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber", "expectedHeadSha"],
      properties: { repository, pullRequestNumber, expectedHeadSha: headSha, maxBytes },
    },
  },
  {
    name: "github.review_threads",
    path: "/v1/github/pull-request/review-threads",
    description: "Read bounded review threads only for the expected exact pull-request head SHA.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "pullRequestNumber", "expectedHeadSha"],
      properties: {
        repository, pullRequestNumber, expectedHeadSha: headSha,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
    },
  },
  {
    name: "github.checks",
    path: "/v1/github/checks",
    description: "Read up to 100 check runs for one exact commit SHA.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "headSha"],
      properties: { repository, headSha },
    },
  },
  {
    name: "github.check_logs",
    path: "/v1/github/check-logs",
    description: "Read bounded logs for one check run after verifying its exact commit SHA.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "headSha", "checkRunId"],
      properties: {
        repository, headSha,
        checkRunId: { type: "integer", minimum: 1 },
        maxBytes,
      },
    },
  },
  {
    name: "github.protected_branch",
    path: "/v1/github/protected-branch",
    description: "Read the exact head of one branch only when GitHub reports it protected.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "branch"],
      properties: {
        repository,
        branch: { type: "string", minLength: 1, maxLength: 255 },
      },
    },
  },
  {
    name: "github.search",
    path: "/v1/github/search",
    description: "Search bounded issues or pull requests inside one admitted repository.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "kind", "query"],
      properties: {
        repository,
        kind: { type: "string", enum: ["issues", "pull_requests"] },
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
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
        serverInfo: { name: "codeops-github", version: "0.1.0" },
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
      error(message.id, -32602, "unknown GitHub read tool");
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
          content: [{ type: "text", text: "The GitHub read provider is unavailable." }],
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
