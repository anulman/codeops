import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  canonicalJsonText,
  sessionPermissionOperationSchema,
  workItemCommentInputSchema,
  workItemCreateInputSchema,
  workItemGetInputSchema,
  workItemRelateInputSchema,
  workItemSearchInputSchema,
  workItemUpdateInputSchema,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import type { RuntimeExecutionContext } from "./transport.js";

const MAX_BODY_BYTES = 64 * 1_024;

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
    const operation = request.url === "/v1/work-items"
      ? "create"
      : request.url?.match(/^\/v1\/work-items\/(get|search|comment|update|relate)$/)?.[1];
    if (request.method !== "POST" || operation === undefined) {
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
      const raw = await readJson(request);
      const schemas = {
        create: workItemCreateInputSchema,
        get: workItemGetInputSchema,
        search: workItemSearchInputSchema,
        comment: workItemCommentInputSchema,
        update: workItemUpdateInputSchema,
        relate: workItemRelateInputSchema,
      } as const;
      const workItem = schemas[operation as keyof typeof schemas].parse(raw);
      const operationId = `workitem-${createHash("sha256")
        .update(canonicalJsonText({ dispatchId: active.dispatch.dispatchId, operation, workItem }))
        .digest("hex")}`;
      const permissionRequired =
        ["comment", "update", "relate"].includes(operation) ||
        (operation === "create" && "mode" in workItem && workItem.mode === "direct");
      if (permissionRequired) {
        const permissionOperation = sessionPermissionOperationSchema.parse({
          kind: "work_item",
          repository: workItem.repository,
          operation,
          targetWorkItemId:
            "workItemId" in workItem ? workItem.workItemId : null,
          payloadJson: canonicalJsonText(workItem),
        });
        const operationDigest = `sha256:${createHash("sha256")
          .update(canonicalJsonText(permissionOperation))
          .digest("hex")}`;
        const action = operation === "create"
          ? `Create “${"title" in workItem ? workItem.title : "work item"}”`
          : `${operation[0]!.toUpperCase()}${operation.slice(1)} work item`;
        const decision = await active.context.requestPermission({
          request: {
            requestId: operationId,
            title: `${action} in ${workItem.repository}?`,
            description:
              `Allow CodeOps to ${operation} this work item in the configured project system.`,
            operation: permissionOperation,
            operationDigest,
            options: [
              { optionId: "allow-once", label: `Allow ${operation} once` },
              { optionId: "deny", label: "Do not allow it" },
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
      switch (operation) {
        case "create":
          json(response, 200, await active.context.createWorkItem({
            operationId,
            workItem: workItemCreateInputSchema.parse(workItem),
          }));
          return;
        case "get":
          json(response, 200, await active.context.getWorkItem({
            operationId,
            workItem: workItemGetInputSchema.parse(workItem),
          }));
          return;
        case "search":
          json(response, 200, await active.context.searchWorkItems({
            operationId,
            workItem: workItemSearchInputSchema.parse(workItem),
          }));
          return;
        case "comment":
          json(response, 200, await active.context.commentWorkItem({
            operationId,
            workItem: workItemCommentInputSchema.parse(workItem),
          }));
          return;
        case "update":
          json(response, 200, await active.context.updateWorkItem({
            operationId,
            workItem: workItemUpdateInputSchema.parse(workItem),
          }));
          return;
        case "relate":
          json(response, 200, await active.context.relateWorkItem({
            operationId,
            workItem: workItemRelateInputSchema.parse(workItem),
          }));
          return;
      }
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
