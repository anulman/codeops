import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  workItemCreateInputSchema,
  type SessionRuntimeDispatch,
  type WorkItemCreateResult,
} from "@codeops/codeops-contracts";
import type { RuntimeExecutionContext } from "./transport.js";

const MAX_BODY_BYTES = 64 * 1_024;

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("work-item request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(encoded.byteLength),
  });
  response.end(encoded);
}

export class WorkItemsBroker {
  readonly #server;
  #active:
    | {
        readonly dispatch: SessionRuntimeDispatch;
        readonly context: RuntimeExecutionContext;
      }
    | undefined;

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#serve(request, response);
    });
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/work-items") {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }
    const active = this.#active;
    if (active === undefined || active.dispatch.command.type !== "prompt") {
      json(response, 409, { status: "no-active-prompt" });
      return;
    }
    try {
      const workItem = workItemCreateInputSchema.parse(await readJson(request));
      const operationId = `workitem-${createHash("sha256")
        .update(canonical({ dispatchId: active.dispatch.dispatchId, workItem }))
        .digest("hex")}`;
      if (workItem.mode === "direct") {
        const decision = await active.context.requestPermission({
          request: {
            requestId: operationId,
            title: `Create “${workItem.title}” in ${workItem.repository}?`,
            description:
              "Allow CodeOps to create this work item directly in the configured project system.",
            options: [
              { optionId: "allow-once", label: "Create this work item" },
              { optionId: "deny", label: "Do not create it" },
            ],
            requestedAt: new Date().toISOString(),
          },
          acpSessionId: "codeops-work-items",
          toolCallId: operationId,
          options: [
            { optionId: "allow-once", acpOptionId: "allow-once" },
            { optionId: "deny", acpOptionId: "deny" },
          ],
        });
        if (decision.outcome !== "selected" || decision.acpOptionId !== "allow-once") {
          json(response, 403, { status: "permission-denied" });
          return;
        }
      }
      const result: WorkItemCreateResult = await active.context.createWorkItem({
        operationId,
        workItem,
      });
      json(response, 200, result);
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  }

  async listen(port: number): Promise<number> {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error("work-item broker port is invalid");
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("work-item broker did not bind a TCP port");
    }
    return address.port;
  }

  async run<Result>(
    dispatch: SessionRuntimeDispatch,
    context: RuntimeExecutionContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#active !== undefined) throw new Error("work-item broker is already active");
    this.#active = { dispatch, context };
    try {
      return await operation();
    } finally {
      this.#active = undefined;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
