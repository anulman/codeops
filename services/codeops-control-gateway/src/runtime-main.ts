import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import {
  authenticateBearer,
  loadGitHubReviewComments,
  qualifyGitHubHead,
  resolveGitHubPullRequestHead,
  parseDispatchRequest,
  resolveGitHubBranchHead,
} from "./core.js";
import {
  candidatePublicationSchema,
  githubPullRequestStackLinkSchema,
} from "@renoconcierge/codeops-contracts";
import {
  linkGitHubPullRequestStack,
  loadGitHubPullRequestStack,
} from "./github-stacks.js";
import { loadInClusterKubernetesClient } from "./kubernetes.js";
import { publishCandidateRevision } from "./publication.js";
import { createAgentJobRunner } from "./runtime.js";
import { migrateSessionBroker } from "./session-broker-migration.js";
import {
  InvalidSessionCommandRequestError,
  executeLocalSessionCommandTransaction,
  serveSessionBrokerCommand,
} from "./session-broker-command.js";
import {
  InvalidSessionReadRequestError,
  serveSessionBrokerRead,
} from "./session-broker-http.js";
import {
  InvalidSessionRuntimeRequestError,
  serveSessionRuntime,
} from "./session-broker-runtime-http.js";
import {
  InvalidSessionJobInitializationRequestError,
  initializeSessionFromJob,
  serveSessionJobInitialization,
} from "./session-job-initialization.js";
import {
  ImmutableSessionRuntimeDispatchConflictError,
  SessionRuntimeDispatchNotFoundError,
  claimSessionRuntimeDispatch,
  completeSessionRuntimeDispatch,
  enqueueSessionRuntimeDispatch,
} from "./session-broker-runtime-outbox.js";
import {
  pollSessionRuntimePermission,
  SessionRuntimePermissionConflictError,
  SessionRuntimePermissionNotFoundError,
  submitSessionRuntimePermission,
} from "./session-runtime-permissions.js";
import {
  ImmutableSessionCommandConflictError,
  SessionCompareAndSwapError,
  SessionForkConflictError,
  SessionNotFoundError,
  SessionRuntimeClaimConflictError,
} from "./session-broker-repository.js";

const MAX_BODY_BYTES = 1024 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function secretFile(name: string): Promise<string> {
  const value = (await readFile(required(name), "utf8")).trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

function requireDigestImage(name: string): string {
  const value = required(name);
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be an immutable digest image`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("dispatch body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("dispatch body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": String(encoded.length),
  });
  response.end(encoded);
}

const namespace = required("CODEOPS_NAMESPACE");
const token = await secretFile("CODEOPS_DISPATCH_TOKEN_FILE");
if (token.length < 32 || token.length > 4_096) {
  throw new Error("dispatch token length is invalid");
}
const repositoryHeadToken = await secretFile(
  "CODEOPS_REPOSITORY_HEAD_TOKEN_FILE",
);
if (repositoryHeadToken.length < 32 || repositoryHeadToken.length > 4_096) {
  throw new Error("repository head token length is invalid");
}
const kubernetes = await loadInClusterKubernetesClient(namespace);
const modelAuth = {
  mode: "proxy" as const,
  origin: required("CODEOPS_MODEL_PROXY_ORIGIN"),
  signingKey: await secretFile("CODEOPS_MODEL_PROXY_SIGNING_KEY_FILE"),
};
const repositoryUrl = required("CODEOPS_REPOSITORY_URL");
const repositoryReadToken = await secretFile(
  "CODEOPS_REPOSITORY_READ_TOKEN_FILE",
);
const requiredReviewCheckNames = required(
  "CODEOPS_REQUIRED_REVIEW_CHECK_NAMES",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const publicationToken = await secretFile("CODEOPS_PUBLICATION_TOKEN_FILE");
if (publicationToken.length < 32 || publicationToken.length > 4_096) {
  throw new Error("publication token length is invalid");
}
const sessionBrokerReadToken = await secretFile(
  "CODEOPS_SESSION_BROKER_READ_TOKEN_FILE",
);
if (sessionBrokerReadToken.length < 32 || sessionBrokerReadToken.length > 4_096) {
  throw new Error("session broker read token length is invalid");
}
const sessionBrokerWriteToken = await secretFile(
  "CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE",
);
if (sessionBrokerWriteToken.length < 32 || sessionBrokerWriteToken.length > 4_096) {
  throw new Error("session broker write token length is invalid");
}
const sessionRuntimeWorkerToken = await secretFile(
  "CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE",
);
if (
  sessionRuntimeWorkerToken.length < 32 ||
  sessionRuntimeWorkerToken.length > 4_096
) {
  throw new Error("session runtime worker token length is invalid");
}
if (
  sessionRuntimeWorkerToken === sessionBrokerReadToken ||
  sessionRuntimeWorkerToken === sessionBrokerWriteToken ||
  sessionRuntimeWorkerToken === token ||
  sessionRuntimeWorkerToken === repositoryHeadToken ||
  sessionRuntimeWorkerToken === publicationToken
) {
  throw new Error("session runtime worker token must have a distinct authority");
}
const sessionJobInitializationToken = await secretFile(
  "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE",
);
if (
  sessionJobInitializationToken.length < 32 ||
  sessionJobInitializationToken.length > 4_096
) {
  throw new Error("session Job initialization token length is invalid");
}
if (
  sessionJobInitializationToken === sessionRuntimeWorkerToken ||
  sessionJobInitializationToken === sessionBrokerReadToken ||
  sessionJobInitializationToken === sessionBrokerWriteToken ||
  sessionJobInitializationToken === token ||
  sessionJobInitializationToken === repositoryHeadToken ||
  sessionJobInitializationToken === publicationToken
) {
  throw new Error("session Job initialization token must have a distinct authority");
}
const sessionRuntimeWorkerId = required("CODEOPS_SESSION_RUNTIME_WORKER_ID");
if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(sessionRuntimeWorkerId)) {
  throw new Error("session runtime worker identity is invalid");
}
const repositoryWriteToken = await secretFile(
  "CODEOPS_REPOSITORY_WRITE_TOKEN_FILE",
);
const database = new Pool({
  connectionString: await secretFile("CODEOPS_DATABASE_URL_FILE"),
  max: 4,
});
const migrationClient = await database.connect();
try {
  await migrateSessionBroker(migrationClient);
} finally {
  migrationClient.release();
}
const run = createAgentJobRunner({
  kubernetes,
  config: {
    namespace,
    repositoryUrl,
    agentImage: requireDigestImage("CODEOPS_AGENT_IMAGE"),
    sessionGatewayImage: requireDigestImage("CODEOPS_SESSION_GATEWAY_IMAGE"),
    repositoryReadToken,
    modelAuth,
    evidenceRoot: required("CODEOPS_EVIDENCE_ROOT"),
  },
});

let serial: Promise<unknown> = Promise.resolve();
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    try {
      const sessionInitialization = await serveSessionJobInitialization({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: sessionJobInitializationToken,
        readBody: () => readJson(request),
        initialize: async (initializationRequest) => {
          const client = await database.connect();
          try {
            return await initializeSessionFromJob(client, {
              request: initializationRequest,
            });
          } finally {
            client.release();
          }
        },
      });
      if (sessionInitialization !== null) {
        json(response, sessionInitialization.status, sessionInitialization.body);
        return;
      }
    } catch (error) {
      json(
        response,
        error instanceof InvalidSessionJobInitializationRequestError ? 400 : 503,
        {
          status:
            error instanceof InvalidSessionJobInitializationRequestError
              ? "invalid-request"
              : "unavailable",
        },
      );
      return;
    }
    try {
      const sessionRuntime = await serveSessionRuntime({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: sessionRuntimeWorkerToken,
        workerId: sessionRuntimeWorkerId,
        readBody: () => readJson(request),
        claim: async (claimInput) => {
          const client = await database.connect();
          try {
            return await claimSessionRuntimeDispatch(client, claimInput);
          } finally {
            client.release();
          }
        },
        complete: async (completionInput) => {
          const client = await database.connect();
          try {
            return await completeSessionRuntimeDispatch(
              client,
              completionInput,
            );
          } finally {
            client.release();
          }
        },
        submitPermission: async (permissionInput) => {
          const client = await database.connect();
          try {
            return await submitSessionRuntimePermission(client, permissionInput);
          } finally {
            client.release();
          }
        },
        pollPermission: async (permissionInput) => {
          const client = await database.connect();
          try {
            return await pollSessionRuntimePermission(client, permissionInput);
          } finally {
            client.release();
          }
        },
      });
      if (sessionRuntime !== null) {
        json(response, sessionRuntime.status, sessionRuntime.body);
        return;
      }
    } catch (error) {
      const status =
        error instanceof InvalidSessionRuntimeRequestError
          ? 400
          : error instanceof SessionRuntimeDispatchNotFoundError ||
              error instanceof SessionRuntimePermissionNotFoundError
            ? 404
            : error instanceof ImmutableSessionRuntimeDispatchConflictError ||
                error instanceof SessionRuntimeClaimConflictError ||
                error instanceof SessionRuntimePermissionConflictError
              ? 409
              : 503;
      json(response, status, {
        status:
          status === 400
            ? "invalid-request"
            : status === 404
              ? "not-found"
              : status === 409
                ? "conflict"
                : "unavailable",
      });
      return;
    }
    try {
      const sessionCommand = await serveSessionBrokerCommand({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: sessionBrokerWriteToken,
        readBody: () => readJson(request),
        execute: async (commandInput) => {
          const client = await database.connect();
          try {
            return await executeLocalSessionCommandTransaction(
              client,
              commandInput,
            );
          } finally {
            client.release();
          }
        },
        enqueueRuntime: async (commandInput) => {
          const client = await database.connect();
          try {
            return await enqueueSessionRuntimeDispatch(client, commandInput);
          } finally {
            client.release();
          }
        },
      });
      if (sessionCommand !== null) {
        json(response, sessionCommand.status, sessionCommand.body);
        return;
      }
    } catch (error) {
      const status =
        error instanceof InvalidSessionCommandRequestError
          ? 400
          : error instanceof SessionNotFoundError
            ? 404
            : error instanceof ImmutableSessionCommandConflictError ||
                error instanceof SessionCompareAndSwapError ||
                error instanceof SessionForkConflictError
              ? 409
              : 503;
      json(response, status, {
        status:
          status === 400
            ? "invalid-request"
            : status === 404
              ? "not-found"
              : status === 409
                ? "conflict"
                : "unavailable",
      });
      return;
    }
    try {
      const sessionRead = await serveSessionBrokerRead({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: sessionBrokerReadToken,
        database,
      });
      if (sessionRead !== null) {
        json(response, sessionRead.status, sessionRead.body);
        return;
      }
    } catch (error) {
      json(response, error instanceof InvalidSessionReadRequestError ? 400 : 503, {
        status:
          error instanceof InvalidSessionReadRequestError
            ? "invalid-request"
            : "unavailable",
      });
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/v1/repository-heads/main"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        json(response, 200, {
          version: "codeops.repository-head/v1",
          ref: "refs/heads/main",
          sha: await resolveGitHubBranchHead({
            repositoryUrl,
            repositoryReadToken,
            branch: "main",
          }),
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    const reviewCommentsMatch =
      request.method === "GET"
        ? request.url?.match(
            /^\/v1\/pull-requests\/([1-9][0-9]{0,7})\/reviews\/([1-9][0-9]{0,15})\/comments$/,
          )
        : null;
    if (reviewCommentsMatch) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        json(response, 200, {
          version: "codeops.github-review-comments/v1",
          comments: await loadGitHubReviewComments({
            repositoryUrl,
            repositoryReadToken,
            pullRequestNumber: Number(reviewCommentsMatch[1]),
            reviewId: Number(reviewCommentsMatch[2]),
          }),
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    const qualificationMatch =
      request.method === "GET"
        ? request.url?.match(
            /^\/v1\/pull-requests\/([1-9][0-9]{0,7})\/heads\/([0-9a-f]{40})\/qualification$/,
          )
        : null;
    if (qualificationMatch) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        const pullRequestNumber = Number(qualificationMatch[1]);
        const headSha = qualificationMatch[2]!;
        json(response, 200, {
          version: "codeops.github-pull-request-qualification/v1",
          pullRequestNumber,
          headSha,
          qualified: await qualifyGitHubHead({
            repositoryUrl,
            repositoryReadToken,
            pullRequestNumber,
            headSha,
            requiredCheckNames: requiredReviewCheckNames,
          }),
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    const currentPullRequestMatch =
      request.method === "GET"
        ? request.url?.match(
            /^\/v1\/pull-requests\/([1-9][0-9]{0,7})\/current-head$/,
          )
        : null;
    if (currentPullRequestMatch) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        const pullRequest = await resolveGitHubPullRequestHead({
          repositoryUrl,
          repositoryReadToken,
          pullRequestNumber: Number(currentPullRequestMatch[1]),
        });
        json(response, 200, {
          version: "codeops.github-current-pull-request/v1",
          ...pullRequest,
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    const stackMatch =
      request.method === "GET"
        ? request.url?.match(
            /^\/v1\/pull-request-stacks\/([1-9][0-9]{0,7})$/,
          )
        : null;
    if (stackMatch) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        json(
          response,
          200,
          await loadGitHubPullRequestStack({
            repositoryUrl,
            repositoryToken: repositoryReadToken,
            stackNumber: Number(stackMatch[1]),
          }),
        );
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/pull-request-stacks"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          publicationToken,
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
        const link = githubPullRequestStackLinkSchema.parse(
          await readJson(request),
        );
        const result = serial.then(() =>
          linkGitHubPullRequestStack({
            link,
            repositoryUrl,
            repositoryWriteToken,
          }),
        );
        serial = result.catch(() => undefined);
        json(response, 200, await result);
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/candidate-publications"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          publicationToken,
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
        const publication = candidatePublicationSchema.parse(
          await readJson(request),
        );
        const result = serial.then(() =>
          publishCandidateRevision({
            publication,
            evidenceRoot: required("CODEOPS_EVIDENCE_ROOT"),
            repositoryWriteToken,
          }),
        );
        serial = result.catch(() => undefined);
        json(response, 200, await result);
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/agent-jobs") {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (
      !authenticateBearer(
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
        token,
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
      const dispatch = parseDispatchRequest(await readJson(request));
      const cancellation = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) {
          cancellation.abort(
            new Error("Agent Job dispatch client disconnected"),
          );
        }
      });
      const result = serial.then(() => run(dispatch, cancellation.signal));
      serial = result.catch(() => undefined);
      json(response, 200, await result);
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  })();
});

const port = Number(process.env.CODEOPS_HTTP_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_HTTP_PORT must be valid");
}
server.listen(port, process.env.CODEOPS_HTTP_HOST ?? "0.0.0.0");
