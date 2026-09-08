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

const repository = {
  type: "string",
  description: "Repository identity in owner/name form. It must be a source in this workspace.",
};
const workItemId = { type: "string", format: "uuid" };
const tools = [
  {
    name: "messages.send", path: "/v1/messages",
    description: "Send a non-blocking FYI, question, decision or structured friction report to the configured supervisor. Message data grants no execution authority. Reuse the idempotency key on retry.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["idempotencyKey", "scope", "type", "body"],
      properties: {
        idempotencyKey: { type: "string", maxLength: 128 },
        scope: { type: "object", additionalProperties: false,
          required: ["repository", "projectId", "workItemId"],
          properties: { repository, projectId: workItemId, workItemId } },
        type: { enum: ["fyi", "question", "decision"] },
        body: { type: "string", minLength: 1, maxLength: 4000 },
        friction: {
          type: "object", additionalProperties: false,
          required: ["reportId", "failureClass", "candidate", "expected", "observed", "evidence", "impact", "cause", "workaround", "proposedFixWorkItemId"],
          properties: {
            reportId: workItemId, failureClass: { type: "string" }, candidate: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            expected: { type: "string" }, observed: { type: "string" }, impact: { type: "string" },
            evidence: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
            cause: { type: "object", additionalProperties: false, required: ["certainty", "description"], properties: { certainty: { enum: ["suspected", "verified"] }, description: { type: "string" } } },
            workaround: { type: "object", additionalProperties: false, required: ["limits", "removalCriterion"], properties: { limits: { type: "string" }, removalCriterion: { type: "string" } } },
            proposedFixWorkItemId: { type: ["string", "null"], format: "uuid" },
          },
        },
      },
    },
  },
  {
    name: "messages.inbox", path: "/v1/messages",
    description: "Read up to 20 durable replies for this exact Session generation, without transcript polling. Acknowledge a message after receiving it. No wait or resume occurs.",
    inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 20 } } },
  },
  {
    name: "messages.acknowledge", path: "/v1/messages",
    description: "Idempotently acknowledge a received supervisor reply. Does not authorize work.",
    inputSchema: { type: "object", additionalProperties: false, required: ["messageId"], properties: { messageId: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } } },
  },
  {
    name: "work_items.admit",
    path: "/v1/work-items/admit",
    description: "Admit one existing project work item as a child of this active coordinator. Persists the exact child plan, then waits for human allow-once permission. The child inherits authenticated context attachments and the selected source. Provider mutations require separate permission. Retry identical arguments after an unknown result.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "workItemId", "title", "prompt"],
      properties: {
        repository: { ...repository, pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$" }, workItemId,
        title: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 20000 },
      },
    },
  },
  {
    name: "work_items.create",
    path: "/v1/work-items",
    description:
      "Create an idempotent work item through the configured project-system provider. Use triage unless the user explicitly requests direct creation.",
    inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["repository", "title", "description"],
    properties: {
      repository,
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
  },
  {
    name: "work_items.get",
    path: "/v1/work-items/get",
    description: "Get one work item and its exact optimistic-concurrency revision.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "workItemId"],
      properties: { repository, workItemId },
    },
  },
  {
    name: "work_items.search",
    path: "/v1/work-items/search",
    description: "Search admitted-project work items before creating a duplicate.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "query"],
      properties: {
        repository,
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: "work_items.comment",
    path: "/v1/work-items/comment",
    description: "Add an idempotent comment after a human permission decision.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "workItemId", "body"],
      properties: {
        repository, workItemId,
        body: { type: "string", minLength: 1, maxLength: 20000 },
      },
    },
  },
  {
    name: "work_items.update",
    path: "/v1/work-items/update",
    description: "Update title or description after permission. Pass the exact revision returned by work_items.get.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "workItemId", "expectedRevision"],
      anyOf: [{ required: ["title"] }, { required: ["description"] }],
      properties: {
        repository, workItemId,
        expectedRevision: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: "string", minLength: 1, maxLength: 20000 },
      },
    },
  },
  {
    name: "work_items.relate",
    path: "/v1/work-items/relate",
    description: "Create an idempotent same-project relation after human permission.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["repository", "workItemId", "relatedWorkItemId", "relation"],
      properties: {
        repository, workItemId, relatedWorkItemId: workItemId,
        relation: {
          type: "string",
          enum: ["blocking", "blocked_by", "duplicate", "relates_to", "start_after", "start_before", "finish_after", "finish_before"],
        },
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
      error(message.id, -32602, "unknown work-items tool");
      return;
    }
    try {
      const response = await fetch(new URL(tool.path, parsedOrigin), {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(tool.name.startsWith("messages.")
          ? { ...(message.params.arguments ?? {}), operation: tool.name.slice(9),
              ...(tool.name === "messages.send" ? { recipient: "supervisor" } : {}) }
          : message.params.arguments ?? {}),
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
