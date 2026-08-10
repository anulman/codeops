import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { z } from "zod";
import {
  createFileResearchDedupLedger,
  createFileCodingRequestStore,
  createFilePullRequestBindingStore,
  createFileWorkflowBindingStore,
  createGitHubHeadQualifier,
  createGitHubReviewCommentsLoader,
  createGitHubStackLoader,
  createGitHubSessionSteeringClient,
  createGitHubCurrentPullRequestResolver,
  createPlaneLifecycleClient,
  createTemporalCodingCanceller,
  createFileResearchPacketStore,
  createPlaneApiClient,
  identifyPlaneReadyTransition,
  loadProjectContextDocuments,
  projectResearchPacket,
  processPlaneReadyWebhook,
  processPlaneResearchWebhook,
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

const temporalConnection = await Connection.connect({
  address: required("CODEOPS_TEMPORAL_ADDRESS"),
});
const temporalClient = new Client({
  connection: temporalConnection,
  namespace: process.env.CODEOPS_TEMPORAL_NAMESPACE ?? "codeops",
});
const planeApiKey = await secretFile("CODEOPS_PLANE_API_KEY_FILE");
const planeClient = createPlaneApiClient({
  baseUrl: required("CODEOPS_PLANE_API_ORIGIN"),
  workspaceSlug: required("CODEOPS_PLANE_WORKSPACE_SLUG"),
  apiKey: planeApiKey,
});
const webhookSecret = await secretFile("CODEOPS_PLANE_WEBHOOK_SECRET_FILE");
const projectionToken = await secretFile(
  "CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE",
);
if (projectionToken.length < 32 || projectionToken.length > 4_096) {
  throw new Error("CodeOps research projection token is invalid");
}
const repositoryHeadToken = await secretFile(
  "CODEOPS_REPOSITORY_HEAD_TOKEN_FILE",
);
const githubWebhookSecret = await secretFile(
  "CODEOPS_GITHUB_WEBHOOK_SECRET_FILE",
);
const githubSessionSteeringOrigin = process.env.CODEOPS_GITHUB_SESSION_STEERING_ORIGIN?.trim();
const githubSessionSteeringTokenFile = process.env.CODEOPS_GITHUB_SESSION_STEERING_TOKEN_FILE?.trim();
if ((githubSessionSteeringOrigin === undefined) !== (githubSessionSteeringTokenFile === undefined)) {
  throw new Error(
    "CODEOPS_GITHUB_SESSION_STEERING_ORIGIN and CODEOPS_GITHUB_SESSION_STEERING_TOKEN_FILE must be configured together",
  );
}
const steerGitHubSession =
  githubSessionSteeringOrigin === undefined || githubSessionSteeringTokenFile === undefined
    ? null
    : createGitHubSessionSteeringClient({
        origin: githubSessionSteeringOrigin,
        token: await secretFile("CODEOPS_GITHUB_SESSION_STEERING_TOKEN_FILE"),
      });
const repositoryFullName = `${required("CODEOPS_REPOSITORY_OWNER")}/${required("CODEOPS_REPOSITORY_NAME")}`;
const loadGitHubReviewComments = createGitHubReviewCommentsLoader({
  origin: required("CODEOPS_REPOSITORY_HEAD_ORIGIN"),
  token: repositoryHeadToken,
  repository: repositoryFullName,
});
const qualifyGitHubHead = createGitHubHeadQualifier({
  origin: required("CODEOPS_REPOSITORY_HEAD_ORIGIN"),
  token: repositoryHeadToken,
});
const loadGitHubStack = createGitHubStackLoader({
  origin: required("CODEOPS_REPOSITORY_HEAD_ORIGIN"),
  token: repositoryHeadToken,
});
const resolveCurrentPullRequest = createGitHubCurrentPullRequestResolver({
  origin: required("CODEOPS_REPOSITORY_HEAD_ORIGIN"),
  token: repositoryHeadToken,
});
const allowedGitHubReviewerIds = new Set(
  required("CODEOPS_ALLOWED_GITHUB_REVIEWER_IDS")
    .split(",")
    .map((value) => Number(value.trim())),
);
if (
  allowedGitHubReviewerIds.size === 0 ||
  [...allowedGitHubReviewerIds].some(
    (value) => !Number.isSafeInteger(value) || value <= 0,
  )
) {
  throw new Error("CODEOPS_ALLOWED_GITHUB_REVIEWER_IDS must contain positive integers");
}
const resolveTargetBaseSha = createRepositoryHeadResolver({
  origin: required("CODEOPS_REPOSITORY_HEAD_ORIGIN"),
  token: repositoryHeadToken,
});
const allowedHumanActorIds = new Set(
  required("CODEOPS_ALLOWED_HUMAN_ACTOR_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (
  allowedHumanActorIds.size === 0 ||
  [...allowedHumanActorIds].some(
    (value) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  )
) {
  throw new Error("CODEOPS_ALLOWED_HUMAN_ACTOR_IDS must contain UUIDs");
}
const rawPersonaEntries = required("CODEOPS_PERSONA_USER_IDS")
  .split(",")
  .map((entry) => entry.split("="));
if (rawPersonaEntries.some((entry) => entry.length !== 2)) {
  throw new Error(
    "CODEOPS_PERSONA_USER_IDS must map all seven unique persona UUIDs",
  );
}
const personaEntries = rawPersonaEntries.map(
  (entry) => [entry[0]!, entry[1]!] as const,
);
const personaUserIds = new Map(
  personaEntries.map(([id, handle]) => [id, handle]),
);
const allowedPersonaHandles = new Set([
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
]);
if (
  personaUserIds.size !== 7 ||
  [...personaUserIds].some(
    ([id, handle]) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      ) || !allowedPersonaHandles.has(handle),
  ) ||
  new Set(personaUserIds.values()).size !== allowedPersonaHandles.size
) {
  throw new Error(
    "CODEOPS_PERSONA_USER_IDS must map all seven unique persona UUIDs",
  );
}
const repository = {
  owner: required("CODEOPS_REPOSITORY_OWNER"),
  name: required("CODEOPS_REPOSITORY_NAME"),
};
if (
  !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner) ||
  !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)
) {
  throw new Error("CodeOps repository identity is invalid");
}
const controlPlaneSha = required("CODEOPS_CONTROL_PLANE_SHA");
if (!/^[0-9a-f]{40}$/.test(controlPlaneSha)) {
  throw new Error(
    "CODEOPS_CONTROL_PLANE_SHA must be an exact lowercase Git SHA",
  );
}
const projectContextDocuments = await loadProjectContextDocuments(
  process.env.CODEOPS_PROJECT_CONTEXT_ROOT ?? "/app/project-context",
);
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
const needsAttentionStateId = required("CODEOPS_NEEDS_ATTENTION_STATE_ID");
const inProgressStateId = required("CODEOPS_IN_PROGRESS_STATE_ID");
const completeStateId = required("CODEOPS_COMPLETE_STATE_ID");
const lifecycle = createPlaneLifecycleClient({
  baseUrl: required("CODEOPS_PLANE_API_ORIGIN"),
  workspaceSlug: required("CODEOPS_PLANE_WORKSPACE_SLUG"),
  apiKey: planeApiKey,
  allowedTargetStateIds: [
    needsAttentionStateId,
    inProgressStateId,
    completeStateId,
  ],
});
const enqueue = createTemporalResearchEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});
const enqueueCoding = createTemporalCodingEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});
const readyStateId = required("CODEOPS_READY_STATE_ID");

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
  const snapshot = lifecycleSnapshotSchema.parse(
    await planeClient.getWorkItemSnapshot(input.projectId, input.workItemId),
  );
  const actualState =
    typeof snapshot.state === "string" ? snapshot.state : snapshot.state.id;
  if (actualState === input.targetStateId) return;
  if (actualState !== input.expectedStateId) {
    throw new Error("GitHub lifecycle event observed an unexpected Plane state");
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
  const snapshot = lifecycleSnapshotSchema.parse(
    await planeClient.getWorkItemSnapshot(input.projectId, input.workItemId),
  );
  const actualState =
    typeof snapshot.state === "string" ? snapshot.state : snapshot.state.id;
  if (actualState === input.targetStateId) return;
  if (!input.expectedStateIds.includes(actualState)) {
    throw new Error("GitHub lifecycle event observed an unexpected Plane state");
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
  projection: {
    token: projectionToken,
    process: (packet) =>
      projectResearchPacket({
        packet,
        ledger,
        packetStore,
        client: planeClient,
      }),
  },
  transitionProjection: {
    token: projectionToken,
    process: async (notice) => {
      const workflowBinding = await workflowBindings.getByWorkItem(
        notice.workItemId,
      );
      if (
        workflowBinding !== null &&
        workflowBinding.workflowId === notice.workflowId &&
        workflowBinding.status === "active"
      ) {
        const pullRequestBinding =
          await pullRequestBindings.getByWorkItem(notice.workItemId);
        if (pullRequestBinding !== null) {
          await transitionWorkItemFrom({
            projectId: notice.projectId,
            workItemId: notice.workItemId,
            expectedStateIds: [
              inProgressStateId,
              needsAttentionStateId,
            ],
            targetStateId: needsAttentionStateId,
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
      await planeClient.createComment(
        notice.projectId,
        notice.workItemId,
        {
          comment_html: [
            `<p><strong>CodeOps workflow ${label}.</strong></p>`,
            `<p><code>${escapeHtml(notice.workflowId)}</code>: ${escapeHtml(notice.summary)}</p>`,
          ].join(""),
          external_source: "codeops",
          external_id: `workflow-terminal:${notice.workflowId}:${notice.state}`,
        },
      );
    },
  },
  github: {
    secret: githubWebhookSecret,
    process: async ({ event }) => {
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
            const enqueueResult = await enqueueCoding({
              workflowId: request.workItem.workflowId,
              request,
            });
            await workflowBindings.put({
              version: "codeops.workflow-binding/v1",
              workspaceId: request.workspaceId,
              projectId: request.projectId,
              workItemId: request.workItem.workItemId,
              workflowId: request.workItem.workflowId,
              status: "active",
              baseSha: request.workItem.baseSha,
              branch: request.workItem.branch,
              updatedAt: new Date().toISOString(),
            });
            return enqueueResult;
          },
          beginRevision: async ({ binding }) => {
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
          await transitionWorkItemFrom({
            projectId: binding.projectId,
            workItemId: binding.workItemId,
            expectedStateIds: [needsAttentionStateId],
            targetStateId: completeStateId,
          });
        },
        requireAttention: async ({ binding }) => {
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
  process: async ({ rawBody, headers }) => {
    const readyIdentity = identifyPlaneReadyTransition({
      rawBody,
      headers,
      webhookSecret,
      allowedHumanActorIds,
      readyStateId,
    });
    let readyWorkflowEnqueued = false;
    try {
      const baseSha = await resolveTargetBaseSha();
      const shared = {
        rawBody,
        headers,
        webhookSecret,
        allowedHumanActorIds,
        aiPersonaUserIds: new Set(personaUserIds.keys()),
        repository,
        controlPlaneSha,
        baseSha,
        receivedAt: new Date().toISOString(),
        projectContextDocuments,
        loadResearchPacket: (identity: {
          projectId: string;
          workItemId: string;
        }) => packetStore.getLatest(identity),
        loadSource: async ({
          projectId,
          workItemId,
        }: {
          projectId: string | undefined;
          workItemId: string;
        }) => {
          if (projectId === undefined) {
            throw new Error("Plane event omitted project identity");
          }
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
