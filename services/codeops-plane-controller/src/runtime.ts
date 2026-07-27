import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
} from "@temporalio/client";
import type {
  CodingRequest,
  ResearchRequest,
} from "@renoconcierge/codeops-contracts";
import type {
  CodingRequestEnqueueResult,
  ResearchRequestEnqueueResult,
  ResearchWebhookProcessingResult,
} from "./index.js";
import type { ResearchProjectionResult } from "./projection.js";

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
            summary: `Research Plane work item ${request.workItemId} with ${request.personas.join(", ")}`,
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

export function createTemporalCodingEnqueuer(input: {
  client: Pick<Client, "workflow">;
  taskQueue: string;
}): (input: {
  workflowId: string;
  request: CodingRequest;
}) => Promise<CodingRequestEnqueueResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.taskQueue)) {
    throw new Error("invalid Temporal task queue");
  }
  return async ({ workflowId, request }) => {
    if (workflowId !== request.workItem.workflowId) {
      throw new Error("coding workflow identity does not match its request");
    }
    try {
      await input.client.workflow.start("workItemWorkflow", {
        taskQueue: input.taskQueue,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "FAIL",
        workflowRunTimeout: "24 hours",
        args: [
          {
            workItemId: request.workItem.workItemId,
            workflowId,
            baseSha: request.workItem.baseSha,
            summary: request.workItem.summary,
            role: "coding-agent",
            codingRequest: request,
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

function authenticateBearer(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return (
    received.length === expected.length &&
    received.length > 0 &&
    timingSafeEqual(received, expected)
  );
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
  projection?: {
    token: string;
    process: (packet: unknown) => Promise<ResearchProjectionResult>;
  };
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/research-packets") {
      if (
        input.projection === undefined ||
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          input.projection.token,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 415, { status: "unsupported-media-type" });
        return;
      }
      try {
        const result = await input.projection.process(
          JSON.parse((await readRawBody(request)).toString("utf8")) as unknown,
        );
        if (result.status === "busy") {
          const seconds = Math.max(
            1,
            Math.ceil((Date.parse(result.leaseExpiresAt) - Date.now()) / 1_000),
          );
          json(
            response,
            409,
            { status: "busy", requestId: result.requestId },
            { "Retry-After": String(seconds) },
          );
          return;
        }
        json(response, 200, {
          version: "codeops.research-projection-result/v1",
          ...result,
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
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
