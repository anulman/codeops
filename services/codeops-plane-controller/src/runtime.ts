import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
} from "@temporalio/client";
import {
  workflowTransitionNoticeSchema,
  type CodingRequest,
  type ResearchRequest,
  type WorkflowTransitionNotice,
} from "@renoconcierge/codeops-contracts";
import {
  parseGitHubPullRequestEvent,
  verifyGitHubWebhookSignature,
  type GitHubPullRequestEvent,
} from "./github-events.js";
import type {
  CodingRequestEnqueueResult,
  ResearchRequestEnqueueResult,
  ResearchWebhookProcessingResult,
} from "./index.js";
import type { ResearchProjectionResult } from "./projection.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/;

export function createRepositoryHeadResolver(input: {
  origin: string;
  token: string;
  fetch?: typeof fetch;
}): () => Promise<string> {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "codeops-control-gateway" ||
    origin.port !== "8080" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("repository head origin must be the internal control gateway");
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("repository head token is invalid");
  }
  return async () => {
    const response = await (input.fetch ?? fetch)(
      new URL("/v1/repository-heads/main", origin),
      {
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`repository head resolution failed with ${response.status}`);
    }
    const body = (await response.json()) as {
      version?: unknown;
      ref?: unknown;
      sha?: unknown;
    };
    if (
      body.version !== "codeops.repository-head/v1" ||
      body.ref !== "refs/heads/main" ||
      typeof body.sha !== "string" ||
      !GIT_SHA.test(body.sha)
    ) {
      throw new Error("repository head response is invalid");
    }
    return body.sha;
  };
}

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

export function createTemporalCodingCanceller(input: {
  client: Pick<Client, "workflow">;
}): (input: { workflowId: string; reason: string }) => Promise<void> {
  return async ({ workflowId, reason }) => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(workflowId)) {
      throw new Error("invalid coding workflow identity");
    }
    const boundedReason = reason.replaceAll(/\s+/g, " ").trim();
    if (boundedReason.length === 0 || boundedReason.length > 1_000) {
      throw new Error("invalid coding cancellation reason");
    }
    await input.client.workflow
      .getHandle(workflowId)
      .signal("cancelWorkItem", boundedReason);
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
  transitionProjection?: {
    token: string;
    process: (notice: WorkflowTransitionNotice) => Promise<void>;
  };
  github?: {
    secret: string;
    process: (input: {
      delivery: string;
      event: GitHubPullRequestEvent;
    }) => Promise<void>;
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
    if (
      request.method === "POST" &&
      request.url === "/v1/workflow-transitions"
    ) {
      if (
        input.transitionProjection === undefined ||
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          input.transitionProjection.token,
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
        const notice = workflowTransitionNoticeSchema.parse(
          JSON.parse((await readRawBody(request)).toString("utf8")) as unknown,
        );
        await input.transitionProjection.process(notice);
        json(response, 200, {
          version: "codeops.workflow-transition-result/v1",
          status: "applied",
          workflowId: notice.workflowId,
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (request.method === "POST" && request.url === "/webhooks/github") {
      if (input.github === undefined) {
        json(response, 404, { status: "not-found" });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 415, { status: "unsupported-media-type" });
        return;
      }
      try {
        const rawBody = await readRawBody(request);
        const signature = requiredHeader(request, "x-hub-signature-256");
        if (
          !verifyGitHubWebhookSignature({
            rawBody,
            secret: input.github.secret,
            signature,
          })
        ) {
          json(response, 401, { status: "unauthorized" });
          return;
        }
        const event = parseGitHubPullRequestEvent({
          rawBody,
          event: requiredHeader(request, "x-github-event"),
        });
        if (event === null) {
          json(response, 200, { status: "ignored" });
          return;
        }
        await input.github.process({
          delivery: requiredHeader(request, "x-github-delivery"),
          event,
        });
        json(response, 200, { status: "accepted" });
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
