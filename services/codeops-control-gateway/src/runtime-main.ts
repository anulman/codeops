import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool, type PoolClient } from "pg";
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
  canonicalJsonText,
  proofPublicationRequestSchema,
  githubMutationProviderRequestSchema,
  githubMutationReconciliationProviderRequestSchema,
  githubReadProviderRequestSchema,
  githubPullRequestStackLinkSchema,
  type AdmittedChildMaterializationInput,
  type WorkspaceLaunch,
} from "@codeops/codeops-contracts";
import { workspaceContextAttachmentDescriptors } from
  "@codeops/codeops-contracts/workspace-context-node";
import { createGitHubReadAdapter } from "./github-reads-adapter.js";
import {
  GitHubMutationPreflightNoEffectError,
} from "./github-mutations-adapter.js";
import { createGitHubMutationAdapter, createGitHubMutationReconciler } from "./github-branch-fast-forward.js";
import {
  linkGitHubPullRequestStack,
  loadGitHubPullRequestStack,
} from "./github-stacks.js";
import {
  assertKubernetesResourceOwnership,
  KubernetesResourceIdentityDriftError,
  loadInClusterKubernetesClient,
} from "./kubernetes.js";
import { publishCandidateRevision } from "./publication.js";
import { createProofPublisherClient } from "./proof-publisher-client.js";
import {
  projectAgentJobSessionStarted,
  projectAgentJobSessionTerminal,
} from "./agent-job-sessions.js";
import { createAgentJobRunner } from "./runtime.js";
import {
  createRepositoryRegistry,
  loadConfiguredRepositoryRegistry,
  loadRepositoryRegistryFile,
  resolveRepositoryRoute,
} from "./repository-registry.js";
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
  initializeAdmittedChildSessionFromJob,
  serveSessionJobInitialization,
} from "./session-job-initialization.js";
import { issueSessionModelAuthority } from "./session-model-authority.js";
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
import { admitSessionRuntimeWorkItem, WorkItemAdmissionNotFoundError } from "./work-item-admission.js";
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
  InvalidSessionNotificationRequestError,
  sessionNotificationFailureEvidence,
  serveSessionNotifications,
} from "./session-notification-http.js";
import {
  registerWebPushSubscription,
  revokeWebPushSubscription,
} from "./session-notification-store.js";
import { projectNextSessionNotification } from "./session-notification-projector.js";
import {
  InvalidSessionSupervisionReconciliationRequestError,
  reconcileSessionSupervision,
  serveSessionSupervisionReconciliation,
} from "./session-supervision.js";
import {
  acknowledgeWebPushDelivery,
  claimWebPushDelivery,
  sendClaimedWebPush,
} from "./session-notification-delivery.js";
import {
  admitWorkspaceLaunch,
  createCatalogSourceResolver,
} from "./workspace-launch.js";
import {
  createPostgresWorkspaceLaunchStore,
  listActiveWorkspaceLaunchIds,
  loadWorkspaceLaunchDetailForPrincipal,
  loadWorkspaceLaunchRequest,
  updateWorkspaceLaunch,
} from "./workspace-launch-store.js";
import { recordRuntimeEgressPodObservations } from "./runtime-egress-audit.js";
import {
  cleanupTerminalOrphanGitHubBranchCandidateChunks,
  loadGitHubBranchCandidate,
} from "./github-branch-publish-candidates.js";
import {
  PermanentWorkspaceLaunchError,
  reconcileWorkspaceLaunch,
  workspaceLaunchRuntimeIdentity,
} from "./workspace-launch-controller.js";
import {
  listInteractiveRuntimeCandidates,
  listRetainedInteractiveRuntimeJobUids,
  observeInteractiveRuntimeTerminal,
  recordInteractiveRuntimeJobProgress,
  reconcileInteractiveRuntimeTerminal,
} from "./session-runtime-terminal-reconciler.js";
import {
  claimAdmittedChildMaterialization,
  classifyAdmittedChildKubernetesError,
  releaseAdmittedChildMaterializationClaim,
  renewAdmittedChildMaterializationClaim,
  failAdmittedChildMaterialization,
  loadAdmittedChildMaterialization,
  lockAdmittedChildMaterializationAuthority,
  lockAdmittedChildMaterializationLease,
  PermanentAdmittedChildMaterializationError,
  reconcileAdmittedChildMaterialization,
  updateAdmittedChildMaterialization,
} from "./admitted-child-materialization-controller.js";
import {
  admittedChildWorkspaceLaunchId,
  buildAdmittedChildCleanupResources,
} from "./workspace-resources.js";
import {
  controlGatewayRuntimeRole,
  runtimeRoleOwnsRequest,
} from "./runtime-role.js";

const MAX_BODY_BYTES = 1024 * 1024;
const runtimeRole = controlGatewayRuntimeRole(
  process.env.CODEOPS_CONTROL_GATEWAY_RUNTIME_ROLE,
);

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

async function readJson(
  request: IncomingMessage,
  maximumBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("request body exceeds its limit");
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
const githubMutationToken = await secretFile(
  "CODEOPS_GITHUB_MUTATION_TOKEN_FILE",
);
if (
  githubMutationToken.length < 32 ||
  githubMutationToken.length > 4_096 ||
  githubMutationToken === repositoryHeadToken ||
  githubMutationToken === token
) {
  throw new Error("GitHub mutation token must be one distinct authority");
}
const modelProxySigningKey = await secretFile("CODEOPS_MODEL_PROXY_SIGNING_KEY_FILE");
const kubernetes = await loadInClusterKubernetesClient(namespace, modelProxySigningKey);

const modelAuth = {
  mode: "proxy" as const,
  origin: required("CODEOPS_MODEL_PROXY_ORIGIN"),
  signingKey: modelProxySigningKey,
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
const proofPublisherOrigin = process.env.CODEOPS_PROOF_PUBLISHER_ORIGIN?.trim() || null;
const proofPublisherPublicBaseUrl =
  process.env.CODEOPS_PROOF_PUBLISHER_PUBLIC_BASE_URL?.trim() || null;
const proofPublisherTokenFile =
  process.env.CODEOPS_PROOF_PUBLISHER_AUTH_TOKEN_FILE?.trim() || null;
if (
  new Set([
    proofPublisherOrigin === null,
    proofPublisherPublicBaseUrl === null,
    proofPublisherTokenFile === null,
  ]).size !== 1
) {
  throw new Error(
    "proof publisher origin, public base URL, and token file must be configured together",
  );
}
const proofPublisherToken = proofPublisherTokenFile === null
  ? null
  : await secretFile("CODEOPS_PROOF_PUBLISHER_AUTH_TOKEN_FILE");
if (proofPublisherToken === publicationToken) {
  throw new Error("proof publisher token must have a distinct authority");
}
const publishProof = proofPublisherOrigin === null ||
    proofPublisherPublicBaseUrl === null ||
    proofPublisherToken === null
  ? null
  : createProofPublisherClient({
      origin: proofPublisherOrigin,
      publicBaseUrl: proofPublisherPublicBaseUrl,
      token: proofPublisherToken,
    });
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
const webPushPublicKey = process.env.CODEOPS_WEB_PUSH_PUBLIC_KEY?.trim() || null;
const webPushPrivateKeyFile =
  process.env.CODEOPS_WEB_PUSH_PRIVATE_KEY_FILE?.trim() || null;
const webPushSubject = process.env.CODEOPS_WEB_PUSH_SUBJECT?.trim() || null;
if (
  [webPushPublicKey, webPushPrivateKeyFile, webPushSubject].filter(
    (value) => value !== null,
  ).length !== 0 &&
  [webPushPublicKey, webPushPrivateKeyFile, webPushSubject].some(
    (value) => value === null,
  )
) {
  throw new Error("Web Push configuration must provide public key, private key, and subject");
}
if (webPushSubject !== null) {
  const subject = new URL(webPushSubject);
  if (
    !["https:", "mailto:"].includes(subject.protocol) ||
    subject.username !== "" || subject.password !== "" || subject.hash !== ""
  ) {
    throw new Error("CODEOPS_WEB_PUSH_SUBJECT must be one credential-free HTTPS or mailto URL");
  }
}
const webPushVapid = webPushPublicKey === null
  ? null
  : await (async () => {
      const privateKey = await secretFile("CODEOPS_WEB_PUSH_PRIVATE_KEY_FILE");
      if (
        !/^[A-Za-z0-9_-]{80,128}$/.test(webPushPublicKey) ||
        !/^[A-Za-z0-9_-]{40,64}$/.test(privateKey)
      ) {
        throw new Error("Web Push VAPID key material is invalid");
      }
      return {
        subject: webPushSubject!,
        publicKey: webPushPublicKey,
        privateKey,
      };
    })();
const webPushConfiguration = {
  version: "codeops.web-push-configuration/v1" as const,
  enabled: webPushPublicKey !== null,
  publicKey: webPushPublicKey,
};
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
  sessionRuntimeWorkerToken === githubMutationToken ||
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
  sessionJobInitializationToken === githubMutationToken ||
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
    githubMutationToken,
    publicationToken,
    sessionBrokerReadToken,
    sessionBrokerWriteToken,
    sessionRuntimeWorkerToken,
    sessionJobInitializationToken,
  ].includes(workspaceLaunchToken)
) {
  throw new Error("workspace launch token must be one distinct authority");
}
const controlGatewayAuthorities = [
    token,
    repositoryHeadToken,
    githubMutationToken,
    modelAuth.signingKey,
    publicationToken,
    sessionBrokerReadToken,
    sessionBrokerWriteToken,
    sessionRuntimeWorkerToken,
    sessionJobInitializationToken,
    workspaceLaunchToken,
  ];
if (proofPublisherToken !== null) controlGatewayAuthorities.push(proofPublisherToken);
if (new Set(controlGatewayAuthorities).size !== controlGatewayAuthorities.length) {
  throw new Error("control gateway authorities must be mutually distinct");
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
const readGitHub = createGitHubReadAdapter({
  resolve: (repository) => repositoryRegistry.resolve(repository),
});
const loadBranchCandidate = async (request: Extract<
  import("@codeops/codeops-contracts").GitHubMutationProviderRequest,
  { readonly operation: "branch_publish" }
>) => {
  const client = await database.connect();
  try {
    const candidate = await loadGitHubBranchCandidate(client, {
      manifestId: request.input.candidate.manifestId,
      dispatchId: request.provenance.dispatchId,
      operationId: request.operationId,
      lock: false,
    });
    if (request.input.candidate.digest !==
        `sha256:${createHash("sha256").update(canonicalJsonText(candidate)).digest("hex")}` ||
        request.input.candidate.sizeBytes !== Buffer.byteLength(canonicalJsonText(candidate))) {
      throw new Error("GitHub branch candidate reference is inconsistent");
    }
    return candidate;
  } finally { client.release(); }
};
const mutateGitHub = createGitHubMutationAdapter({
  resolve: (repository) => repositoryRegistry.resolve(repository),
  loadBranchCandidate,
});
const reconcileGitHubMutation = createGitHubMutationReconciler({
  resolve: (repository) => repositoryRegistry.resolve(repository),
  loadBranchCandidate,
});
if (runtimeRole === "api") {
  const migrationClient = await database.connect();
  try {
    const retainedRuntimeJobUids =
      await listRetainedInteractiveRuntimeJobUids(
        migrationClient,
        (name) => kubernetes.getJob(name),
      );
    await migrateSessionBroker(migrationClient, {
      legacySessionOwnerPrincipalId:
        process.env.CODEOPS_LEGACY_SESSION_OWNER_PRINCIPAL_ID?.trim() || undefined,
      ...(retainedRuntimeJobUids === undefined
        ? {}
        : { retainedRuntimeJobUids }),
    });
  } finally {
    migrationClient.release();
  }
}
const run = runtimeRole === "file-dispatcher" ? createAgentJobRunner({
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
    sessionProjection: {
      started: async (request, runId) => {
        const client = await database.connect();
        try {
          await projectAgentJobSessionStarted({ client, request, runId });
        } finally {
          client.release();
        }
      },
      terminal: async ({ request, runId, response, state, source }) => {
        const client = await database.connect();
        try {
          await projectAgentJobSessionTerminal({
            client,
            request,
            runId,
            response,
            state,
            source,
          });
        } finally {
          client.release();
        }
      },
    },
  },
}) : null;

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
    policy: launch.policy,
    contextAttachments: launch.contextAttachments,
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
    modelProxyServiceName: kubernetesObjectName(
      "CODEOPS_AGENT_MODEL_PROXY_SERVICE_NAME",
    ),
    modelProxyPodName: kubernetesObjectName(
      "CODEOPS_AGENT_MODEL_PROXY_POD_NAME",
    ),
    ...(process.env.CODEOPS_RUNTIME_EGRESS_PROXY_ORIGIN?.trim()
      ? {
          runtimeEgressProxyOrigin:
            process.env.CODEOPS_RUNTIME_EGRESS_PROXY_ORIGIN.trim(),
          runtimeEgressProxyServiceName: kubernetesObjectName(
            "CODEOPS_RUNTIME_EGRESS_PROXY_SERVICE_NAME",
          ),
        }
      : {}),
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
    ensureResource: async (resource, requestDigest, expectedUid, expectedConfigDigest) => {
      try {
        return await kubernetes.ensure(
          resource as never, requestDigest, expectedUid, expectedConfigDigest,
        );
      } catch (error) {
        if (error instanceof KubernetesResourceIdentityDriftError) {
          throw new PermanentWorkspaceLaunchError(error.message, {
            cause: error,
          });
        }
        throw error;
      }
    },
    recoverResource: async (resource, requestDigest) => {
      try { return await kubernetes.recoverOwned(resource as never, requestDigest); }
      catch (error) {
        if (error instanceof KubernetesResourceIdentityDriftError) {
          throw new PermanentWorkspaceLaunchError(error.message, { cause: error });
        }
        throw error;
      }
    },
    readResourceUid: (resource) => kubernetes.readResourceUid(resource as never),
    loadSession: async (sessionId, ownerPrincipalId) => {
      const client = await database.connect();
      try {
        return await loadSessionSnapshot(client, sessionId, ownerPrincipalId);
      } finally {
        client.release();
      }
    },
    loadJob: (name) => kubernetes.getJob(name),
    listRuntimePods: (runId) => kubernetes.listRunPods(runId),
    recordRuntimePodObservations: async (observations) => {
      const client = await database.connect();
      try {
        await recordRuntimeEgressPodObservations(client, observations);
      } finally {
        client.release();
      }
    },
    removeResource: (resource, requestDigest, expectedUid, expectedConfigDigest) =>
      kubernetes.delete(resource as never, requestDigest, expectedUid, expectedConfigDigest),
    enqueuePrompt: async (input) => {
      const client = await database.connect();
      try {
        try {
          return await enqueueSessionRuntimeDispatch(client, {
            ...input,
            ownerPrincipalId: input.principalId,
          });
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
if (runtimeRole === "api") {
  const workspaceReconciliationTimer = setInterval(
    scheduleWorkspaceReconciliation,
    2_000,
  );
  workspaceReconciliationTimer.unref();
  scheduleWorkspaceReconciliation();
}

function admittedChildResourceConfig(input: AdmittedChildMaterializationInput) {
  const launchId = admittedChildWorkspaceLaunchId(input.admissionId);
  const workspace = input.identity.workspace;
  const base = workspaceResourceConfig({
    launchId, principalId: input.principalId, requestDigest: input.admissionDigest,
    policy: input.identity.policy,
    contextAttachments: input.identity.contextAttachments,
    workspace,
  } as WorkspaceLaunch, {
    sessionId: input.childSessionId, workflowId: input.workflowId, runId: input.runId,
    leaseId: input.lease.leaseId, promptIdempotencyKey: input.initialDispatch.command.idempotencyKey,
  });
  return { ...base, requestDigest: `sha256:${createHash("sha256")
    .update(canonicalJsonText(input)).digest("hex")}`,
    generation: input.generation, holderId: input.lease.holderId, identity: input.identity,
    agentImage: input.images.agent, runtimeWorkerImage: input.images.runtimeWorker,
    admittedChildOwner: { admissionId: input.admissionId, approvalId: input.approvalId,
      parentSessionId: input.parentSessionId, childDispatchId: input.childDispatchId,
      repository: input.workItem.repository, sourceSha: input.workItem.sourceSha,
      workItemId: input.workItem.workItemId,
      release: input.release, profile: input.profile } };
}

async function withAdmittedChildAuthority<T>(admissionId: string, inputDigest: string,
  allowedStates: readonly string[], claimToken: string,
  effect: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await renewAdmittedChildMaterializationClaim(client, admissionId,
      admittedChildControllerId, claimToken, 120_000);
    await lockAdmittedChildMaterializationAuthority(client, admissionId, inputDigest,
      allowedStates, claimToken);
    const result = await effect(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withAdmittedChildLease<T>(admissionId: string, inputDigest: string,
  allowedStates: readonly string[], claimToken: string,
  effect: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await renewAdmittedChildMaterializationClaim(client, admissionId,
      admittedChildControllerId, claimToken, 120_000);
    await lockAdmittedChildMaterializationLease(client, admissionId, inputDigest,
      allowedStates, claimToken);
    const result = await effect(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let admittedChildReconciliation: Promise<void> = Promise.resolve();
let admittedChildReconciliationRunning = false;
const admittedChildControllerId = `control-gateway:${randomUUID()}`;
function scheduleAdmittedChildReconciliation(): void {
  if (admittedChildReconciliationRunning) return;
  admittedChildReconciliationRunning = true;
  admittedChildReconciliation = (async () => {
    const listClient = await database.connect();
    let claim: { admissionId: string; token: string } | null;
    try { claim = await claimAdmittedChildMaterialization(
      listClient, admittedChildControllerId, randomUUID()); }
    finally { listClient.release(); }
    if (claim !== null) {
      const { admissionId, token: claimToken } = claim;
      try { await reconcileAdmittedChildMaterialization(admissionId, {
        load: async (id) => { const client = await database.connect();
          try { return await loadAdmittedChildMaterialization(client, id, claimToken); }
          finally { client.release(); } },
        update: async (state) => { const client = await database.connect();
          try { return await updateAdmittedChildMaterialization(client, state, claimToken); }
          finally { client.release(); } },
        ensureResource: async (resource, identity, expectedUid, allowedStates, expectedConfigDigest) => {
          try { return await withAdmittedChildAuthority(admissionId, identity, allowedStates,
            claimToken,
            async () => kubernetes.ensure(resource as never, identity, expectedUid,
              expectedConfigDigest)); }
          catch (error) { throw classifyAdmittedChildKubernetesError(error); }
        },
        loadJob: (resource, identity, binding, allowedStates) =>
          withAdmittedChildAuthority(admissionId, identity, allowedStates, claimToken, async () => {
            try {
            const job = await kubernetes.getJob(
              (resource.metadata as { name: string }).name,
            );
            assertKubernetesResourceOwnership(
              job as never, resource as never, identity, binding.uid, binding.configDigest,
            );
            return job;
            } catch (error) { throw classifyAdmittedChildKubernetesError(error); }
          }),
        listRuntimePods: (runId, identity, allowedStates) => withAdmittedChildAuthority(admissionId,
          identity, allowedStates, claimToken, async () => {
            try { return await kubernetes.listRunPods(runId, true); }
            catch (error) { throw classifyAdmittedChildKubernetesError(error); }
          }),
        removeResource: async (resource, identity, expectedUid, expectedConfigDigest, allowedStates) => {
          try {
            const fenced = allowedStates.includes("cleanup-pending") ||
                allowedStates.includes("success-finalizing")
              ? withAdmittedChildLease : withAdmittedChildAuthority;
            await fenced(admissionId, identity, allowedStates, claimToken, async () =>
              kubernetes.delete(resource as never, identity, expectedUid, expectedConfigDigest));
          }
          catch (error) { throw classifyAdmittedChildKubernetesError(error); }
        },
        recoverResource: async (resource, identity, allowedStates) => {
          try { return await withAdmittedChildLease(admissionId, identity, allowedStates,
            claimToken, async () => kubernetes.recoverOwned(resource as never, identity)); }
          catch (error) { throw classifyAdmittedChildKubernetesError(error); }
        },
        readResourceUid: async (resource, identity, allowedStates) => {
          try { return await withAdmittedChildAuthority(admissionId, identity, allowedStates,
            claimToken, async () => kubernetes.readResourceUid(resource as never)); }
          catch (error) { throw classifyAdmittedChildKubernetesError(error); }
        },
        markReady: async (state) => withAdmittedChildAuthority(admissionId,
          state.inputDigest, ["success-finalizing"], claimToken,
          (client) => updateAdmittedChildMaterialization(client, state, claimToken)),
        markSuccessFinalizing: async (state) => withAdmittedChildAuthority(admissionId,
          state.inputDigest, ["runtime-authorized"], claimToken,
          (client) => updateAdmittedChildMaterialization(client, state, claimToken)),
        markFailed: async (state) => withAdmittedChildLease(admissionId,
          state.inputDigest, ["cleanup-pending"], claimToken,
          (client) => failAdmittedChildMaterialization(client, state, claimToken)),
        resourceConfig: admittedChildResourceConfig,
        cleanupResources: (input, identity) => buildAdmittedChildCleanupResources({
          namespace,
          admissionId: input.admissionId,
          requestDigest: identity,
          owner: {
            admissionId: input.admissionId, approvalId: input.approvalId,
            parentSessionId: input.parentSessionId, childDispatchId: input.childDispatchId,
            repository: input.workItem.repository, sourceSha: input.workItem.sourceSha,
            workItemId: input.workItem.workItemId, release: input.release, profile: input.profile,
          },
        }),
      }); }
      catch (error) { process.stderr.write(`${JSON.stringify({
        event: "admitted_child_materialization_reconciliation_failed", admissionId,
        error: error instanceof Error ? error.message : String(error),
      })}\n`); }
      finally {
        const releaseClient = await database.connect();
        try { await releaseAdmittedChildMaterializationClaim(
          releaseClient, admissionId, claimToken); }
        finally { releaseClient.release(); }
      }
    }
  })().catch(() => undefined).finally(() => { admittedChildReconciliationRunning = false; });
}
if (runtimeRole === "api") {
  const admittedChildReconciliationTimer = setInterval(scheduleAdmittedChildReconciliation, 2_000);
  admittedChildReconciliationTimer.unref();
  scheduleAdmittedChildReconciliation();
}

let runtimeTerminalReconciliation: Promise<void> = Promise.resolve();
function scheduleRuntimeTerminalReconciliation(): void {
  runtimeTerminalReconciliation = runtimeTerminalReconciliation.then(async () => {
    const client = await database.connect();
    let candidates;
    try {
      candidates = await listInteractiveRuntimeCandidates(client);
    } finally {
      client.release();
    }
    for (const candidate of candidates) {
      try {
        const observedAt = new Date().toISOString();
        const job = await kubernetes.getJob(candidate.jobName);
        const progressClient = await database.connect();
        let progress;
        try {
          progress = await recordInteractiveRuntimeJobProgress(progressClient, {
            candidate,
            job,
            observedAt,
          });
        } finally {
          progressClient.release();
        }
        if (progress === "stale") continue;
        const observation = observeInteractiveRuntimeTerminal({
          candidate,
          job,
          pods: await kubernetes.listRunPods(candidate.runId,
            candidate.runtimeUid !== undefined),
          observedAt,
        });
        if (observation === null) continue;
        const reconciliationClient = await database.connect();
        try {
          await reconcileInteractiveRuntimeTerminal(
            reconciliationClient,
            observation,
          );
        } finally {
          reconciliationClient.release();
        }
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          event: "session_runtime_terminal_reconciliation_failed",
          sessionId: candidate.sessionId,
          generation: candidate.generation,
          runId: candidate.runId,
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      }
    }
    const cleanupClient = await database.connect();
    try {
      await cleanupTerminalOrphanGitHubBranchCandidateChunks(cleanupClient);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: "github_branch_candidate_orphan_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    } finally {
      cleanupClient.release();
    }
  }).catch(() => undefined);
}
if (runtimeRole === "api") {
  const runtimeTerminalReconciliationTimer = setInterval(
    scheduleRuntimeTerminalReconciliation,
    2_000,
  );
  runtimeTerminalReconciliationTimer.unref();
  scheduleRuntimeTerminalReconciliation();
}

let sessionNotificationProjection: Promise<void> = Promise.resolve();
function scheduleSessionNotificationProjection(): void {
  if (webPushVapid === null) return;
  sessionNotificationProjection = sessionNotificationProjection.then(async () => {
    for (let projected = 0; projected < 50; projected += 1) {
      const client = await database.connect();
      try {
        if (!await projectNextSessionNotification({ database: client })) break;
      } finally {
        client.release();
      }
    }
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "session_notification_projection_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  });
}
if (runtimeRole === "api") {
  const sessionNotificationProjectionTimer = setInterval(
    scheduleSessionNotificationProjection,
    2_000,
  );
  sessionNotificationProjectionTimer.unref();
  scheduleSessionNotificationProjection();
}

const webPushWorkerId = "control-gateway:web-push";
let webPushDelivery: Promise<void> = Promise.resolve();
function scheduleWebPushDelivery(): void {
  if (webPushVapid === null) return;
  webPushDelivery = webPushDelivery.then(async () => {
    for (let delivered = 0; delivered < 20; delivered += 1) {
      const claim = await claimWebPushDelivery({
        database,
        workerId: webPushWorkerId,
      });
      if (claim === null) break;
      const outcome = await sendClaimedWebPush({ claim, vapid: webPushVapid });
      const client = await database.connect();
      try {
        await acknowledgeWebPushDelivery({ database: client, claim, outcome });
      } finally {
        client.release();
      }
    }
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "web_push_delivery_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  });
}
if (runtimeRole === "api") {
  const webPushDeliveryTimer = setInterval(scheduleWebPushDelivery, 1_000);
  webPushDeliveryTimer.unref();
  scheduleWebPushDelivery();
}

let serial: Promise<unknown> = Promise.resolve();
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (!runtimeRoleOwnsRequest(runtimeRole, request.method, request.url)) {
      json(response, 404, { status: "not-found" });
      return;
    }
    try {
      const sessionNotifications = await serveSessionNotifications({
        method: request.method,
        url: request.url,
        headers: request.headers,
        readToken: sessionBrokerReadToken,
        writeToken: sessionBrokerWriteToken,
        configuration: webPushConfiguration,
        readBody: () => readJson(request),
        register: (subscription, principalId) =>
          registerWebPushSubscription({
            database,
            principalId,
            subscription,
          }),
        revoke: (subscription, principalId) =>
          revokeWebPushSubscription({
            database,
            principalId,
            subscription,
          }),
      });
      if (sessionNotifications !== null) {
        json(response, sessionNotifications.status, sessionNotifications.body);
        return;
      }
    } catch (error) {
      if (!(error instanceof InvalidSessionNotificationRequestError)) {
        process.stderr.write(`${JSON.stringify(
          sessionNotificationFailureEvidence(error),
        )}\n`);
      }
      json(
        response,
        error instanceof InvalidSessionNotificationRequestError ? 400 : 503,
        {
          status:
            error instanceof InvalidSessionNotificationRequestError
              ? "invalid-request"
              : "unavailable",
        },
      );
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
            return await loadWorkspaceLaunchDetailForPrincipal(
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
            const initialized = (initializationRequest as { version?: string }).version ===
                "codeops.session-job-initialization/v3"
              ? await initializeAdmittedChildSessionFromJob(client, { request: initializationRequest })
              : await initializeSessionFromJob(client, { request: initializationRequest });
            const issuedAt = new Date();
            const modelAuthority = issueSessionModelAuthority({
              snapshot: initialized.snapshot,
              signingKey: modelAuth.signingKey,
              issuedAt,
            });
            return {
              ...initialized,
              ...(modelAuthority.disposition === "disabled"
                ? {}
                : {
                    modelProxyToken: modelAuthority.modelProxyToken,
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
      const supervisionReconciliation =
        await serveSessionSupervisionReconciliation({
          method: request.method,
          url: request.url,
          headers: request.headers,
          token: sessionJobInitializationToken,
          readBody: () => readJson(request),
          reconcile: async (reconciliationRequest) => {
            const client = await database.connect();
            try {
              return await reconcileSessionSupervision(
                client,
                reconciliationRequest,
              );
            } finally {
              client.release();
            }
          },
        });
      if (supervisionReconciliation !== null) {
        json(
          response,
          supervisionReconciliation.status,
          supervisionReconciliation.body,
        );
        return;
      }
    } catch (error) {
      json(
        response,
        error instanceof InvalidSessionSupervisionReconciliationRequestError
          ? 400
          : 503,
        {
          status:
            error instanceof InvalidSessionSupervisionReconciliationRequestError
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
        admitWorkItem: async (admissionInput) => {
          const client = await database.connect();
          try { return await admitSessionRuntimeWorkItem(client, {
            ...admissionInput, materialization: admittedChildMaterialization,
          }); }
          finally { client.release(); }
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
              error instanceof SessionRuntimePermissionNotFoundError ||
              error instanceof WorkItemAdmissionNotFoundError
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
            return await enqueueSessionRuntimeDispatch(client, {
              ...commandInput,
              ownerPrincipalId: commandInput.principalId,
            });
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
      request.method === "POST" &&
      repositoryRoute?.path === "/proof-publications"
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
      if (publishProof === null) {
        json(response, 503, { status: "plugin-unavailable" });
        return;
      }
      try {
        const publication = proofPublicationRequestSchema.parse(
          await readJson(request, 84 * 1024 * 1024),
        );
        if (
          publication.identity.repository !==
          repositoryRoute.authority.repository
        ) {
          throw new Error("proof publication repository does not match its route");
        }
        const receipt = await publishProof(publication);
        json(response, receipt.status === "published" ? 200 : 409, receipt);
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      repositoryRoute?.path === "/github-reads"
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
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 415, { status: "unsupported-media-type" });
        return;
      }
      try {
        const githubRead = githubReadProviderRequestSchema.parse(
          await readJson(request),
        );
        if (
          githubRead.input.repository !==
          repositoryRoute.authority.repository
        ) {
          throw new Error("GitHub read repository does not match its route");
        }
        json(response, 200, await readGitHub(githubRead));
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      repositoryRoute?.path === "/github-mutations/reconcile"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          githubMutationToken,
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
        const reconciliation = githubMutationReconciliationProviderRequestSchema.parse(
          await readJson(request),
        );
        if (
          reconciliation.request.input.repository !==
          repositoryRoute.authority.repository
        ) {
          throw new Error("GitHub reconciliation repository does not match its route");
        }
        json(
          response,
          200,
          await reconcileGitHubMutation(
            reconciliation.request,
            new Date(reconciliation.attemptedAt),
          ),
        );
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      repositoryRoute?.path === "/github-mutations"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          githubMutationToken,
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
        const githubMutation = githubMutationProviderRequestSchema.parse(
          await readJson(request),
        );
        if (
          githubMutation.input.repository !==
          repositoryRoute.authority.repository
        ) {
          throw new Error("GitHub mutation repository does not match its route");
        }
        json(response, 200, await mutateGitHub(githubMutation));
      } catch (error) {
        if (error instanceof GitHubMutationPreflightNoEffectError) {
          json(response, 409, { status: "no-effect" });
        } else {
          json(response, 503, { status: "unavailable" });
        }
      }
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
            /^\/pull-requests\/([1-9][0-9]{0,7})\/heads\/([0-9a-f]{40})\/bases\/([0-9a-f]{40})\/refs\/([^/]{1,600})\/qualification$/,
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
        const baseSha = qualificationMatch[3]!;
        const baseRef = decodeURIComponent(qualificationMatch[4]!);
        json(response, 200, {
          version: "codeops.github-pull-request-qualification/v1",
          repository: repositoryRoute.authority.repository,
          pullRequestNumber,
          headSha,
          baseRef,
          baseSha,
          qualified: await qualifyGitHubHead({
            repositoryUrl: repositoryRoute.authority.repositoryUrl,
            repositoryReadToken: repositoryRoute.authority.readToken,
            pullRequestNumber,
            headSha,
            baseRef,
            baseSha,
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
      const result = serial.then(() => run!(dispatch, cancellation.signal));
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
