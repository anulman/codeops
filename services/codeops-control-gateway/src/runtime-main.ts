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
  type WorkspaceLaunch,
} from "@codeops/codeops-contracts";
import {
  linkGitHubPullRequestStack,
  loadGitHubPullRequestStack,
} from "./github-stacks.js";
import {
  KubernetesResourceIdentityDriftError,
  loadInClusterKubernetesClient,
} from "./kubernetes.js";
import { publishCandidateRevision } from "./publication.js";
import { createAgentJobRunner } from "./runtime.js";
import {
  createRepositoryRegistry,
  loadConfiguredRepositoryRegistry,
  loadRepositoryRegistryFile,
  resolveRepositoryRoute,
} from "./repository-registry.js";
import { createModelProxyToken } from "./model-proxy-token.js";
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
  loadSessionSnapshot,
} from "./session-broker-repository.js";
import {
  InvalidWorkspaceLaunchRequestError,
  serveWorkspaceLaunch,
} from "./workspace-launch-http.js";
import {
  admitWorkspaceLaunch,
  createCatalogSourceResolver,
} from "./workspace-launch.js";
import {
  createPostgresWorkspaceLaunchStore,
  listActiveWorkspaceLaunchIds,
  loadWorkspaceLaunchForPrincipal,
  loadWorkspaceLaunchRequest,
  updateWorkspaceLaunch,
} from "./workspace-launch-store.js";
import {
  PermanentWorkspaceLaunchError,
  reconcileWorkspaceLaunch,
  workspaceLaunchRuntimeIdentity,
} from "./workspace-launch-controller.js";

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

function kubernetesObjectName(name: string): string {
  const value = required(name);
  if (!/^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a Kubernetes object name`);
  }
  return value;
}

function stringMap(name: string): Readonly<Record<string, string>> {
  const value: unknown = JSON.parse(required(name));
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.entries(value).some(
      ([key, entry]) =>
        key.length === 0 ||
        key.length > 253 ||
        typeof entry !== "string" ||
        entry.length > 63,
    )
  ) {
    throw new Error(`${name} must be a JSON string map`);
  }
  return value as Readonly<Record<string, string>>;
}

function imagePullSecrets(name: string): readonly { readonly name: string }[] {
  const value: unknown = JSON.parse(required(name));
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        Object.keys(entry).length !== 1 ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        !/^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/.test(
          (entry as { name: string }).name,
        ),
    )
  ) {
    throw new Error(`${name} must be a JSON array of Secret names`);
  }
  return value as readonly { readonly name: string }[];
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
const workspaceLaunchToken = await secretFile(
  "CODEOPS_WORKSPACE_LAUNCH_TOKEN_FILE",
);
if (
  workspaceLaunchToken.length < 32 ||
  workspaceLaunchToken.length > 4_096 ||
  [
    token,
    repositoryHeadToken,
    publicationToken,
    sessionBrokerReadToken,
    sessionBrokerWriteToken,
    sessionRuntimeWorkerToken,
    sessionJobInitializationToken,
  ].includes(workspaceLaunchToken)
) {
  throw new Error("workspace launch token must be one distinct authority");
}
const repositoryRegistry = await loadConfiguredRepositoryRegistry({
  registryFile: process.env.CODEOPS_REPOSITORY_REGISTRY_FILE,
  loadRegistryFile: loadRepositoryRegistryFile,
  loadLegacy: async () => {
    const repositoryUrl = required("CODEOPS_REPOSITORY_URL");
    const repositoryIdentity = new URL(repositoryUrl).pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "");
    return createRepositoryRegistry([
      {
        repository: repositoryIdentity,
        repositoryUrl,
        readToken: await secretFile("CODEOPS_REPOSITORY_READ_TOKEN_FILE"),
        writeToken: await secretFile("CODEOPS_REPOSITORY_WRITE_TOKEN_FILE"),
      },
    ]);
  },
});
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
    repositoryRegistry,
    agentImage: requireDigestImage("CODEOPS_AGENT_IMAGE"),
    sessionGatewayImage: requireDigestImage("CODEOPS_SESSION_GATEWAY_IMAGE"),
    imagePullSecrets: imagePullSecrets("CODEOPS_AGENT_IMAGE_PULL_SECRETS"),
    nodeSelector: stringMap("CODEOPS_AGENT_NODE_SELECTOR"),
    evidenceClaimName: kubernetesObjectName("CODEOPS_AGENT_EVIDENCE_CLAIM_NAME"),
    modelProxyServiceName: kubernetesObjectName(
      "CODEOPS_AGENT_MODEL_PROXY_SERVICE_NAME",
    ),
    modelProxyPodName: kubernetesObjectName(
      "CODEOPS_AGENT_MODEL_PROXY_POD_NAME",
    ),
    modelAuth,
    evidenceRoot: required("CODEOPS_EVIDENCE_ROOT"),
  },
});

const workspaceSourceResolver = createCatalogSourceResolver({
  entries: new Map(
    repositoryRegistry.workspaceCatalog.repositories.map((entry) => [
      entry.key,
      { repository: entry.repository, defaultRef: entry.defaultRef },
    ]),
  ),
  resolveHead: async (repository, reference) => {
    if (reference !== "main") {
      throw new Error("workspace catalog supports only the server-owned main ref");
    }
    const authority = repositoryRegistry.resolve(repository);
    return resolveGitHubBranchHead({
      repositoryUrl: authority.repositoryUrl,
      repositoryReadToken: authority.readToken,
      branch: "main",
    });
  },
});

function workspaceResourceConfig(
  launch: WorkspaceLaunch,
  identity: ReturnType<typeof workspaceLaunchRuntimeIdentity>,
) {
  return {
    namespace,
    launchId: launch.launchId,
    principalId: launch.principalId,
    requestDigest: launch.requestDigest,
    ...(launch.title === undefined ? {} : { displayName: launch.title }),
    ...identity,
    workspace: launch.workspace,
    sources: launch.workspace.sources.map((source) => {
      const authority = repositoryRegistry.resolve(source.repository);
      return {
        catalogKey: source.catalogKey,
        repositoryUrl: authority.repositoryUrl,
        readToken: authority.readToken,
      };
    }),
    agentImage: requireDigestImage("CODEOPS_AGENT_IMAGE"),
    runtimeWorkerImage: requireDigestImage("CODEOPS_SESSION_RUNTIME_WORKER_IMAGE"),
    imagePullSecrets: imagePullSecrets("CODEOPS_AGENT_IMAGE_PULL_SECRETS"),
    nodeSelector: stringMap("CODEOPS_AGENT_NODE_SELECTOR"),
    runtimeServiceAccountName: kubernetesObjectName(
      "CODEOPS_SESSION_RUNTIME_SERVICE_ACCOUNT_NAME",
    ),
    sessionSecretsName: kubernetesObjectName(
      "CODEOPS_SESSION_SECRETS_NAME",
    ),
    sessionGatewayOrigin: required("CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN"),
    modelProxyOrigin: modelAuth.origin,
    workspaceStorageSize: required("CODEOPS_WORKSPACE_STORAGE_SIZE"),
    ...(process.env.CODEOPS_WORKSPACE_STORAGE_CLASS_NAME?.trim()
      ? {
          workspaceStorageClassName:
            process.env.CODEOPS_WORKSPACE_STORAGE_CLASS_NAME.trim(),
        }
      : {}),
  };
}

async function reconcileOneWorkspaceLaunch(launchId: string): Promise<void> {
  await reconcileWorkspaceLaunch(launchId, {
    load: async (identity) => {
      const client = await database.connect();
      try {
        return await loadWorkspaceLaunchRequest(client, identity);
      } finally {
        client.release();
      }
    },
    update: async (launch) => {
      const client = await database.connect();
      try {
        return await updateWorkspaceLaunch(client, launch);
      } finally {
        client.release();
      }
    },
    ensureResource: async (resource, requestDigest) => {
      try {
        await kubernetes.ensure(resource as never, requestDigest);
      } catch (error) {
        if (error instanceof KubernetesResourceIdentityDriftError) {
          throw new PermanentWorkspaceLaunchError(error.message, {
            cause: error,
          });
        }
        throw error;
      }
    },
    loadSession: async (sessionId) => {
      const client = await database.connect();
      try {
        return await loadSessionSnapshot(client, sessionId);
      } finally {
        client.release();
      }
    },
    loadJob: (name) => kubernetes.getJob(name),
    removeResource: (resource) => kubernetes.delete(resource as never),
    enqueuePrompt: async (input) => {
      const client = await database.connect();
      try {
        try {
          return await enqueueSessionRuntimeDispatch(client, input);
        } catch (error) {
          if (error instanceof ImmutableSessionRuntimeDispatchConflictError) {
            throw new PermanentWorkspaceLaunchError(error.message, {
              cause: error,
            });
          }
          throw error;
        }
      } finally {
        client.release();
      }
    },
    resourceConfig: workspaceResourceConfig,
  });
}

let workspaceReconciliation: Promise<void> = Promise.resolve();
function scheduleWorkspaceReconciliation(): void {
  workspaceReconciliation = workspaceReconciliation.then(async () => {
    const client = await database.connect();
    let launchIds: readonly string[];
    try {
      launchIds = await listActiveWorkspaceLaunchIds(client);
    } finally {
      client.release();
    }
    for (const launchId of launchIds) {
      await reconcileOneWorkspaceLaunch(launchId).catch((error) => {
        process.stderr.write(`${JSON.stringify({
          event: "workspace_launch_reconciliation_failed",
          launchId,
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      });
    }
  }).catch(() => undefined);
}
const workspaceReconciliationTimer = setInterval(
  scheduleWorkspaceReconciliation,
  2_000,
);
workspaceReconciliationTimer.unref();
scheduleWorkspaceReconciliation();

let serial: Promise<unknown> = Promise.resolve();
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    try {
      const workspaceLaunch = await serveWorkspaceLaunch({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: workspaceLaunchToken,
        readBody: () => readJson(request),
        catalog: repositoryRegistry.workspaceCatalog,
        admit: async (launchRequest, principalId) => {
          const client = await database.connect();
          try {
            const launch = await admitWorkspaceLaunch({
              request: launchRequest,
              principalId,
              resolver: workspaceSourceResolver,
              store: createPostgresWorkspaceLaunchStore(client),
            });
            scheduleWorkspaceReconciliation();
            return launch;
          } finally {
            client.release();
          }
        },
        load: async (launchId, principalId) => {
          const client = await database.connect();
          try {
            return await loadWorkspaceLaunchForPrincipal(
              client,
              launchId,
              principalId,
            );
          } finally {
            client.release();
          }
        },
      });
      if (workspaceLaunch !== null) {
        json(response, workspaceLaunch.status, workspaceLaunch.body);
        return;
      }
    } catch (error) {
      json(
        response,
        error instanceof InvalidWorkspaceLaunchRequestError ? 400 : 503,
        { status: error instanceof InvalidWorkspaceLaunchRequestError ? "invalid-request" : "unavailable" },
      );
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
            const initialized = await initializeSessionFromJob(client, {
              request: initializationRequest,
            });
            return {
              ...initialized,
              modelProxyToken: createModelProxyToken({
                subject: initialized.snapshot.sessionId,
                signingKey: modelAuth.signingKey,
              }),
            };
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
    let repositoryRoute;
    try {
      repositoryRoute = resolveRepositoryRoute(
        repositoryRegistry,
        request.url,
      );
    } catch {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (
      request.method === "GET" &&
      repositoryRoute?.path === "/heads/main"
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
          repository: repositoryRoute.authority.repository,
          ref: "refs/heads/main",
          sha: await resolveGitHubBranchHead({
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryReadToken: repositoryRoute.authority.readToken,
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
        ? repositoryRoute?.path.match(
            /^\/pull-requests\/([1-9][0-9]{0,7})\/reviews\/([1-9][0-9]{0,15})\/comments$/,
          )
        : null;
    if (reviewCommentsMatch && repositoryRoute !== null) {
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
          repository: repositoryRoute.authority.repository,
          comments: await loadGitHubReviewComments({
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryReadToken: repositoryRoute.authority.readToken,
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
        ? repositoryRoute?.path.match(
            /^\/pull-requests\/([1-9][0-9]{0,7})\/heads\/([0-9a-f]{40})\/qualification$/,
          )
        : null;
    if (qualificationMatch && repositoryRoute !== null) {
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
          repository: repositoryRoute.authority.repository,
          pullRequestNumber,
          headSha,
          qualified: await qualifyGitHubHead({
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryReadToken: repositoryRoute.authority.readToken,
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
        ? repositoryRoute?.path.match(
            /^\/pull-requests\/([1-9][0-9]{0,7})\/current-head$/,
          )
        : null;
    if (currentPullRequestMatch && repositoryRoute !== null) {
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
          repositoryUrl: repositoryRoute.authority.repositoryUrl,
          repositoryReadToken: repositoryRoute.authority.readToken,
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
        ? repositoryRoute?.path.match(
            /^\/pull-request-stacks\/([1-9][0-9]{0,7})$/,
          )
        : null;
    if (stackMatch && repositoryRoute !== null) {
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
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryToken: repositoryRoute.authority.readToken,
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
      repositoryRoute?.path === "/pull-request-stacks"
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
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryWriteToken: repositoryRoute.authority.writeToken,
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
      repositoryRoute?.path === "/candidate-publications"
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
        if (
          `${publication.repository.owner}/${publication.repository.name}` !==
          repositoryRoute.authority.repository
        ) {
          throw new Error(
            "candidate publication repository does not match its route",
          );
        }
        const result = serial.then(() =>
          publishCandidateRevision({
            publication,
            evidenceRoot: required("CODEOPS_EVIDENCE_ROOT"),
            repositoryWriteToken: repositoryRoute.authority.writeToken,
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
