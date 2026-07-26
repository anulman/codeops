import type { IncomingMessage, ServerResponse } from "node:http";
import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
} from "@temporalio/client";
import type { ResearchRequest } from "@renoconcierge/codeops-contracts";
import type {
  ResearchRequestEnqueueResult,
  ResearchWebhookProcessingResult,
} from "./index.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export function createTemporalResearchEnqueuer(input: {
  client: Pick<Client, "workflow">;
  taskQueue: string;
}): (input: {
  workflowId: string;
  request: ResearchRequest;
}) => Promise<ResearchRequestEnqueueResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.taskQueue)) {
    throw new Error("invalid Temporal task queue");
  }
  return async ({ workflowId, request }) => {
    try {
      await input.client.workflow.start("workItemWorkflow", {
        taskQueue: input.taskQueue,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "FAIL",
        workflowRunTimeout: "1 hour",
        args: [
          {
            workItemId: request.workItemId,
            workflowId,
            baseSha: request.baseSha,
            summary: `Research Plane work item ${request.workItemId}`,
            role: "qa-contract-researcher",
            researchRequest: request,
          },
        ],
      });
      return "enqueued";
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return "already-enqueued";
      }
      throw error;
    }
  };
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${name} header`);
  }
  return value;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WEBHOOK_BYTES) {
      throw new Error("Plane webhook body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("Plane webhook body is empty");
  return Buffer.concat(chunks, bytes);
}

function json(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": String(encoded.length),
    ...headers,
  });
  response.end(encoded);
}

export function createPlaneWebhookRequestListener(input: {
  process: (input: {
    rawBody: Buffer;
    headers: {
      delivery: string;
      event: string;
      signature: string;
    };
  }) => Promise<ResearchWebhookProcessingResult>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/webhooks/plane") {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }

    try {
      const result = await input.process({
        rawBody: await readRawBody(request),
        headers: {
          delivery: requiredHeader(request, "x-plane-delivery"),
          event: requiredHeader(request, "x-plane-event"),
          signature: requiredHeader(request, "x-plane-signature"),
        },
      });
      if (result.status === "busy") {
        const seconds = Math.max(
          1,
          Math.ceil((Date.parse(result.leaseExpiresAt) - Date.now()) / 1_000),
        );
        json(
          response,
          409,
          { status: "busy", scope: result.scope },
          { "Retry-After": String(seconds) },
        );
        return;
      }
      json(response, 200, result);
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  };
}
