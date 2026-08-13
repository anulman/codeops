import readline from "node:readline";

const origin = process.env.CODEOPS_WORK_ITEMS_BROKER_ORIGIN ?? "http://127.0.0.1:8091";
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
  throw new Error("work-items MCP broker must be an exact loopback HTTP origin");
}

const tool = {
  name: "work_items.create",
  description:
    "Create an idempotent work item through the configured project-system provider. Use triage unless the user explicitly requests direct creation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repository", "title", "description"],
    properties: {
      repository: {
        type: "string",
        description: "Repository identity in owner/name form. It must be a source in this workspace.",
      },
      mode: {
        type: "string",
        enum: ["triage", "direct"],
        default: "triage",
        description: "Triage is the default. Direct creation requests human permission.",
      },
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: "string", minLength: 1, maxLength: 20000 },
    },
  },
};

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
        serverInfo: { name: "codeops-work-items", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool] } });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== tool.name) {
      error(message.id, -32602, "unknown work-items tool");
      return;
    }
    try {
      const response = await fetch(new URL("/v1/work-items", parsedOrigin), {
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
          content: [{ type: "text", text: "The work-item provider is unavailable." }],
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
