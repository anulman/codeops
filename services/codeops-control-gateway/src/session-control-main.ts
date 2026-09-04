import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import {
  runtimeRequirementsSchema,
  sha256CanonicalJsonDigest,
} from "@codeops/codeops-contracts";
import { validateSessionControlSecrets } from "./session-control-config.js";
import {
  authorizeSessionRuntimeGitHubRead,
  createGitHubReadProviderClient,
  SessionRuntimeGitHubReadConflictError,
  SessionRuntimeGitHubReadNotFoundError,
} from "./session-runtime-github-reads.js";
import {
  authorizeSessionRuntimeGitHubMutation,
  createGitHubMutationProviderClient,
  createGitHubMutationReconciliationProviderClient,
  executeAuthorizedSessionRuntimeGitHubMutation,
  SessionRuntimeGitHubMutationConflictError,
  SessionRuntimeGitHubMutationNotFoundError,
} from "./session-runtime-github-mutations.js";
import {
  loadUnknownProviderEffectReconciliation,
  operatorResolveProviderEffect,
  recordProviderEffectReconciliation,
} from "./provider-effect-receipts.js";
import {
  InvalidProviderEffectRequestError,
  serveProviderEffectReconciliation,
} from "./provider-effect-http.js";
import {
  createGitHubSteeringRegistry,
  loadGitHubSteeringRegistryFile,
} from "./repository-steering.js";
import {
  AmbiguousGitHubSessionTargetError,
  GitHubSessionTargetNotFoundError,
  InvalidGitHubSessionSteeringRequestError,
  serveGitHubSessionSteering,
} from "./github-session-steering.js";
import {
  AmbiguousPlaneSessionTargetError,
  InvalidPlaneSessionSteeringRequestError,
  PlaneSessionTargetNotFoundError,
  servePlaneSessionSteering,
} from "./plane-session-steering.js";
import { migrateSessionBroker } from "./session-broker-migration.js";
import { loadRuntimeProfileRegistryFile } from "./runtime-profile-registry.js";
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
  initializeAdmittedChildSessionFromJob,
  serveSessionJobInitialization,
} from "./session-job-initialization.js";
import {
  issueClaimedSessionModelAuthority,
  RevokedSessionModelAuthorityError,
} from "./session-model-authority.js";
import {
  ImmutableSessionRuntimeDispatchConflictError,
  SessionRuntimeDispatchNotFoundError,
  claimSessionRuntimeDispatch,
  renewSessionRuntimeDispatchClaim,
  completeSessionRuntimeDispatch,
  enqueueSessionRuntimeDispatch,
} from "./session-broker-runtime-outbox.js";
import {
  pollSessionRuntimePermission,
  SessionRuntimePermissionConflictError,
  SessionRuntimePermissionNotFoundError,
  submitSessionRuntimePermission,
} from "./session-runtime-permissions.js";
import { admitSessionRuntimeWorkItem, WorkItemAdmissionNotFoundError } from "./work-item-admission.js";
import {
  ImmutableSessionCommandConflictError,
  SessionCompareAndSwapError,
  SessionForkConflictError,
  SessionNotFoundError,
  SessionRuntimeClaimConflictError,
  listSessionSnapshots,
} from "./session-broker-repository.js";
import {
  authorizeSessionRuntimeWorkItemComment,
  authorizeSessionRuntimeWorkItemCreate,
  authorizeSessionRuntimeWorkItemGet,
  authorizeSessionRuntimeWorkItemRelate,
  authorizeSessionRuntimeWorkItemSearch,
  authorizeSessionRuntimeWorkItemUpdate,
  createWorkItemProviderClients,
  SessionRuntimeWorkItemConflictError,
  SessionRuntimeWorkItemNotFoundError,
} from "./session-runtime-work-items.js";
import {
  createGitHubBranchCandidateManifest,
  storeGitHubBranchCandidateChunk,
} from "./github-branch-publish-candidates.js";

const MAX_BODY_BYTES = 1024 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireDigestImage(name: string): string {
  const value = required(name);
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be an immutable digest image`);
  return value;
}

async function secretFile(name: string): Promise<string> {
  const value = (await readFile(required(name), "utf8")).trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("session body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("session body is empty");
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

const secrets = validateSessionControlSecrets({
  readToken: await secretFile("CODEOPS_SESSION_BROKER_READ_TOKEN_FILE"),
  writeToken: await secretFile("CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE"),
  workerToken: await secretFile("CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE"),
  initializationToken: await secretFile(
    "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE",
  ),
});
const repositorySteeringRegistryFile =
  process.env.CODEOPS_REPOSITORY_STEERING_REGISTRY_FILE?.trim();
const repositorySteeringRegistry =
  repositorySteeringRegistryFile === undefined ||
  repositorySteeringRegistryFile === ""
    ? createGitHubSteeringRegistry([
        {
          repository: required("CODEOPS_REPOSITORY_IDENTITY"),
          token: await secretFile(
            "CODEOPS_GITHUB_SESSION_STEERING_TOKEN_FILE",
          ),
        },
      ])
    : await loadGitHubSteeringRegistryFile(repositorySteeringRegistryFile);
const workerId = required("CODEOPS_SESSION_RUNTIME_WORKER_ID");
const materializationProfile = required("CODEOPS_DEPLOYMENT_PROFILE");
if (!["full-managed", "full-external", "custom"].includes(materializationProfile)) {
  throw new Error("CODEOPS_DEPLOYMENT_PROFILE is invalid");
}
const admittedChildMaterialization = {
  profile: materializationProfile as "full-managed" | "full-external" | "custom",
  release: required("CODEOPS_RELEASE"),
  agentImage: requireDigestImage("CODEOPS_AGENT_IMAGE"),
  runtimeWorkerImage: requireDigestImage("CODEOPS_SESSION_RUNTIME_WORKER_IMAGE"),
};
const runtimeProfileRegistry = await loadRuntimeProfileRegistryFile(
  required("CODEOPS_RUNTIME_PROFILE_REGISTRY_FILE"),
);
const runtimeRequirements = runtimeRequirementsSchema.parse({
  version: "codeops.runtime-requirements/v1",
  capabilities: ["acp", "checkpoint", "github-broker", "model-proxy", "work-items-broker"],
  minimumResources: { cpuMillis: 600, memoryMiB: 1_280, ephemeralStorageMiB: 1_280 },
  requiredAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  maximumAuthority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: required("CODEOPS_RUNTIME_COMPATIBILITY_POLICY_REVISION"),
});
const runtimeProfile = runtimeProfileRegistry.selectCompatible(runtimeRequirements);
const runtimeOwnerBinding = (selectedAt = new Date().toISOString()) => ({
  requirements: runtimeRequirements,
  launchBinding: {
    version: "codeops.runtime-launch-binding/v1" as const,
    requirementDigest: sha256CanonicalJsonDigest(runtimeRequirements),
    profile: runtimeProfile,
    selectedAt,
  },
});
const modelProxySigningKey = await secretFile(
  "CODEOPS_MODEL_PROXY_SIGNING_KEY_FILE",
);
const githubReadProviderOrigin =
  process.env.CODEOPS_GITHUB_READ_PROVIDER_ORIGIN?.trim();
const githubReadProviderTokenFile =
  process.env.CODEOPS_GITHUB_READ_PROVIDER_TOKEN_FILE?.trim();
if (
  (githubReadProviderOrigin === undefined) !==
  (githubReadProviderTokenFile === undefined)
) {
  throw new Error("GitHub read provider origin and token file must be configured together");
}
const githubReadProviderToken =
  githubReadProviderTokenFile === undefined
    ? undefined
    : (await readFile(githubReadProviderTokenFile, "utf8")).trim();
if (
  githubReadProviderToken !== undefined &&
  [
    secrets.readToken,
    secrets.writeToken,
    secrets.workerToken,
    secrets.initializationToken,
    modelProxySigningKey,
  ].includes(githubReadProviderToken)
) {
  throw new Error("GitHub read provider token must be a distinct authority");
}
const configuredGitHubReadProvider =
  githubReadProviderOrigin === undefined || githubReadProviderToken === undefined
    ? undefined
    : createGitHubReadProviderClient({
        origin: githubReadProviderOrigin,
        token: githubReadProviderToken,
      });
const githubMutationProviderOrigin =
  process.env.CODEOPS_GITHUB_MUTATION_PROVIDER_ORIGIN?.trim();
const githubMutationProviderTokenFile =
  process.env.CODEOPS_GITHUB_MUTATION_PROVIDER_TOKEN_FILE?.trim();
if (
  (githubMutationProviderOrigin === undefined) !==
  (githubMutationProviderTokenFile === undefined)
) {
  throw new Error(
    "GitHub mutation provider origin and token file must be configured together",
  );
}
const githubMutationProviderToken =
  githubMutationProviderTokenFile === undefined
    ? undefined
    : (await readFile(githubMutationProviderTokenFile, "utf8")).trim();
if (
  githubMutationProviderToken !== undefined &&
  [
    secrets.readToken,
    secrets.writeToken,
    secrets.workerToken,
    secrets.initializationToken,
    modelProxySigningKey,
    githubReadProviderToken,
  ].includes(githubMutationProviderToken)
) {
  throw new Error("GitHub mutation provider token must be a distinct authority");
}
const configuredGitHubMutationProvider =
  githubMutationProviderOrigin === undefined ||
  githubMutationProviderToken === undefined
    ? undefined
    : createGitHubMutationProviderClient({
        origin: githubMutationProviderOrigin,
        token: githubMutationProviderToken,
      });
const configuredGitHubMutationReconciliationProvider =
  githubMutationProviderOrigin === undefined ||
  githubMutationProviderToken === undefined
    ? undefined
    : createGitHubMutationReconciliationProviderClient({
        origin: githubMutationProviderOrigin,
        token: githubMutationProviderToken,
      });
const workItemProviderOrigin = process.env.CODEOPS_WORK_ITEM_PROVIDER_ORIGIN?.trim();
const workItemProviderTokenFile =
  process.env.CODEOPS_WORK_ITEM_PROVIDER_TOKEN_FILE?.trim();
if (
  (workItemProviderOrigin === undefined) !==
  (workItemProviderTokenFile === undefined)
) {
  throw new Error("work-item provider origin and token file must be configured together");
}
const workItemProviderToken =
  workItemProviderTokenFile === undefined
    ? undefined
    : (await readFile(workItemProviderTokenFile, "utf8")).trim();
if (
  githubReadProviderToken !== undefined &&
  workItemProviderToken === githubReadProviderToken
) {
  throw new Error("GitHub read and work-item providers require distinct authorities");
}
if (
  githubMutationProviderToken !== undefined &&
  workItemProviderToken === githubMutationProviderToken
) {
  throw new Error(
    "GitHub mutation and work-item providers require distinct authorities",
  );
}
if (
  workItemProviderToken !== undefined &&
  ([
    secrets.readToken,
    secrets.writeToken,
    secrets.workerToken,
    secrets.initializationToken,
    modelProxySigningKey,
  ].includes(workItemProviderToken))
) {
  throw new Error("work-item provider token must be a distinct authority");
}
const configuredWorkItemProvider =
  workItemProviderOrigin === undefined || workItemProviderToken === undefined
    ? undefined
    : createWorkItemProviderClients({
        origin: workItemProviderOrigin,
        token: workItemProviderToken,
      });
if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(workerId)) {
  throw new Error("session runtime worker identity is invalid");
}
const database = new Pool({
  connectionString: await secretFile("CODEOPS_DATABASE_URL_FILE"),
  max: 4,
});
const migrationClient = await database.connect();
try {
  await migrateSessionBroker(migrationClient, {
    legacySessionOwnerPrincipalId:
      process.env.CODEOPS_LEGACY_SESSION_OWNER_PRINCIPAL_ID?.trim() || undefined,
  });
} finally {
  migrationClient.release();
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    try {
      const result = await servePlaneSessionSteering({
        method: request.method,
        url: request.url,
        headers: request.headers,
        resolveToken: (repository) =>
          repositorySteeringRegistry.resolve(repository),
        readBody: () => readJson(request),
        listSessions: async () => {
          const client = await database.connect();
          try { return await listSessionSnapshots(client, 200); }
          finally { client.release(); }
        },
        enqueue: async (input) => {
          const client = await database.connect();
          try { return await enqueueSessionRuntimeDispatch(client, input); }
          finally { client.release(); }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const status =
        error instanceof InvalidPlaneSessionSteeringRequestError
          ? 400
          : error instanceof PlaneSessionTargetNotFoundError
            ? 404
            : error instanceof AmbiguousPlaneSessionTargetError
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
      const result = await serveGitHubSessionSteering({
        method: request.method,
        url: request.url,
        headers: request.headers,
        resolveToken: (repository) =>
          repositorySteeringRegistry.resolve(repository),
        readBody: () => readJson(request),
        listSessions: async () => {
          const client = await database.connect();
          try {
            return await listSessionSnapshots(client, 200);
          } finally {
            client.release();
          }
        },
        enqueue: async (input) => {
          const client = await database.connect();
          try {
            return await enqueueSessionRuntimeDispatch(client, input);
          } finally {
            client.release();
          }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const status =
        error instanceof InvalidGitHubSessionSteeringRequestError
          ? 400
          : error instanceof GitHubSessionTargetNotFoundError
            ? 404
            : error instanceof AmbiguousGitHubSessionTargetError
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
      const result = await serveSessionJobInitialization({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: secrets.initializationToken,
        readBody: () => readJson(request),
        initialize: async (initializationRequest) => {
          const client = await database.connect();
          try {
            const initialized = (initializationRequest as { admissionId?: string }).admissionId !== undefined
              ? await initializeAdmittedChildSessionFromJob(client, { request: initializationRequest })
              : await initializeSessionFromJob(client, {
                  request: initializationRequest,
                  runtimeOwner: runtimeOwnerBinding(),
                });
            return initialized;
          } finally {
            client.release();
          }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const invalid = error instanceof InvalidSessionJobInitializationRequestError;
      json(response, invalid ? 400 : 503, {
        status: invalid ? "invalid-request" : "unavailable",
      });
      return;
    }
    try {
      const result = await serveSessionRuntime({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: secrets.workerToken,
        workerId,
        readBody: () => readJson(request),
        claim: async (input) => {
          const client = await database.connect();
          try {
            return await claimSessionRuntimeDispatch(client, {
              ...input,
              fallbackRuntimeOwner: runtimeOwnerBinding(),
            });
          } finally {
            client.release();
          }
        },
        complete: async (input) => {
          const client = await database.connect();
          try {
            return await completeSessionRuntimeDispatch(client, input);
          } finally {
            client.release();
          }
        },
        renewClaim: async (input) => {
          const client = await database.connect();
          try {
            return await renewSessionRuntimeDispatchClaim(client, input);
          } finally {
            client.release();
          }
        },
        issueModelAuthority: async (authorityInput) => {
          const client = await database.connect();
          try {
            const authority = await issueClaimedSessionModelAuthority(client, {
              ...authorityInput,
              signingKey: modelProxySigningKey,
            });
            return {
              version: "codeops.session-runtime-model-authority-result/v1",
              dispatchId: authorityInput.dispatchId,
              modelProxyToken: authority.modelProxyToken,
              expiresAt: authority.expiresAt,
            };
          } finally {
            client.release();
          }
        },
        submitPermission: async (input) => {
          const client = await database.connect();
          try {
            return await submitSessionRuntimePermission(client, input);
          } finally {
            client.release();
          }
        },
        pollPermission: async (input) => {
          const client = await database.connect();
          try {
            return await pollSessionRuntimePermission(client, input);
          } finally {
            client.release();
          }
        },
        admitWorkItem: async (input) => {
          const client = await database.connect();
          try { return await admitSessionRuntimeWorkItem(client, {
            ...input, materialization: admittedChildMaterialization,
          }); }
          finally { client.release(); }
        },
        ...(configuredWorkItemProvider === undefined
          ? {}
          : {
              createWorkItem: async (input) => {
                const client = await database.connect();
                try {
                  const providerRequest =
                    await authorizeSessionRuntimeWorkItemCreate(client, input);
                  return await configuredWorkItemProvider.create(providerRequest);
                } finally {
                  client.release();
                }
              },
              getWorkItem: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredWorkItemProvider.get(
                    await authorizeSessionRuntimeWorkItemGet(client, input),
                  );
                } finally { client.release(); }
              },
              searchWorkItems: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredWorkItemProvider.search(
                    await authorizeSessionRuntimeWorkItemSearch(client, input),
                  );
                } finally { client.release(); }
              },
              commentWorkItem: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredWorkItemProvider.comment(
                    await authorizeSessionRuntimeWorkItemComment(client, input),
                  );
                } finally { client.release(); }
              },
              updateWorkItem: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredWorkItemProvider.update(
                    await authorizeSessionRuntimeWorkItemUpdate(client, input),
                  );
                } finally { client.release(); }
              },
              relateWorkItem: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredWorkItemProvider.relate(
                    await authorizeSessionRuntimeWorkItemRelate(client, input),
                  );
                } finally { client.release(); }
              },
            }),
        ...(configuredGitHubReadProvider === undefined
          ? {}
          : {
              readGitHub: async (input) => {
                const client = await database.connect();
                try {
                  return await configuredGitHubReadProvider(
                    await authorizeSessionRuntimeGitHubRead(client, input),
                  );
                } finally {
                  client.release();
                }
              },
            }),
        ...(configuredGitHubMutationProvider === undefined
          ? {}
          : {
              mutateGitHub: async (input) => {
                const client = await database.connect();
                try {
                  const authorization =
                    await authorizeSessionRuntimeGitHubMutation(client, input);
                  if (authorization.disposition === "replayed") {
                    return authorization.result;
                  }
                  const providerRequest = authorization.request;
                  return await executeAuthorizedSessionRuntimeGitHubMutation(
                    client,
                    {
                      request: providerRequest,
                      provider: configuredGitHubMutationProvider,
                    },
                  );
                } finally {
                  client.release();
                }
              },
            }),
        createGitHubBranchCandidateManifest: async (input) => {
          const client = await database.connect();
          try { await createGitHubBranchCandidateManifest(client, input); }
          finally { client.release(); }
        },
        storeGitHubBranchCandidateChunk: async (input) => {
          const client = await database.connect();
          try { await storeGitHubBranchCandidateChunk(client, input); }
          finally { client.release(); }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const status =
        error instanceof InvalidSessionRuntimeRequestError
          ? 400
          : error instanceof SessionRuntimeDispatchNotFoundError ||
              error instanceof SessionRuntimePermissionNotFoundError ||
              error instanceof SessionRuntimeGitHubReadNotFoundError ||
              error instanceof SessionRuntimeGitHubMutationNotFoundError
              || error instanceof WorkItemAdmissionNotFoundError
            ? 404
            : error instanceof SessionRuntimeWorkItemNotFoundError
              ? 404
            : error instanceof ImmutableSessionRuntimeDispatchConflictError ||
                error instanceof SessionRuntimeClaimConflictError ||
                error instanceof SessionRuntimePermissionConflictError
                || error instanceof SessionRuntimeWorkItemConflictError
                || error instanceof SessionRuntimeGitHubReadConflictError
                || error instanceof SessionRuntimeGitHubMutationConflictError
                || error instanceof RevokedSessionModelAuthorityError
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
      const result = await serveProviderEffectReconciliation({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: secrets.writeToken,
        readBody: () => readJson(request),
        reconcile: async ({ effectId, principalId }) => {
          if (configuredGitHubMutationReconciliationProvider === undefined) {
            throw new Error("GitHub mutation reconciliation provider is unavailable");
          }
          const client = await database.connect();
          try {
            const authority = await loadUnknownProviderEffectReconciliation(
              client,
              effectId,
              principalId,
            );
            const reconciliation =
              await configuredGitHubMutationReconciliationProvider(authority);
            await recordProviderEffectReconciliation(client, {
              request: authority.request,
              reconciliation,
              principalId,
            });
            return reconciliation;
          } finally {
            client.release();
          }
        },
        resolve: async (resolution) => {
          const client = await database.connect();
          try {
            await operatorResolveProviderEffect(client, resolution);
            return {
              version: "codeops.provider-effect-operator-resolution-result/v1",
              effectId: resolution.effectId,
              state: "operator_resolved",
            };
          } finally {
            client.release();
          }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const invalid = error instanceof InvalidProviderEffectRequestError;
      json(response, invalid ? 400 : 503, {
        status: invalid ? "invalid-request" : "unavailable",
      });
      return;
    }
    try {
      const result = await serveSessionBrokerCommand({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: secrets.writeToken,
        readBody: () => readJson(request),
        execute: async (input) => {
          const client = await database.connect();
          try {
            return await executeLocalSessionCommandTransaction(client, input);
          } finally {
            client.release();
          }
        },
        enqueueRuntime: async (input) => {
          const client = await database.connect();
          try {
            return await enqueueSessionRuntimeDispatch(client, {
              ...input,
              ownerPrincipalId: input.principalId,
            });
          } finally {
            client.release();
          }
        },
      });
      if (result !== null) {
        json(response, result.status, result.body);
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
      const result = await serveSessionBrokerRead({
        method: request.method,
        url: request.url,
        headers: request.headers,
        token: secrets.readToken,
        database,
      });
      if (result !== null) {
        json(response, result.status, result.body);
        return;
      }
    } catch (error) {
      const invalid = error instanceof InvalidSessionReadRequestError;
      json(response, invalid ? 400 : 503, {
        status: invalid ? "invalid-request" : "unavailable",
      });
      return;
    }
    json(response, 404, { status: "not-found" });
  })();
});

const port = Number(process.env.CODEOPS_HTTP_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_HTTP_PORT must be valid");
}
const shutdown = () => {
  server.close(() => void database.end());
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, process.env.CODEOPS_HTTP_HOST ?? "0.0.0.0");
