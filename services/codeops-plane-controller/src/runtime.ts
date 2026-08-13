import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
} from "@temporalio/client";
import {
  workflowTransitionNoticeSchema,
  githubReviewCommentSchema,
  githubPullRequestStackLinkSchema,
  githubPullRequestStackSnapshotSchema,
  verifyPlaneWebhookSignature,
  type GitHubReviewComment,
  type GitHubPullRequestStackLink,
  type GitHubPullRequestStackSnapshot,
  type CodingRequest,
  type ResearchRequest,
  type WorkflowTransitionNotice,
  workItemProviderCreateRequestSchema,
  type WorkItemCreateResult,
} from "@codeops/codeops-contracts";
import {
  parseGitHubEvent,
  parseGitHubWebhookRepository,
  verifyGitHubWebhookSignature,
  type GitHubEvent,
} from "./github-events.js";
import type {
  CodingRequestEnqueueResult,
  ResearchRequestEnqueueResult,
  ResearchWebhookProcessingResult,
} from "./index.js";
import type { ResearchProjectionResult } from "./projection.js";
import type { GitHubSessionSteeringRequest } from "./github-session-reconciler.js";
import { z } from "zod";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_IDENTITY = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
const KUBERNETES_SERVICE_NAME =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

function internalServiceOrigin(
  value: string,
  component: "control-gateway" | "session-control-gateway",
  message: string,
): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    !KUBERNETES_SERVICE_NAME.test(origin.hostname) ||
    !origin.hostname.endsWith(`-${component}`) ||
    origin.hostname.length <= component.length + 1 ||
    origin.port !== "8080" ||
    origin.pathname !== "/" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(message);
  }
  return origin;
}

function repositoryRoute(repository: string, suffix: string): string {
  if (!REPOSITORY_IDENTITY.test(repository) || !suffix.startsWith("/")) {
    throw new Error("GitHub repository route is invalid");
  }
  return `/v1/repositories/${repository}${suffix}`;
}

export function createRepositoryHeadResolver(input: {
  origin: string;
  token: string;
  repository: string;
  fetch?: typeof fetch;
}): () => Promise<string> {
  const origin = internalServiceOrigin(
    input.origin,
    "control-gateway",
    "repository head origin must be the internal control gateway",
  );
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("repository head token is invalid");
  }
  const repository = z
    .string()
    .regex(REPOSITORY_IDENTITY)
    .parse(input.repository);
  return async () => {
    const response = await (input.fetch ?? fetch)(
      new URL(repositoryRoute(repository, "/heads/main"), origin),
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
      throw new Error(
        `repository head resolution failed with ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      version?: unknown;
      repository?: unknown;
      ref?: unknown;
      sha?: unknown;
    };
    if (
      body.version !== "codeops.repository-head/v1" ||
      body.repository !== repository ||
      body.ref !== "refs/heads/main" ||
      typeof body.sha !== "string" ||
      !GIT_SHA.test(body.sha)
    ) {
      throw new Error("repository head response is invalid");
    }
    return body.sha;
  };
}

export function createGitHubReviewCommentsLoader(input: {
  origin: string;
  token: string;
  repository: string;
  fetch?: typeof fetch;
}): (input: {
  repository: string;
  number: number;
  reviewId: number;
}) => Promise<readonly GitHubReviewComment[]> {
  const origin = internalServiceOrigin(
    input.origin,
    "control-gateway",
    "GitHub review origin must be the internal control gateway",
  );
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub review reader token is invalid");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("GitHub review repository identity is invalid");
  }
  return async (review) => {
    if (review.repository !== input.repository) {
      throw new Error("GitHub review repository is outside configured scope");
    }
    const number = z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .parse(review.number);
    const reviewId = z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(review.reviewId);
    const response = await (input.fetch ?? fetch)(
      new URL(
        repositoryRoute(
          review.repository,
          `/pull-requests/${number}/reviews/${reviewId}/comments`,
        ),
        origin,
      ),
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
      throw new Error(
        `GitHub review comment resolution failed with ${response.status}`,
      );
    }
    const result = z
      .object({
        version: z.literal("codeops.github-review-comments/v1"),
        repository: z.string().regex(REPOSITORY_IDENTITY),
        comments: z.array(githubReviewCommentSchema).max(100),
      })
      .strict()
      .parse(await response.json());
    if (result.repository !== review.repository) {
      throw new Error("GitHub review repository identity mismatch");
    }
    return result.comments;
  };
}

export function createGitHubHeadQualifier(input: {
  origin: string;
  token: string;
  repository: string;
  fetch?: typeof fetch;
}): (input: {
  pullRequestNumber: number;
  headSha: string;
}) => Promise<boolean> {
  const origin = internalServiceOrigin(
    input.origin,
    "control-gateway",
    "GitHub qualification origin must be the internal control gateway",
  );
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub qualification token is invalid");
  }
  const repository = z
    .string()
    .regex(REPOSITORY_IDENTITY)
    .parse(input.repository);
  return async (value) => {
    const pullRequestNumber = z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .parse(value.pullRequestNumber);
    const headSha = z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(value.headSha);
    const response = await (input.fetch ?? fetch)(
      new URL(
        repositoryRoute(
          repository,
          `/pull-requests/${pullRequestNumber}/heads/${headSha}/qualification`,
        ),
        origin,
      ),
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
      throw new Error(`GitHub qualification failed with ${response.status}`);
    }
    const result = z
      .object({
        version: z.literal("codeops.github-pull-request-qualification/v1"),
        repository: z.string().regex(REPOSITORY_IDENTITY),
        pullRequestNumber: z.number().int().positive().max(10_000_000),
        headSha: z.string().regex(/^[0-9a-f]{40}$/),
        qualified: z.boolean(),
      })
      .strict()
      .parse(await response.json());
    if (
      result.pullRequestNumber !== pullRequestNumber ||
      result.headSha !== headSha ||
      result.repository !== repository
    ) {
      throw new Error("GitHub qualification identity mismatch");
    }
    return result.qualified;
  };
}

export interface GitHubCurrentPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
}

export function createGitHubCurrentPullRequestResolver(input: {
  origin: string;
  token: string;
  fetch?: typeof fetch;
}): (input: {
  repository: string;
  number: number;
}) => Promise<GitHubCurrentPullRequest> {
  const origin = internalControlGatewayOrigin(
    input.origin,
    "GitHub current pull-request",
  );
  const token = internalCapabilityToken(
    input.token,
    "GitHub current pull-request",
  );
  return async (value) => {
    const repository = z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .parse(value.repository);
    const number = z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .parse(value.number);
    const response = await (input.fetch ?? fetch)(
      new URL(
        repositoryRoute(repository, `/pull-requests/${number}/current-head`),
        origin,
      ),
      {
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub current pull-request resolution failed with ${response.status}`,
      );
    }
    const result = z
      .object({
        version: z.literal("codeops.github-current-pull-request/v1"),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        number: z.number().int().positive().max(10_000_000),
        state: z.enum(["open", "closed"]),
        headSha: z.string().regex(/^[0-9a-f]{40}$/),
        headRef: z.string().min(1).max(200),
        baseRef: z.string().min(1).max(200),
      })
      .strict()
      .parse(await response.json());
    if (result.repository !== repository || result.number !== number) {
      throw new Error("GitHub current pull-request identity mismatch");
    }
    return result;
  };
}

function internalControlGatewayOrigin(value: string, capability: string): URL {
  return internalServiceOrigin(
    value,
    "control-gateway",
    `${capability} origin must be the internal control gateway`,
  );
}

function internalCapabilityToken(value: string, capability: string): string {
  if (value.length < 32 || value.length > 4_096) {
    throw new Error(`${capability} token is invalid`);
  }
  return value;
}

export function createGitHubStackLoader(input: {
  origin: string;
  token: string;
  repository: string;
  fetch?: typeof fetch;
}): (stackNumber: number) => Promise<GitHubPullRequestStackSnapshot> {
  const origin = internalControlGatewayOrigin(input.origin, "GitHub stack");
  const token = internalCapabilityToken(input.token, "GitHub stack");
  const repository = z
    .string()
    .regex(REPOSITORY_IDENTITY)
    .parse(input.repository);
  return async (value) => {
    const stackNumber = z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .parse(value);
    const response = await (input.fetch ?? fetch)(
      new URL(
        repositoryRoute(repository, `/pull-request-stacks/${stackNumber}`),
        origin,
      ),
      {
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub stack resolution failed with ${response.status}`);
    }
    const result = githubPullRequestStackSnapshotSchema.parse(
      await response.json(),
    );
    if (result.repository !== repository) {
      throw new Error("GitHub stack repository identity mismatch");
    }
    return result;
  };
}

export function createGitHubStackLinker(input: {
  origin: string;
  token: string;
  fetch?: typeof fetch;
}): (
  link: GitHubPullRequestStackLink,
) => Promise<GitHubPullRequestStackSnapshot> {
  const origin = internalControlGatewayOrigin(
    input.origin,
    "GitHub stack link",
  );
  const token = internalCapabilityToken(input.token, "GitHub stack link");
  return async (value) => {
    const link = githubPullRequestStackLinkSchema.parse(value);
    const repository = `${link.repository.owner}/${link.repository.name}`;
    const response = await (input.fetch ?? fetch)(
      new URL(repositoryRoute(repository, "/pull-request-stacks"), origin),
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(link),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub stack link failed with ${response.status}`);
    }
    const result = githubPullRequestStackSnapshotSchema.parse(
      await response.json(),
    );
    if (result.repository !== repository) {
      throw new Error("GitHub stack link repository identity mismatch");
    }
    return result;
  };
}

export function createGitHubSessionSteeringClient(input: {
  origin: string;
  resolveToken(repository: string): string;
  fetch?: typeof fetch;
}): (request: GitHubSessionSteeringRequest) => Promise<{ sessionId: string }> {
  const origin = internalServiceOrigin(
    input.origin,
    "session-control-gateway",
    "GitHub session steering origin must be the internal session gateway",
  );
  return async (request) => {
    const token = internalCapabilityToken(
      input.resolveToken(request.binding.repository),
      "GitHub session steering",
    );
    const response = await (input.fetch ?? fetch)(
      new URL(
        repositoryRoute(request.binding.repository, "/github-session-events"),
        origin,
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: "codeops.github-session-steering/v1",
          binding: request.binding,
          event: request.event,
          prompt: request.prompt,
          idempotencyKey: request.idempotencyKey,
          principalId: request.principalId,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub session steering failed with ${response.status}`);
    }
    const result = z
      .object({
        version: z.literal("codeops.github-session-steering-result/v1"),
        status: z.literal("accepted"),
        sessionId: z.string().min(1).max(128),
        workItemId: z.string().uuid(),
        repository: z.string().regex(REPOSITORY_IDENTITY),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .parse(await response.json());
    if (
      result.workItemId !== request.binding.workItemId ||
      result.repository !== request.binding.repository ||
      result.idempotencyKey !== request.idempotencyKey
    ) {
      throw new Error("GitHub session steering response identity mismatch");
    }
    return { sessionId: result.sessionId };
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
  plane?: {
    resolveSecret: (repository: string) => string;
    process: (input: {
      repository: string;
      rawBody: Buffer;
      webhookSecret: string;
      headers: {
        delivery: string;
        event: string;
        signature: string;
      };
    }) => Promise<ResearchWebhookProcessingResult>;
  };
  projection?: {
    token: string;
    process: (packet: unknown) => Promise<ResearchProjectionResult>;
  };
  transitionProjection?: {
    token: string;
    process: (notice: WorkflowTransitionNotice) => Promise<void>;
  };
  workItems?: {
    token: string;
    create: (request: unknown) => Promise<WorkItemCreateResult>;
  };
  github?: {
    resolveSecret: (repository: string) => string;
    process: (input: { delivery: string; event: GitHubEvent }) => Promise<void>;
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
    if (request.method === "POST" && request.url === "/v1/work-items") {
      if (
        input.workItems === undefined ||
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          input.workItems.token,
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
        const createRequest = workItemProviderCreateRequestSchema.parse(
          JSON.parse((await readRawBody(request)).toString("utf8")) as unknown,
        );
        json(response, 200, await input.workItems.create(createRequest));
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
        const repository = parseGitHubWebhookRepository(rawBody);
        let secret: string;
        try {
          secret = input.github.resolveSecret(repository);
        } catch {
          json(response, 401, { status: "unauthorized" });
          return;
        }
        if (
          !verifyGitHubWebhookSignature({
            rawBody,
            secret,
            signature,
          })
        ) {
          json(response, 401, { status: "unauthorized" });
          return;
        }
        const event = parseGitHubEvent({
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
    const planeRoute =
      request.method === "POST"
        ? request.url?.match(
            /^\/webhooks\/plane\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/,
          )
        : null;
    if (
      planeRoute === null ||
      planeRoute === undefined ||
      input.plane === undefined
    ) {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }

    try {
      const repository = `${planeRoute[1]}/${planeRoute[2]}`;
      let webhookSecret: string;
      try {
        webhookSecret = input.plane.resolveSecret(repository);
      } catch {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      const rawBody = await readRawBody(request);
      const headers = {
        delivery: requiredHeader(request, "x-plane-delivery"),
        event: requiredHeader(request, "x-plane-event"),
        signature: requiredHeader(request, "x-plane-signature"),
      };
      if (
        !verifyPlaneWebhookSignature({
          rawBody,
          secret: webhookSecret,
          signature: headers.signature,
        })
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      const result = await input.plane.process({
        repository,
        rawBody,
        webhookSecret,
        headers,
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
