import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { z } from "zod";
import {
  workItemProviderCommentRequestSchema,
  workItemProviderCreateRequestSchema,
  workItemProviderGetRequestSchema,
  workItemProviderRelateRequestSchema,
  workItemProviderSearchRequestSchema,
  workItemProviderUpdateRequestSchema,
} from "@codeops/codeops-contracts";
import {
  createFileResearchDedupLedger,
  createFileCodingRequestStore,
  createFilePullRequestBindingStore,
  createFileWorkflowBindingStore,
  createGitHubHeadQualifier,
  createGitHubReviewCommentsLoader,
  createGitHubWebhookRegistry,
  createGitHubStackLoader,
  createGitHubSessionSteeringClient,
  createPlaneSessionSteeringClient,
  createGitHubCurrentPullRequestResolver,
  createPlaneLifecycleClient,
  createRepositoryPlaneRegistry,
  createTemporalCodingCanceller,
  createFileResearchPacketStore,
  createPlaneApiClient,
  adoptExistingPullRequest,
  identifyPlaneReadyTransition,
  loadGitHubWebhookRegistryFile,
  loadRepositoryPlaneRegistryFile,
  loadProjectContextDocuments,
  projectResearchPacket,
  processPlaneReadyWebhook,
  processPlaneResearchWebhook,
  processPlaneSessionWebhook,
  reconcileGitHubPullRequestReviewEvent,
  reconcileGitHubPullRequestMergeGroup,
  reconcileGitHubSessionEvent,
} from "./index.js";
import {
  createPlaneWebhookRequestListener,
  createRepositoryHeadResolver,
  createTemporalCodingEnqueuer,
  createTemporalResearchEnqueuer,
} from "./runtime.js";
import {
  commentOnPlaneWorkItem,
  createPlaneWorkItem,
  getPlaneWorkItem,
  relatePlaneWorkItems,
  searchPlaneWorkItems,
  updatePlaneWorkItem,
} from "./work-item-provider.js";
import { createModelPlaneCommentRequestClassifier } from "./comment-classifier.js";

const personaHandle = z.enum([
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
]);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function secretFile(name: string): Promise<string> {
  const value = (await readFile(required(name), "utf8")).trim();
  if (value.length === 0) throw new Error(`${name} is empty`);
  return value;
}

function legacyRepositoryPolicy() {
  const planePersonas = required("CODEOPS_PERSONA_USER_IDS")
    .split(",")
    .map((entry) => entry.split("="))
    .map(([userId, handle, ...extra]) => {
      if (userId === undefined || handle === undefined || extra.length > 0) {
        throw new Error("CODEOPS_PERSONA_USER_IDS contains an invalid mapping");
      }
      return {
        userId: z.string().uuid().parse(userId),
        handle: personaHandle.parse(handle),
      };
    });
  return {
    githubReviewerIds: required("CODEOPS_ALLOWED_GITHUB_REVIEWER_IDS")
      .split(",")
      .map((value) => Number(value.trim())),
    planeHumanActorIds: required("CODEOPS_ALLOWED_HUMAN_ACTOR_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    planePersonas,
    projectContextRoot:
      process.env.CODEOPS_PROJECT_CONTEXT_ROOT ?? "/app/project-context",
  };
}

const temporalConnection = await Connection.connect({
  address: required("CODEOPS_TEMPORAL_ADDRESS"),
});
const temporalClient = new Client({
  connection: temporalConnection,
  namespace: process.env.CODEOPS_TEMPORAL_NAMESPACE ?? "codeops",
});
const projectionToken = await secretFile(
  "CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE",
);
if (projectionToken.length < 32 || projectionToken.length > 4_096) {
  throw new Error("CodeOps research projection token is invalid");
}
const workItemMutationToken = await secretFile(
  "CODEOPS_WORK_ITEM_MUTATION_TOKEN_FILE",
);
const repositoryHeadToken = await secretFile(
  "CODEOPS_REPOSITORY_HEAD_TOKEN_FILE",
);
const existingPullRequestAdoptionToken = await secretFile(
  "CODEOPS_EXISTING_PR_ADOPTION_TOKEN_FILE",
);
const classifyCommentRequest = createModelPlaneCommentRequestClassifier({
  origin: required("CODEOPS_MODEL_PROXY_ORIGIN"),
  signingKey: await secretFile("CODEOPS_MODEL_PROXY_SIGNING_KEY_FILE"),
});
if (
  workItemMutationToken.length < 32 ||
  workItemMutationToken.length > 4_096 ||
  workItemMutationToken === projectionToken ||
  workItemMutationToken === repositoryHeadToken ||
  existingPullRequestAdoptionToken.length < 32 ||
  existingPullRequestAdoptionToken.length > 4_096 ||
  [projectionToken, workItemMutationToken, repositoryHeadToken].includes(
    existingPullRequestAdoptionToken,
  )
) {
  throw new Error("CodeOps work-item mutation token is invalid or reused");
}
const githubSessionSteeringOrigin = required(
  "CODEOPS_GITHUB_SESSION_STEERING_ORIGIN",
);
const repositoryRegistryFile =
  process.env.CODEOPS_REPOSITORY_REGISTRY_FILE?.trim();
const legacyRepositoryFullName =
  repositoryRegistryFile === undefined || repositoryRegistryFile === ""
    ? `${required("CODEOPS_REPOSITORY_OWNER")}/${required("CODEOPS_REPOSITORY_NAME")}`
    : undefined;
const planeRegistry =
  repositoryRegistryFile === undefined || repositoryRegistryFile === ""
    ? createRepositoryPlaneRegistry([
        {
          repository: legacyRepositoryFullName!,
          apiOrigin: required("CODEOPS_PLANE_API_ORIGIN"),
          workspaceSlug: required("CODEOPS_PLANE_WORKSPACE_SLUG"),
          workspaceId: required("CODEOPS_PLANE_WORKSPACE_ID"),
          projectId: required("CODEOPS_PLANE_PROJECT_ID"),
          apiKey: await secretFile("CODEOPS_PLANE_API_KEY_FILE"),
          webhookSecret: await secretFile("CODEOPS_PLANE_WEBHOOK_SECRET_FILE"),
          stateIds: {
            ready: required("CODEOPS_READY_STATE_ID"),
            inProgress: required("CODEOPS_IN_PROGRESS_STATE_ID"),
            needsAttention: required("CODEOPS_NEEDS_ATTENTION_STATE_ID"),
            complete: required("CODEOPS_COMPLETE_STATE_ID"),
          },
          policy: legacyRepositoryPolicy(),
        },
      ])
    : await loadRepositoryPlaneRegistryFile(repositoryRegistryFile);
const planeRuntimes = new Map(
  await Promise.all(
    planeRegistry.repositories.map(async (repository) => {
      const authority = planeRegistry.resolve(repository);
      return [
        repository,
        {
          authority,
          client: createPlaneApiClient({
            baseUrl: authority.apiOrigin,
            workspaceSlug: authority.workspaceSlug,
            apiKey: authority.apiKey,
          }),
          lifecycle: createPlaneLifecycleClient({
            baseUrl: authority.apiOrigin,
            workspaceSlug: authority.workspaceSlug,
            apiKey: authority.apiKey,
            allowedTargetStateIds: [
              authority.stateIds.needsAttention,
              authority.stateIds.inProgress,
              authority.stateIds.complete,
            ],
          }),
          allowedGitHubReviewerIds: new Set(authority.policy.githubReviewerIds),
          allowedHumanActorIds: new Set(authority.policy.planeHumanActorIds),
          personaUserIds: new Map(
            authority.policy.planePersonas.map(({ userId, handle }) => [
              userId,
              handle,
            ]),
          ),
          projectContextDocuments: await loadProjectContextDocuments(
            authority.policy.projectContextRoot,
          ),
        },
      ] as const;
    }),
  ),
);

function planeRuntimeForRepository(repository: string) {
  const runtime = planeRuntimes.get(repository);
  if (runtime === undefined) {
    throw new Error("repository is not admitted by the Plane runtime");
  }
  return runtime;
}

function planeRuntimeForProject(projectId: string) {
  return planeRuntimeForRepository(
    planeRegistry.resolveProject(projectId).repository,
  );
}

function requireRepositoryProject(
  repository: string,
  projectId: string,
  workspaceId?: string,
): void {
  const authority = planeRegistry.resolve(repository);
  if (
    authority.projectId !== projectId ||
    (workspaceId !== undefined && authority.workspaceId !== workspaceId)
  ) {
    throw new Error("Plane project does not match the repository authority");
  }
}
const githubWebhookRegistry =
  repositoryRegistryFile === undefined || repositoryRegistryFile === ""
    ? createGitHubWebhookRegistry([
        {
          repository: legacyRepositoryFullName!,
          webhookSecret: await secretFile("CODEOPS_GITHUB_WEBHOOK_SECRET_FILE"),
          steeringToken: await secretFile(
            "CODEOPS_GITHUB_SESSION_STEERING_TOKEN_FILE",
          ),
        },
      ])
    : await loadGitHubWebhookRegistryFile(repositoryRegistryFile);
const steerGitHubSession = createGitHubSessionSteeringClient({
  origin: githubSessionSteeringOrigin,
  resolveToken: (repository) =>
    githubWebhookRegistry.resolve(repository).steeringToken,
});
if (
  planeRegistry.repositories.toSorted().join("\n") !==
  githubWebhookRegistry.repositories.toSorted().join("\n")
) {
  throw new Error(
    "GitHub and Plane repository registries must admit the same identities",
  );
}
const steerPlaneSessions = new Map(
  githubWebhookRegistry.repositories.map((repository) => [
    repository,
    createPlaneSessionSteeringClient({
      origin: githubSessionSteeringOrigin,
      repository,
      token: githubWebhookRegistry.resolve(repository).steeringToken,
    }),
  ]),
);
const controllerCredentials = new Set<string>();
for (const repository of githubWebhookRegistry.repositories) {
  const github = githubWebhookRegistry.resolve(repository);
  const plane = planeRegistry.resolve(repository);
  for (const credential of [
    github.webhookSecret,
    github.steeringToken,
    plane.apiKey,
    plane.webhookSecret,
  ]) {
    if (controllerCredentials.has(credential)) {
      throw new Error(
        "controller credentials must be unique across repositories and authorities",
      );
    }
    controllerCredentials.add(credential);
  }
}
const repositoryHeadOrigin = required("CODEOPS_REPOSITORY_HEAD_ORIGIN");
const githubRuntimes = new Map(
  githubWebhookRegistry.repositories.map((repository) => [
    repository,
    {
      loadReviewComments: createGitHubReviewCommentsLoader({
        origin: repositoryHeadOrigin,
        token: repositoryHeadToken,
        repository,
      }),
      qualifyHead: createGitHubHeadQualifier({
        origin: repositoryHeadOrigin,
        token: repositoryHeadToken,
        repository,
      }),
      loadStack: createGitHubStackLoader({
        origin: repositoryHeadOrigin,
        token: repositoryHeadToken,
        repository,
      }),
      resolveBaseSha: createRepositoryHeadResolver({
        origin: repositoryHeadOrigin,
        token: repositoryHeadToken,
        repository,
      }),
    },
  ]),
);

function githubRuntimeForRepository(repository: string) {
  const runtime = githubRuntimes.get(repository);
  if (runtime === undefined) {
    throw new Error("repository is not admitted by the GitHub runtime");
  }
  return runtime;
}
const resolveCurrentPullRequest = createGitHubCurrentPullRequestResolver({
  origin: repositoryHeadOrigin,
  token: repositoryHeadToken,
});
const controlPlaneSha = required("CODEOPS_CONTROL_PLANE_SHA");
if (!/^[0-9a-f]{40}$/.test(controlPlaneSha)) {
  throw new Error(
    "CODEOPS_CONTROL_PLANE_SHA must be an exact lowercase Git SHA",
  );
}
const dedupRoot = required("CODEOPS_DEDUP_ROOT");
const ledger = createFileResearchDedupLedger({
  rootDirectory: dedupRoot,
  leaseDurationMs: 5 * 60 * 1_000,
});
const packetStore = createFileResearchPacketStore({
  rootDirectory: `${dedupRoot}/research-packets`,
});
const codingRequestStore = createFileCodingRequestStore({
  rootDirectory: `${dedupRoot}/coding-requests`,
});
const pullRequestBindings = createFilePullRequestBindingStore({
  rootDirectory: `${dedupRoot}/pull-request-bindings`,
});
const workflowBindings = createFileWorkflowBindingStore({
  rootDirectory: `${dedupRoot}/workflow-bindings`,
});
const cancelCoding = createTemporalCodingCanceller({ client: temporalClient });
const enqueue = createTemporalResearchEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});
const enqueueCoding = createTemporalCodingEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const lifecycleSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    project: z.string().uuid(),
    state: z.union([
      z.string().uuid(),
      z.object({ id: z.string().uuid() }).passthrough(),
    ]),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
const blockerRelationsSchema = z
  .object({
    blocked_by: z
      .array(
        z
          .object({
            project_id: z.string().uuid(),
            issue_id: z.string().uuid(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

async function transitionWorkItem(input: {
  projectId: string;
  workItemId: string;
  expectedStateId: string;
  targetStateId: string;
}): Promise<void> {
  const { client: planeClient, lifecycle } = planeRuntimeForProject(
    input.projectId,
  );
  const snapshot = lifecycleSnapshotSchema.parse(
    await planeClient.getWorkItemSnapshot(input.projectId, input.workItemId),
  );
  const actualState =
    typeof snapshot.state === "string" ? snapshot.state : snapshot.state.id;
  if (actualState === input.targetStateId) return;
  if (actualState !== input.expectedStateId) {
    throw new Error(
      "GitHub lifecycle event observed an unexpected Plane state",
    );
  }
  await lifecycle.transition({
    projectId: input.projectId,
    workItemId: input.workItemId,
    expectedStateId: actualState,
    expectedUpdatedAt: snapshot.updated_at,
    targetStateId: input.targetStateId,
  });
}

async function transitionWorkItemFrom(input: {
  projectId: string;
  workItemId: string;
  expectedStateIds: readonly string[];
  targetStateId: string;
}): Promise<void> {
  const { client: planeClient, lifecycle } = planeRuntimeForProject(
    input.projectId,
  );
  const snapshot = lifecycleSnapshotSchema.parse(
    await planeClient.getWorkItemSnapshot(input.projectId, input.workItemId),
  );
  const actualState =
    typeof snapshot.state === "string" ? snapshot.state : snapshot.state.id;
  if (actualState === input.targetStateId) return;
  if (!input.expectedStateIds.includes(actualState)) {
    throw new Error(
      "GitHub lifecycle event observed an unexpected Plane state",
    );
  }
  await lifecycle.transition({
    projectId: input.projectId,
    workItemId: input.workItemId,
    expectedStateId: actualState,
    expectedUpdatedAt: snapshot.updated_at,
    targetStateId: input.targetStateId,
  });
}

async function cancelDescendantWork(input: {
  projectId: string;
  blockerId: string;
  reason: string;
}): Promise<void> {
  const { client: planeClient } = planeRuntimeForProject(input.projectId);
  const items = z
    .array(z.object({ id: z.string().uuid() }).passthrough())
    .max(200)
    .parse(await planeClient.listProjectWorkItemSnapshots(input.projectId));
  const descendants = new Map<string, Set<string>>();
  for (const item of items) {
    const relations = blockerRelationsSchema.parse(
      await planeClient.getWorkItemRelations(input.projectId, item.id),
    );
    for (const blocker of relations.blocked_by) {
      if (blocker.project_id !== input.projectId) continue;
      const children = descendants.get(blocker.issue_id) ?? new Set<string>();
      children.add(item.id);
      descendants.set(blocker.issue_id, children);
    }
  }
  const pending = [...(descendants.get(input.blockerId) ?? [])].sort();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const workItemId = pending.shift()!;
    if (visited.has(workItemId)) continue;
    visited.add(workItemId);
    const workflow = await workflowBindings.getByWorkItem(workItemId);
    if (workflow?.status === "active") {
      await cancelCoding({
        workflowId: workflow.workflowId,
        reason: input.reason,
      });
    }
    pending.push(...[...(descendants.get(workItemId) ?? [])].sort());
  }
}

const listener = createPlaneWebhookRequestListener({
  adoption: {
    token: existingPullRequestAdoptionToken,
    process: async (request) => {
      const parsed = z
        .object({
          codingRequest: z
            .object({
              projectId: z.string().uuid(),
              workItem: z
                .object({
                  repository: z
                    .object({ owner: z.string(), name: z.string() })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(request);
      const authority = planeRegistry.resolveProject(
        parsed.codingRequest.projectId,
      );
      if (
        `${parsed.codingRequest.workItem.repository.owner}/${parsed.codingRequest.workItem.repository.name}` !==
        authority.repository
      ) {
        throw new Error("existing PR adoption project repository mismatch");
      }
      return adoptExistingPullRequest({
        request,
        resolveCurrent: resolveCurrentPullRequest,
        codingRequests: codingRequestStore,
        pullRequestBindings,
        workflowBindings,
        begin: ({ projectId, workItemId }) =>
          transitionWorkItemFrom({
            projectId,
            workItemId,
            expectedStateIds: [
              authority.stateIds.ready,
              authority.stateIds.inProgress,
              authority.stateIds.needsAttention,
            ],
            targetStateId: authority.stateIds.inProgress,
          }),
        enqueue: enqueueCoding,
      });
    },
  },
  workItems: {
    token: workItemMutationToken,
    create: (request) => {
      const parsed = workItemProviderCreateRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return createPlaneWorkItem({
        request: parsed,
        projectId: authority.projectId,
        client,
      });
    },
    get: (request) => {
      const parsed = workItemProviderGetRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return getPlaneWorkItem({ request: parsed, projectId: authority.projectId, client });
    },
    search: (request) => {
      const parsed = workItemProviderSearchRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return searchPlaneWorkItems({ request: parsed, projectId: authority.projectId, client });
    },
    comment: (request) => {
      const parsed = workItemProviderCommentRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return commentOnPlaneWorkItem({ request: parsed, projectId: authority.projectId, client });
    },
    update: (request) => {
      const parsed = workItemProviderUpdateRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return updatePlaneWorkItem({ request: parsed, projectId: authority.projectId, client });
    },
    relate: (request) => {
      const parsed = workItemProviderRelateRequestSchema.parse(request);
      const { client, authority } = planeRuntimeForRepository(parsed.repository);
      return relatePlaneWorkItems({ request: parsed, projectId: authority.projectId, client });
    },
  },
  projection: {
    token: projectionToken,
    process: (packet) => {
      const projectId = z
        .object({ projectId: z.string().uuid() })
        .passthrough()
        .parse(packet).projectId;
      const { client } = planeRuntimeForProject(projectId);
      return projectResearchPacket({
        packet,
        ledger,
        packetStore,
        client,
      });
    },
  },
  transitionProjection: {
    token: projectionToken,
    process: async (notice) => {
      const { client: planeClient, authority } = planeRuntimeForProject(
        notice.projectId,
      );
      const noticeRepository = `${notice.repository.owner}/${notice.repository.name}`;
      requireRepositoryProject(
        noticeRepository,
        notice.projectId,
        notice.workspaceId,
      );
      const { ready, inProgress, needsAttention } = authority.stateIds;
      const workflowBinding = await workflowBindings.getByWorkItem(
        notice.workItemId,
      );
      if (
        workflowBinding !== null &&
        (workflowBinding.repository !== noticeRepository ||
          workflowBinding.projectId !== notice.projectId ||
          workflowBinding.workspaceId !== notice.workspaceId)
      ) {
        throw new Error("workflow transition repository identity mismatch");
      }
      if (
        workflowBinding !== null &&
        workflowBinding.workflowId === notice.workflowId &&
        workflowBinding.status === "active"
      ) {
        const pullRequestBinding = await pullRequestBindings.getByWorkItem(
          notice.workItemId,
        );
        if (pullRequestBinding !== null) {
          await transitionWorkItemFrom({
            projectId: notice.projectId,
            workItemId: notice.workItemId,
            // Older existing-PR adoptions were enqueued before their Plane
            // ticket moved from Ready. Preserve a fail-closed recovery path
            // for those exact active workflow and pull-request bindings.
            expectedStateIds: [ready, inProgress, needsAttention],
            targetStateId: needsAttention,
          });
        }
        await workflowBindings.put({
          ...workflowBinding,
          status: "terminal",
          updatedAt: new Date().toISOString(),
        });
      }
      const label =
        notice.state === "failed"
          ? "failed"
          : notice.state === "cancelled"
            ? "was cancelled"
            : "completed";
      await planeClient.createComment(notice.projectId, notice.workItemId, {
        comment_html: [
          `<p><strong>CodeOps workflow ${label}.</strong></p>`,
          `<p><code>${escapeHtml(notice.workflowId)}</code>: ${escapeHtml(notice.summary)}</p>`,
        ].join(""),
        external_source: "codeops",
        external_id: `workflow-terminal:${notice.workflowId}:${notice.state}`,
      });
    },
  },
  github: {
    resolveSecret: (repository) =>
      githubWebhookRegistry.resolve(repository).webhookSecret,
    process: async ({ event }) => {
      const {
        client: planeClient,
        authority,
        allowedGitHubReviewerIds,
      } = planeRuntimeForRepository(event.repository);
      const {
        loadReviewComments: loadGitHubReviewComments,
        qualifyHead: qualifyGitHubHead,
        loadStack: loadGitHubStack,
      } = githubRuntimeForRepository(event.repository);
      const {
        inProgress: inProgressStateId,
        needsAttention: needsAttentionStateId,
        complete: completeStateId,
      } = authority.stateIds;
      const receivedAt = new Date().toISOString();
      if (event.kind === "pull_request_review") {
        await reconcileGitHubPullRequestReviewEvent({
          event,
          receivedAt,
          allowedReviewerIds: allowedGitHubReviewerIds,
          bindings: pullRequestBindings,
          ledger,
          loadComments: loadGitHubReviewComments,
          loadInitialRequest: (workItemId) =>
            codingRequestStore.getInitialByWorkItem(workItemId),
          enqueueRevision: async ({ request }) => {
            requireRepositoryProject(
              event.repository,
              request.projectId,
              request.workspaceId,
            );
            const enqueueResult = await enqueueCoding({
              workflowId: request.workItem.workflowId,
              request,
            });
            await workflowBindings.put({
              version: "codeops.workflow-binding/v1",
              workspaceId: request.workspaceId,
              projectId: request.projectId,
              workItemId: request.workItem.workItemId,
              repository: event.repository,
              workflowId: request.workItem.workflowId,
              status: "active",
              baseSha: request.workItem.baseSha,
              branch: request.workItem.branch,
              updatedAt: new Date().toISOString(),
            });
            return enqueueResult;
          },
          beginRevision: async ({ binding }) => {
            requireRepositoryProject(
              event.repository,
              binding.projectId,
              binding.workspaceId,
            );
            await transitionWorkItem({
              projectId: binding.projectId,
              workItemId: binding.workItemId,
              expectedStateId: needsAttentionStateId,
              targetStateId: inProgressStateId,
            });
            await cancelDescendantWork({
              projectId: binding.projectId,
              blockerId: binding.workItemId,
              reason:
                "An exact human PR review requested revisions; the prior qualified head is stale.",
            });
          },
          qualify: ({ event: review }) =>
            qualifyGitHubHead({
              pullRequestNumber: review.number,
              headSha: review.reviewedHeadSha,
              baseRef: review.baseRef,
              baseSha: review.baseSha,
            }),
          reevaluateProject: async () => {
            // Review invalidation cancels descendants above. Positive admission
            // remains owned by the dependency scheduler's Ready reconciliation.
          },
        });
        return;
      }
      if (
        event.kind === "issue_comment" ||
        event.kind === "pull_request_review_comment"
      ) {
        if (steerGitHubSession === null) return;
        await reconcileGitHubSessionEvent({
          event,
          receivedAt,
          allowedActorIds: allowedGitHubReviewerIds,
          bindings: pullRequestBindings,
          ledger,
          resolveCurrentPullRequest,
          steer: steerGitHubSession,
        });
        return;
      }
      if (steerGitHubSession !== null) {
        await reconcileGitHubSessionEvent({
          event,
          receivedAt,
          allowedActorIds: allowedGitHubReviewerIds,
          bindings: pullRequestBindings,
          ledger,
          resolveCurrentPullRequest,
          steer: steerGitHubSession,
        });
      }
      await reconcileGitHubPullRequestMergeGroup({
        event,
        receivedAt,
        bindings: pullRequestBindings,
        loadStack: loadGitHubStack,
        completeTicket: async ({ binding }) => {
          requireRepositoryProject(
            event.repository,
            binding.projectId,
            binding.workspaceId,
          );
          await transitionWorkItemFrom({
            projectId: binding.projectId,
            workItemId: binding.workItemId,
            expectedStateIds: [needsAttentionStateId],
            targetStateId: completeStateId,
          });
        },
        requireAttention: async ({ binding }) => {
          requireRepositoryProject(
            event.repository,
            binding.projectId,
            binding.workspaceId,
          );
          await transitionWorkItemFrom({
            projectId: binding.projectId,
            workItemId: binding.workItemId,
            expectedStateIds: [inProgressStateId, needsAttentionStateId],
            targetStateId: needsAttentionStateId,
          });
        },
        reevaluateProject: async () => {
          // Positive dependent admission is performed by the scheduler pass.
        },
      });
    },
  },
  plane: {
    resolveSecret: (candidateRepository) =>
      planeRuntimeForRepository(candidateRepository).authority.webhookSecret,
    process: async ({
      repository: routedRepository,
      rawBody,
      headers,
      webhookSecret,
    }) => {
      const {
        client: planeClient,
        authority,
        allowedHumanActorIds,
        personaUserIds,
        projectContextDocuments,
      } = planeRuntimeForRepository(routedRepository);
      const { resolveBaseSha: resolveTargetBaseSha } =
        githubRuntimeForRepository(routedRepository);
      const { ready: readyStateId, inProgress: inProgressStateId } =
        authority.stateIds;
      const routedRepositoryParts = routedRepository.split("/");
      const repository = {
        owner: routedRepositoryParts[0]!,
        name: routedRepositoryParts[1]!,
      };
      const readyIdentity = identifyPlaneReadyTransition({
        rawBody,
        headers,
        webhookSecret,
        allowedHumanActorIds,
        readyStateId,
      });
      if (readyIdentity !== null) {
        requireRepositoryProject(
          routedRepository,
          readyIdentity.projectId,
          readyIdentity.workspaceId,
        );
      }
      let readyWorkflowEnqueued = false;
      try {
        const baseSha = await resolveTargetBaseSha();
        const shared = {
          rawBody,
          headers,
          webhookSecret,
          allowedHumanActorIds,
          aiPersonaUserIds: new Set(personaUserIds.keys()),
          planeAuthority: {
            apiOrigin: authority.apiOrigin,
            workspaceSlug: authority.workspaceSlug,
            workspaceId: authority.workspaceId,
            projectId: authority.projectId,
          },
          repository,
          controlPlaneSha,
          baseSha,
          receivedAt: new Date().toISOString(),
          projectContextDocuments,
          classifyCommentRequest,
          loadResearchPacket: (identity: {
            projectId: string;
            workItemId: string;
          }) => packetStore.getLatest(identity),
          loadSource: async ({
            workspaceId,
            projectId,
            workItemId,
          }: {
            workspaceId: string;
            projectId: string | undefined;
            workItemId: string;
          }) => {
            if (projectId === undefined) {
              throw new Error("Plane event omitted project identity");
            }
            requireRepositoryProject(
              routedRepository,
              projectId,
              workspaceId,
            );
            return {
              project: await planeClient.getProjectSnapshot(projectId),
              workItem: await planeClient.getWorkItemSnapshot(
                projectId,
                workItemId,
              ),
              comments: await planeClient.getWorkItemComments(
                projectId,
                workItemId,
              ),
              relations: await planeClient.getWorkItemRelations(
                projectId,
                workItemId,
              ),
              projectWorkItems:
                await planeClient.listProjectWorkItemSnapshots(projectId),
            };
          },
          ledger,
        };
        const ready = await processPlaneReadyWebhook({
          ...shared,
          readyStateId,
          enqueue: enqueueCoding,
          publishAccepted: async ({ request, enqueueResult }) => {
            readyWorkflowEnqueued = true;
            await codingRequestStore.put(request);
            await workflowBindings.put({
              version: "codeops.workflow-binding/v1",
              workspaceId: request.workspaceId,
              projectId: request.projectId,
              workItemId: request.workItem.workItemId,
              repository: routedRepository,
              workflowId: request.workItem.workflowId,
              status: "active",
              baseSha: request.workItem.baseSha,
              branch: request.workItem.branch,
              updatedAt: new Date().toISOString(),
            });
            await transitionWorkItem({
              projectId: request.projectId,
              workItemId: request.workItem.workItemId,
              expectedStateId: readyStateId,
              targetStateId: inProgressStateId,
            });
            try {
              await planeClient.createComment(
                request.projectId,
                request.workItem.workItemId,
                {
                  comment_html: [
                    "<p><strong>CodeOps admitted this Ready transition.</strong></p>",
                    `<p>Workflow <code>${request.requestId}</code> is ${enqueueResult === "enqueued" ? "queued" : "already queued"} against exact main commit <code>${request.workItem.baseSha}</code>.</p>`,
                    `<p>Research disposition: <code>${request.researchDisposition.mode}</code>. Planning and execution are authorized by the human Ready transition; merge and production remain separately gated.</p>`,
                  ].join(""),
                  external_source: "codeops",
                  external_id: `ready-admitted:${request.requestId}`,
                },
              );
            } catch (error) {
              console.error(
                "Plane Ready acknowledgement comment failed after lifecycle commit:",
                error instanceof Error ? error.message : "unknown error",
              );
            }
          },
        });
        if (ready.status !== "ignored") return ready;
        const session = await processPlaneSessionWebhook({
          ...shared,
          personaUserIds,
          enqueue: steerPlaneSessions.get(routedRepository)!,
        });
        if (session.status !== "ignored") return session;
        return processPlaneResearchWebhook({
          ...shared,
          personaUserIds,
          enqueue,
        });
      } catch (error) {
        console.error(
          "Plane webhook processing failed:",
          error instanceof Error ? error.message : "unknown error",
        );
        if (readyIdentity !== null && !readyWorkflowEnqueued) {
          try {
            await planeClient.createComment(
              readyIdentity.projectId,
              readyIdentity.workItemId,
              {
                comment_html: [
                  "<p><strong>CodeOps could not start this Ready transition.</strong></p>",
                  "<p>The admission attempt failed closed before a workflow acknowledgement. It remains retryable; no merge or deployment was authorized.</p>",
                ].join(""),
                external_source: "codeops",
                external_id: `ready-admission-failed:${readyIdentity.eventId}`,
              },
            );
          } catch {
            // Preserve the original admission failure for Plane's webhook retry.
          }
        }
        throw error;
      }
    },
  },
});

const port = Number(process.env.CODEOPS_HTTP_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_HTTP_PORT must be a valid TCP port");
}
const server = createServer((request, response) => {
  void listener(request, response);
});
server.listen(port, process.env.CODEOPS_HTTP_HOST ?? "0.0.0.0");

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await temporalConnection.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
