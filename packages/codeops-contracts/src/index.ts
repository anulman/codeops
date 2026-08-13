import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  adversarialReviewSchema,
  candidateCheckpointSchema,
  codingOutcomeSchema,
} from "./adversarial-review.js";
export {
  adversarialReviewSchema,
  candidateCheckpointSchema,
  codingOutcomeSchema,
  type AdversarialReview,
  type CandidateCheckpoint,
  type CodingOutcome,
} from "./adversarial-review.js";
export {
  allowedSessionActionsForState,
  isWorkspaceSessionIdentity,
  SESSION_BROKER_VERSION,
  sessionActionTypeSchema,
  sessionCapabilitySchema,
  sessionCheckpointSchema,
  legacySessionCheckpointSchema,
  sessionWorkspaceCheckpointSchema,
  sessionCommandAcceptedSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionCommandSubmissionSchema,
  sessionContentBlockSchema,
  sessionEventSchema,
  sessionIdentitySchema,
  legacySessionIdentitySchema,
  workspaceSessionIdentitySchema,
  temporalCodeOpsSessionIdentitySchema,
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  sessionLeaseSchema,
  sessionSnapshotSchema,
  sessionStateSchema,
  sessionTimelineUpdateSchema,
  sessionUserActionSchema,
  type SessionActionType,
  type SessionCapability,
  type SessionCheckpoint,
  type LegacySessionCheckpoint,
  type SessionWorkspaceCheckpoint,
  type SessionCommandAccepted,
  type SessionCommand,
  type SessionCommandResult,
  type SessionCommandSubmission,
  type SessionContentBlock,
  type SessionEvent,
  type SessionJobInitializationRequest,
  type SessionJobInitializationResponse,
  type SessionLease,
  type SessionIdentity,
  type LegacySessionIdentity,
  type WorkspaceSessionIdentity,
  type TemporalCodeOpsSessionIdentity,
  type SessionPermissionRequest,
  type SessionSnapshot,
  type SessionState,
  type SessionTimelineUpdate,
  type SessionUserAction,
} from "./session-broker.js";
export {
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeClaimResponseSchema,
  sessionRuntimeCheckpointMaterialSchema,
  legacySessionRuntimeCheckpointMaterialSchema,
  workspaceSessionRuntimeCheckpointMaterialSchema,
  sessionRuntimeCommandSchema,
  sessionRuntimeCommandTypes,
  sessionRuntimeCompletionRequestSchema,
  sessionRuntimeCompletionResponseSchema,
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchClaimSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimeForkMaterialSchema,
  sessionRuntimeLeaseMaterialSchema,
  sessionRuntimePermissionPollSchema,
  sessionRuntimePermissionResultSchema,
  sessionRuntimePermissionSubmissionSchema,
  type SessionRuntimeCommand,
  type SessionRuntimeCompletion,
  type SessionRuntimeDispatch,
  type SessionRuntimeDispatchClaim,
  type SessionRuntimePermissionPoll,
  type SessionRuntimePermissionResult,
  type SessionRuntimePermissionSubmission,
} from "./session-runtime.js";
export {
  workspaceLaunchSessionId,
  workspaceSessionLaunchId,
  workspaceCatalogEntrySchema,
  workspaceCatalogSchema,
  workspaceCheckpointSchema,
  workspaceLaunchRequestSchema,
  workspaceLaunchSchema,
  workspaceManifestSchema,
  workspaceSourceSchema,
  workspaceSourceSelectionSchema,
  type WorkspaceCatalog,
  type WorkspaceCatalogEntry,
  type WorkspaceCheckpoint,
  type WorkspaceLaunch,
  type WorkspaceLaunchRequest,
  type WorkspaceManifest,
  type WorkspaceSource,
  type WorkspaceSourceSelection,
} from "./workspace-launch.js";

const VERSION = {
  workItem: "codeops.work-item/v1",
  lifecycleProfile: "codeops.lifecycle-profile/v1",
  providerLifecycleBinding: "codeops.provider-lifecycle-binding/v1",
  workItemLifecycleEvent: "codeops.work-item-lifecycle-event/v1",
  event: "codeops.workflow-event/v1",
  controlCommand: "codeops.control-command/v1",
  controlResult: "codeops.control-result/v1",
  evidence: "codeops.evidence/v1",
  secretReference: "codeops.secret-reference/v1",
  planeCommentEvent: "codeops.plane-comment-event/v1",
  planeSessionRequest: "codeops.plane-session-request/v1",
  researchRequest: "codeops.research-request/v3",
  researchPersonaReport: "codeops.research-persona-report/v2",
  researchSynthesis: "codeops.research-synthesis/v1",
  researchMatrix: "codeops.route-state-credential-matrix/v1",
  researchPacket: "codeops.research-packet/v3",
  researchMutationBatch: "codeops.research-mutation-batch/v2",
  readinessGate: "codeops.readiness-gate/v1",
  projectContext: "codeops.project-context/v1",
  codingRequest: "codeops.coding-request/v2",
  agentJobDispatch: "codeops.agent-job-dispatch/v1",
  agentJobDispatchResult: "codeops.agent-job-dispatch-result/v1",
  adversarialReview: "codeops.adversarial-review/v1",
  workflowTransitionNotice: "codeops.workflow-transition-notice/v1",
  candidatePublication: "codeops.candidate-publication/v1",
  candidatePublicationResult: "codeops.candidate-publication-result/v1",
  githubPullRequestStackLink: "codeops.github-pull-request-stack-link/v1",
  githubPullRequestStackSnapshot:
    "codeops.github-pull-request-stack-snapshot/v1",
} as const;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const workflowRunIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[a-zA-Z0-9._/-]+$/)
  .refine(
    (value) =>
      value !== "HEAD" &&
      !value.startsWith("-") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock") &&
      value.split("/").every((component) => !component.startsWith(".")),
    "invalid Git branch name",
  );
const repository = z
  .object({
    owner: z.string().min(1).max(100).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();
const isoDateTime = z.string().datetime({ offset: true });
const safeText = (maximum: number) => z.string().min(1).max(maximum);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const repositoryPath = z
  .string()
  .min(1)
  .max(500)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9.$_/-]+$/);

const githubActor = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/),
  })
  .strict();

export const githubReviewCommentSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    body: safeText(20_000),
    path: repositoryPath,
    line: z.number().int().positive().max(10_000_000).nullable(),
    side: z.enum(["LEFT", "RIGHT"]).nullable(),
    createdAt: isoDateTime,
  })
  .strict();

export const humanReviewRequestSchema = z
  .object({
    version: z.literal("codeops.human-review-request/v1"),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pullRequestNumber: z.number().int().positive().max(10_000_000),
    reviewId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reviewedHeadSha: gitSha,
    headRef: branchName,
    baseRef: branchName,
    reviewer: githubActor,
    state: z.enum(["changes_requested", "commented"]),
    submittedAt: isoDateTime,
    summary: z.string().max(65_536),
    comments: z.array(githubReviewCommentSchema).max(100),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.summary.trim().length === 0 &&
      review.comments.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comments"],
        message: "human review request must contain a summary or inline comment",
      });
    }
    const ids = review.comments.map((comment) => comment.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comments"],
        message: "human review comments must be unique",
      });
    }
  });

export const candidatePublicationSchema = z
  .object({
    version: z.literal(VERSION.candidatePublication),
    workspaceId: uuid,
    projectId: uuid,
    workItemId: uuid,
    workflowId: workflowRunIdentifier,
    repository,
    pullRequestNumber: z.number().int().positive().max(10_000_000),
    expectedHeadSha: gitSha,
    headRef: branchName,
    humanReview: humanReviewRequestSchema,
    candidate: candidateCheckpointSchema,
    commitMessage: safeText(500),
  })
  .strict()
  .superRefine((publication, context) => {
    if (
      publication.humanReview.repository !==
        `${publication.repository.owner}/${publication.repository.name}` ||
      publication.humanReview.pullRequestNumber !==
        publication.pullRequestNumber ||
      publication.humanReview.reviewedHeadSha !==
        publication.expectedHeadSha ||
      publication.humanReview.headRef !== publication.headRef ||
      publication.candidate.runId.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["humanReview"],
        message: "candidate publication identity does not match its review",
      });
    }
  });

export const candidatePublicationResultSchema = z
  .object({
    version: z.literal(VERSION.candidatePublicationResult),
    workflowId: workflowRunIdentifier,
    workItemId: uuid,
    pullRequestNumber: z.number().int().positive().max(10_000_000),
    previousHeadSha: gitSha,
    publishedHeadSha: gitSha,
    headRef: branchName,
    patchDigest: sha256Digest,
  })
  .strict()
  .refine(
    (result) => result.previousHeadSha !== result.publishedHeadSha,
    "candidate publication must advance the PR head",
  );

export const githubPullRequestStackPositionSchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    size: z.number().int().min(2).max(100),
    position: z.number().int().positive().max(100),
    base: z
      .object({
        ref: branchName,
        sha: gitSha,
      })
      .strict(),
  })
  .strict()
  .refine(
    (stack) => stack.position <= stack.size,
    "pull-request stack position must not exceed its size",
  );

const githubPullRequestStackEntryIdentitySchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    mergedAt: isoDateTime.nullable(),
    head: z
      .object({
        ref: branchName,
        sha: gitSha,
      })
      .strict(),
    base: z
      .object({
        ref: branchName,
        sha: gitSha,
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.mergedAt !== null && entry.state !== "closed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "a merged stack entry must be closed",
      });
    }
  });

export const githubPullRequestStackSnapshotSchema = z
  .object({
    version: z.literal(VERSION.githubPullRequestStackSnapshot),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    number: z.number().int().positive().max(10_000_000),
    baseRef: branchName,
    open: z.boolean(),
    pullRequests: z
      .array(githubPullRequestStackEntryIdentitySchema)
      .min(2)
      .max(100),
  })
  .strict()
  .superRefine((stack, context) => {
    const numbers = stack.pullRequests.map((entry) => entry.number);
    if (new Set(numbers).size !== numbers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequests"],
        message: "pull-request stack entries must be unique",
      });
    }
    if (stack.pullRequests[0]?.base.ref !== stack.baseRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseRef"],
        message: "pull-request stack base must match its bottom entry",
      });
    }
    for (let index = 1; index < stack.pullRequests.length; index += 1) {
      if (
        stack.pullRequests[index]!.base.ref !==
        stack.pullRequests[index - 1]!.head.ref
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pullRequests", index, "base", "ref"],
          message: "pull-request stack entries must form a linear ref chain",
        });
      }
    }
  });

const exactPullRequestIdentitySchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    headSha: gitSha,
    headRef: branchName,
    baseRef: branchName,
  })
  .strict();

export const githubPullRequestStackLinkSchema = z
  .object({
    version: z.literal(VERSION.githubPullRequestStackLink),
    repository,
    parent: exactPullRequestIdentitySchema,
    child: exactPullRequestIdentitySchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.parent.number === request.child.number ||
      request.parent.headRef !== request.child.baseRef
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["child", "baseRef"],
        message:
          "native stack link must identify a distinct child based on the exact parent head ref",
      });
    }
  });

function hasSafeEvidenceUri(value: string): boolean {
  if (value.length > 2_048) return false;

  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") {
      return url.hostname.length > 0 && !url.search;
    }
    if (url.protocol === "s3:") {
      return url.hostname.length > 0 && url.pathname.length > 1 && !url.search;
    }
    if (url.protocol === "artifact:") {
      return !url.host && url.pathname.startsWith("/") && url.pathname.length > 1 && !url.search;
    }
  } catch {
    return false;
  }

  return false;
}

export const secretReferenceSchema = z
  .object({
    version: z.literal(VERSION.secretReference),
    provider: z.enum(["kubernetes", "github-actions", "external-secrets"]),
    reference: identifier,
    scope: identifier,
  })
  .strict();

export const evidenceReferenceSchema = z
  .object({
    version: z.literal(VERSION.evidence),
    kind: z.enum(["log", "test-report", "patch", "checkpoint", "artifact", "video"]),
    uri: z.string().refine(hasSafeEvidenceUri, "unsafe evidence URI"),
    digest: sha256Digest,
    sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
    mediaType: z.string().min(1).max(128),
  })
  .strict();

export const workItemRequestSchema = z
  .object({
    version: z.literal(VERSION.workItem),
    workItemId: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    repository,
    baseSha: gitSha,
    branch: branchName,
    summary: safeText(500),
    acceptanceCriteria: z.array(safeText(2_000)).min(1).max(50),
    secretReferences: z.array(secretReferenceSchema).max(32).default([]),
    requestedAt: isoDateTime,
  })
  .strict();

export const projectContextDocumentSchema = z
  .object({
    path: repositoryPath,
    purpose: safeText(500),
    digest: sha256Digest,
    content: safeText(100_000),
  })
  .strict()
  .superRefine((document, context) => {
    const digest = `sha256:${createHash("sha256")
      .update(document.content)
      .digest("hex")}`;
    if (document.digest !== digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "project context document digest does not match its content",
      });
    }
  });

const projectContextIdentitySchema = z
  .object({
    version: z.literal(VERSION.projectContext),
    repository,
    controlPlaneSha: gitSha,
    baseSha: gitSha,
    project: z
      .object({
        workspaceId: uuid,
        projectId: uuid,
        name: safeText(255),
        descriptionHtml: z.string().max(50_000),
        updatedAt: isoDateTime,
      })
      .strict(),
    documents: z.array(projectContextDocumentSchema).min(1).max(32),
  })
  .strict();

export function createProjectContextDigest(
  input: z.infer<typeof projectContextIdentitySchema>,
): string {
  const parsed = projectContextIdentitySchema.parse(input);
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(parsed))
    .digest("hex")}`;
}

export const projectContextSchema = projectContextIdentitySchema
  .extend({
    digest: sha256Digest,
  })
  .strict()
  .superRefine((context, refinement) => {
    const paths = context.documents.map((document) => document.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some(
        (value, index) =>
          index > 0 && paths[index - 1]!.localeCompare(value) >= 0,
      )
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documents"],
        message: "project context documents must be unique and path-sorted",
      });
    }
    const { digest: _digest, ...identity } = context;
    if (context.digest !== createProjectContextDigest(identity)) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "project context digest does not match its identity",
      });
    }
  });

export function createProjectContext(
  input: z.infer<typeof projectContextIdentitySchema>,
): ProjectContext {
  const identity = projectContextIdentitySchema.parse({
    ...input,
    documents: [...input.documents].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
  return projectContextSchema.parse({
    ...identity,
    digest: createProjectContextDigest(identity),
  });
}

const requestProjectIdentity = {
  workspaceId: uuid,
  projectId: uuid,
  projectContext: projectContextSchema,
};

function validateRequestProjectContext(
  request: {
    workspaceId: string;
    projectId: string;
    repository: z.infer<typeof repository>;
    controlPlaneSha: string;
    baseSha: string;
    projectContext: ProjectContext;
  },
  context: z.RefinementCtx,
): void {
  if (
    request.workspaceId !== request.projectContext.project.workspaceId ||
    request.projectId !== request.projectContext.project.projectId ||
    canonicalSerialize(request.repository) !==
      canonicalSerialize(request.projectContext.repository) ||
    request.controlPlaneSha !== request.projectContext.controlPlaneSha ||
    request.baseSha !== request.projectContext.baseSha
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectContext"],
      message: "request identity does not match its project context",
    });
  }
}

export const workflowStateSchema = z.enum([
  "requested",
  "started",
  "stage_changed",
  "attention_required",
  "approval_required",
  "evidence_ready",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function canonicalSerialize(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
    .join(",")}}`;
}

function logicalId(namespace: string, parts: Readonly<Record<string, string>>): string {
  const digest = createHash("sha256")
    .update(canonicalSerialize({ namespace, ...parts }))
    .digest("hex");
  return `${namespace}:${digest}`;
}

export function createTransitionId(input: {
  workflowId: string;
  transitionKey: string;
  version?: typeof VERSION.event | typeof VERSION.workItemLifecycleEvent;
}): string {
  return logicalId("transition", {
    version: input.version ?? VERSION.event,
    workflowId: workflowRunIdentifier.parse(input.workflowId),
    transitionKey: identifier.parse(input.transitionKey),
  });
}

export function createEventId(input: {
  workflowId: string;
  transitionId: string;
  version?: typeof VERSION.event | typeof VERSION.workItemLifecycleEvent;
}): string {
  return logicalId("event", {
    version: input.version ?? VERSION.event,
    workflowId: workflowRunIdentifier.parse(input.workflowId),
    transitionId: identifier.parse(input.transitionId),
  });
}

export const lifecyclePhaseSchema = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const lifecycleAttentionSchema = z.enum(["clear", "needed"]);

export const lifecycleCommandSchema = z.enum([
  "register",
  "move_to_backlog",
  "mark_ready",
  "start_work",
  "request_review",
  "approve_review",
  "request_changes",
  "complete",
  "cancel",
  "reopen",
  "request_attention",
  "resolve_attention",
]);

export const lifecycleStateSchema = z
  .object({
    phase: lifecyclePhaseSchema,
    attention: lifecycleAttentionSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.attention === "needed" &&
      (state.phase === "done" || state.phase === "cancelled")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attention"],
        message: "a terminal lifecycle phase cannot need attention",
      });
    }
  });

export const lifecycleProfileSchema = z
  .object({
    version: z.literal(VERSION.lifecycleProfile),
    phases: z.tuple([
      z.literal("backlog"),
      z.literal("ready"),
      z.literal("in_progress"),
      z.literal("in_review"),
      z.literal("done"),
      z.literal("cancelled"),
    ]),
    reviewRequired: z.boolean(),
  })
  .strict();

const providerOpaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:~=\/+\-]{0,255}$/);

export const providerLifecycleStateSchema = z.union([
  lifecyclePhaseSchema,
  z.literal("needs_attention"),
]);

export const providerLifecycleBindingSchema = z
  .object({
    version: z.literal(VERSION.providerLifecycleBinding),
    provider: z.literal("plane"),
    workspaceId: providerOpaqueId,
    projectId: providerOpaqueId,
    states: z
      .array(
        z
          .object({
            providerStateId: providerOpaqueId,
            codeopsState: providerLifecycleStateSchema,
            preferredForProjection: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((binding, context) => {
    const providerStateIds = new Set<string>();
    const preferred = new Map<string, number>();
    const configured = new Set<string>();
    for (const [index, state] of binding.states.entries()) {
      if (providerStateIds.has(state.providerStateId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["states", index, "providerStateId"],
          message: "one provider state must map to exactly one CodeOps state",
        });
      }
      providerStateIds.add(state.providerStateId);
      configured.add(state.codeopsState);
      if (state.preferredForProjection) {
        preferred.set(
          state.codeopsState,
          (preferred.get(state.codeopsState) ?? 0) + 1,
        );
      }
    }
    for (const codeopsState of configured) {
      if ((preferred.get(codeopsState) ?? 0) !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["states"],
          message: `CodeOps state ${codeopsState} requires exactly one preferred provider projection`,
        });
      }
    }
  });

export const workItemLifecycleEventSchema = z
  .object({
    version: z.literal(VERSION.workItemLifecycleEvent),
    eventId: identifier,
    transitionId: identifier,
    transitionKey: identifier,
    command: lifecycleCommandSchema,
    repository,
    provider: z
      .object({
        kind: z.literal("plane"),
        workspaceId: providerOpaqueId,
        projectId: providerOpaqueId,
      })
      .strict(),
    workItemId: providerOpaqueId,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    sequence: z.number().int().positive().max(1_000_000_000),
    previousState: lifecycleStateSchema.nullable(),
    state: lifecycleStateSchema,
    sourceSha: gitSha,
    occurredAt: isoDateTime,
    summary: safeText(1_000),
    evidence: z.array(evidenceReferenceSchema).max(32).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.sequence === 1) !== (event.previousState === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousState"],
        message: "only the first lifecycle event can omit its previous state",
      });
    }
    if (
      event.previousState !== null &&
      canonicalSerialize(event.previousState) === canonicalSerialize(event.state)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "a lifecycle event must change phase or attention",
      });
    }
    const transitionId = createTransitionId(event);
    if (event.transitionId !== transitionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitionId"],
        message: "transitionId does not match the logical lifecycle transition",
      });
    }
    const eventId = createEventId(event);
    if (event.eventId !== eventId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventId"],
        message: "eventId does not match the logical lifecycle event",
      });
    }
    const previous = event.previousState;
    const next = event.state;
    const clear = next.attention === "clear";
    const previousClear = previous?.attention === "clear";
    const legal =
      (event.command === "register" && previous === null && clear) ||
      (event.command === "move_to_backlog" && previous !== null &&
        previous.phase !== "done" && previous.phase !== "cancelled" &&
        next.phase === "backlog" && clear) ||
      (event.command === "mark_ready" && previous?.phase === "backlog" &&
        previousClear && next.phase === "ready" && clear) ||
      (event.command === "start_work" && previous?.phase === "ready" &&
        previousClear && next.phase === "in_progress" && clear) ||
      (event.command === "request_review" && previous?.phase === "in_progress" &&
        previousClear && next.phase === "in_review" && clear) ||
      (event.command === "approve_review" && previous?.phase === "in_review" &&
        previousClear && next.phase === "done" && clear) ||
      (event.command === "request_changes" && previous?.phase === "in_review" &&
        previousClear && next.phase === "in_progress" && clear) ||
      (event.command === "complete" && previous?.phase === "in_progress" &&
        previousClear && next.phase === "done" && clear) ||
      (event.command === "cancel" && previous !== null &&
        previous.phase !== "done" && previous.phase !== "cancelled" &&
        next.phase === "cancelled" && clear) ||
      (event.command === "reopen" &&
        (previous?.phase === "done" || previous?.phase === "cancelled") &&
        next.phase === "backlog" && clear) ||
      (event.command === "request_attention" && previous !== null &&
        previous.attention === "clear" && next.attention === "needed" &&
        next.phase === previous.phase) ||
      (event.command === "resolve_attention" && previous !== null &&
        previous.attention === "needed" && next.attention === "clear" &&
        next.phase === previous.phase);
    if (!legal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "lifecycle command does not authorize this state transition",
      });
    }
  });

export const workflowEventSchema = z
  .object({
    version: z.literal(VERSION.event),
    eventId: identifier,
    transitionId: identifier,
    transitionKey: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    workItemId: identifier,
    state: workflowStateSchema,
    baseSha: gitSha,
    occurredAt: isoDateTime,
    summary: safeText(1_000),
    evidence: z.array(evidenceReferenceSchema).max(32).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    const transitionId = createTransitionId(event);
    if (event.transitionId !== transitionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitionId"],
        message: "transitionId does not match the logical transition",
      });
    }
    const eventId = createEventId(event);
    if (event.eventId !== eventId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventId"],
        message: "eventId does not match the logical event",
      });
    }
  });

const commandBase = {
  commandId: identifier,
  workflowId: workflowRunIdentifier,
  runId: workflowRunIdentifier,
  requestedAt: isoDateTime,
};

export const controlCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("attach"),
      payload: z.object({ fromSequence: z.number().int().nonnegative().max(1_000_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("status"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("follow_up"),
      payload: z.object({ message: safeText(8_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("cancel"),
      payload: z.object({ reason: safeText(1_000) }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(VERSION.controlCommand),
      ...commandBase,
      type: z.literal("permission_response"),
      payload: z
        .object({
          requestId: identifier,
          decision: z.enum(["approve", "deny"]),
          reason: z.string().max(1_000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const controlResultSchema = z
  .object({
    version: z.literal(VERSION.controlResult),
    commandId: identifier,
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
    status: z.enum(["accepted", "applied", "duplicate", "rejected"]),
    message: z.string().max(1_000).optional(),
    recordedAt: isoDateTime,
  })
  .strict();

export const planeCommentEventSchema = z
  .object({
    version: z.literal(VERSION.planeCommentEvent),
    deliveryId: uuid,
    eventId: uuid,
    action: z.enum(["create", "update", "delete"]),
    workspaceId: uuid,
    projectId: uuid,
    workItemId: uuid,
    commentId: uuid,
    actor: z
      .object({
        id: uuid,
        kind: z.enum(["human", "service"]),
      })
      .strict(),
    comment: z.string().max(8_000),
    occurredAt: isoDateTime,
  })
  .strict();

export const researchPersonaHandles = [
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
] as const;

export const researchPersonaHandleSchema = z.enum(researchPersonaHandles);

const researchPersonasSchema = z
  .array(researchPersonaHandleSchema)
  .min(1)
  .max(researchPersonaHandles.length)
  .refine(
    (personas) => new Set(personas).size === personas.length,
    "research persona handles must be unique",
  );

const ticketCommentSnapshotSchema = z
  .object({
    id: uuid,
    bodyHtml: z.string().max(8_000),
    createdBy: uuid,
    createdAt: isoDateTime,
  })
  .strict();

const ticketRelationSnapshotSchema = z
  .object({
    kind: z.enum([
      "blocking",
      "blocked_by",
      "duplicate",
      "relates_to",
      "start_after",
      "start_before",
      "finish_after",
      "finish_before",
    ]),
    projectId: uuid,
    workItemId: uuid,
  })
  .strict();

const projectTaskSnapshotSchema = z
  .object({
    workItemId: uuid,
    name: safeText(500),
    descriptionHtml: z.string().max(50_000),
    descriptionDigest: sha256Digest,
    priority: safeText(64),
    stateId: uuid,
    updatedAt: isoDateTime,
  })
  .strict();

export const ticketSnapshotSchema = z
  .object({
    workItemId: uuid,
    name: safeText(500),
    descriptionHtml: z.string().max(50_000),
    priority: safeText(64),
    stateId: uuid,
    labelIds: z.array(uuid).max(100),
    assigneeIds: z.array(uuid).max(100),
    moduleId: uuid.nullable(),
    parentId: uuid.nullable(),
    updatedAt: isoDateTime,
    relevantComments: z.array(ticketCommentSnapshotSchema).max(20),
    relations: z.array(ticketRelationSnapshotSchema).max(200),
    projectTasks: z.array(projectTaskSnapshotSchema).max(200).default([]),
  })
  .strict();

export const researchRequestSchema = z
  .object({
    version: z.literal(VERSION.researchRequest),
    requestId: identifier,
    ...requestProjectIdentity,
    workItemId: uuid,
    triggerCommentId: uuid,
    requestedBy: uuid,
    repository,
    controlPlaneSha: gitSha,
    baseSha: gitSha,
    planeRevisionDigest: sha256Digest,
    ticketSnapshot: ticketSnapshotSchema,
    personas: researchPersonasSchema,
    brief: safeText(8_000),
    requestedAt: isoDateTime,
  })
  .strict()
  .superRefine((request, context) => {
    validateRequestProjectContext(
      {
        ...request,
        repository: request.repository,
        controlPlaneSha: request.controlPlaneSha,
        baseSha: request.baseSha,
      },
      context,
    );
    if (request.ticketSnapshot.workItemId !== request.workItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketSnapshot", "workItemId"],
        message: "ticket snapshot does not match the research request",
      });
    }
  });

export const planeSessionRequestSchema = z
  .object({
    version: z.literal(VERSION.planeSessionRequest),
    requestId: identifier,
    ...requestProjectIdentity,
    workItemId: uuid,
    triggerCommentId: uuid,
    requestedBy: uuid,
    repository,
    controlPlaneSha: gitSha,
    baseSha: gitSha,
    planeRevisionDigest: sha256Digest,
    ticketSnapshot: ticketSnapshotSchema,
    intent: z.enum(["research", "response", "source_change", "steering"]),
    personas: z.array(researchPersonaHandleSchema).max(7),
    comment: safeText(8_000),
    requestedAt: isoDateTime,
  })
  .strict()
  .superRefine((request, context) => {
    validateRequestProjectContext(
      {
        ...request,
        repository: request.repository,
        controlPlaneSha: request.controlPlaneSha,
        baseSha: request.baseSha,
      },
      context,
    );
    if (request.ticketSnapshot.workItemId !== request.workItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketSnapshot", "workItemId"],
        message: "ticket snapshot does not match the Plane session request",
      });
    }
  });

export const researchCitationSchema = z
  .object({
    id: identifier,
    path: repositoryPath,
    lineStart: z.number().int().positive().max(10_000_000),
    lineEnd: z.number().int().positive().max(10_000_000).optional(),
    testName: safeText(500).optional(),
    claim: safeText(2_000),
  })
  .strict()
  .refine(
    (citation) =>
      citation.lineEnd === undefined || citation.lineEnd >= citation.lineStart,
    "citation line range is invalid",
  );

const researchFindingSchema = z
  .object({
    id: identifier,
    category: z.enum(["matrix-fact", "product-decision", "downstream-defect"]),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    confidence: z.enum(["high", "medium", "low"]),
    currentBehavior: safeText(4_000),
    expectedBehavior: safeText(4_000),
    citationIds: z.array(identifier).min(1).max(8),
  })
  .strict();

export const researchPersonaReportSchema = z
  .object({
    version: z.literal(VERSION.researchPersonaReport),
    requestId: identifier,
    persona: researchPersonaHandleSchema,
    outcome: z.enum(["findings", "no-additional-findings"]),
    summary: safeText(2_000),
    findings: z.array(researchFindingSchema).max(20),
    decisions: z
      .array(
        z
          .object({
            question: safeText(2_000),
            blocking: z.boolean(),
            citationIds: z.array(identifier).max(8).default([]),
          })
          .strict(),
      )
      .max(5),
    citations: z.array(researchCitationSchema).max(40),
  })
  .strict()
  .superRefine((report, context) => {
    const citationIds = new Set(report.citations.map((citation) => citation.id));
    const referenced = [
      ...report.findings.flatMap((finding) => finding.citationIds),
      ...report.decisions.flatMap((decision) => decision.citationIds),
    ];
    if (referenced.some((id) => !citationIds.has(id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message: "research report references an unknown citation",
      });
    }
  });

const researchMatrixRowSchema = z
  .object({
    id: identifier,
    lifecycleState: safeText(500),
    credentialState: safeText(500),
    routeOrRpc: safeText(1_000),
    currentOracle: safeText(2_000),
    expectedOracle: safeText(2_000),
    allowedSideEffects: safeText(2_000),
    status: z.enum(["verified", "gap", "decision-required"]),
    citationIds: z.array(identifier).min(1).max(8),
  })
  .strict();

const researchFollowUpTaskSchema = z
  .object({
    key: identifier,
    area: z.enum(["security", "database", "web", "infrastructure", "product", "other"]),
    targetWorkItemId: uuid.nullable(),
    title: safeText(500),
    objective: safeText(4_000),
    acceptanceCriteria: z.array(safeText(2_000)).min(1).max(10),
    sourceFindingIds: z.array(identifier).min(1).max(8),
    citationIds: z.array(identifier).min(1).max(8),
  })
  .strict();

export const researchSynthesisSchema = z
  .object({
    version: z.literal(VERSION.researchSynthesis),
    requestId: identifier,
    verdict: z.enum(["ready-to-refine", "blocked-on-decisions", "insufficient-evidence"]),
    summary: safeText(2_000),
    topFindings: z.array(researchFindingSchema).max(5),
    decisions: z
      .array(
        z
          .object({
            question: safeText(2_000),
            blocking: z.boolean(),
            citationIds: z.array(identifier).max(8).default([]),
          })
          .strict(),
      )
      .max(3),
    downstreamFindings: z.array(researchFindingSchema).max(20),
    followUpTasks: z.array(researchFollowUpTaskSchema).max(5),
    matrix: z
      .object({
        version: z.literal(VERSION.researchMatrix),
        rows: z.array(researchMatrixRowSchema).min(1).max(50),
      })
      .strict(),
    citations: z.array(researchCitationSchema).max(80),
  })
  .strict()
  .superRefine((synthesis, context) => {
    const citationIds = new Set(synthesis.citations.map((citation) => citation.id));
    const referenced = [
      ...synthesis.topFindings.flatMap((finding) => finding.citationIds),
      ...synthesis.decisions.flatMap((decision) => decision.citationIds),
      ...synthesis.downstreamFindings.flatMap((finding) => finding.citationIds),
      ...synthesis.followUpTasks.flatMap((task) => task.citationIds),
      ...synthesis.matrix.rows.flatMap((row) => row.citationIds),
    ];
    if (referenced.some((id) => !citationIds.has(id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message: "research synthesis references an unknown citation",
      });
    }
    const findingIds = new Set(
      [...synthesis.topFindings, ...synthesis.downstreamFindings].map(
        (finding) => finding.id,
      ),
    );
    if (
      synthesis.followUpTasks.some((task) =>
        task.sourceFindingIds.some((id) => !findingIds.has(id)),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpTasks"],
        message: "follow-up task references an unknown synthesized finding",
      });
    }
    const taskKeys = synthesis.followUpTasks.map((task) => task.key);
    if (new Set(taskKeys).size !== taskKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpTasks"],
        message: "follow-up task keys must be unique",
      });
    }
  });

const agentJobBaseSchema = z
  .object({
    workItemId: identifier,
    workflowId: identifier,
    baseSha: gitSha,
    summary: safeText(500),
  })
  .strict();

export const agentJobDispatchRequestSchema = z
  .discriminatedUnion("role", [
    agentJobBaseSchema
      .extend({
        version: z.literal(VERSION.agentJobDispatch),
        role: z.literal("coding-agent"),
        codingRequest: z.lazy(() => codingRequestSchema),
        codingRound: z.number().int().min(1).max(4).optional(),
        revision: z
          .object({
            candidate: candidateCheckpointSchema,
            review: adversarialReviewSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    agentJobBaseSchema
      .extend({
        version: z.literal(VERSION.agentJobDispatch),
        role: z.literal("critic-agent"),
        codingRequest: z.lazy(() => codingRequestSchema),
        codingRound: z.number().int().min(1).max(4),
        candidate: candidateCheckpointSchema,
      })
      .strict(),
    agentJobBaseSchema
      .extend({
        version: z.literal(VERSION.agentJobDispatch),
        role: z.literal("qa-contract-researcher"),
        researchRequest: researchRequestSchema,
        researchStage: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("persona"),
              persona: researchPersonaHandleSchema,
            })
            .strict(),
          z
            .object({
              kind: z.literal("synthesis"),
              reports: z.array(researchPersonaReportSchema).min(1).max(7),
            })
            .strict(),
        ]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.role === "coding-agent" || value.role === "critic-agent") {
      if (
        value.workItemId !== value.codingRequest.workItem.workItemId ||
        value.workflowId !== value.codingRequest.requestId ||
        value.baseSha !== value.codingRequest.workItem.baseSha
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["codingRequest"],
          message: "coding dispatch identity does not match its request",
        });
      }
      if (value.role === "critic-agent") {
        if (value.candidate.round !== value.codingRound) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["candidate", "round"],
            message: "critic round must match the exact candidate round",
          });
        }
        return;
      }
      if (value.codingRound === undefined) {
        if (value.revision !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["revision"],
            message: "legacy coding dispatch cannot carry revision context",
          });
        }
        return;
      }
      if (value.codingRound === 1 && value.revision !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revision"],
          message: "initial coding round cannot carry revision context",
        });
      }
      if (value.codingRound > 1) {
        if (value.revision === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["revision"],
            message: "later coding rounds require exact critic revision context",
          });
        } else if (
          value.revision.candidate.round !== value.codingRound - 1 ||
          value.revision.review.candidate.round !== value.codingRound - 1 ||
          value.revision.review.workflowId !== value.workflowId ||
          value.revision.review.workItemId !== value.workItemId ||
          value.revision.review.baseSha !== value.baseSha ||
          canonicalSerialize(value.revision.review.candidate) !==
            canonicalSerialize(value.revision.candidate) ||
          value.revision.review.verdict !== "revision-required"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["revision"],
            message: "coding revision must bind the immediately prior rejected candidate",
          });
        }
      }
      return;
    }
    if (value.researchStage.kind === "persona") {
      if (!value.researchRequest.personas.includes(value.researchStage.persona)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["researchStage", "persona"],
          message: "research persona was not requested",
        });
      }
    } else {
      const reported = value.researchStage.reports.map((report) => report.persona);
      if (
        reported.length !== value.researchRequest.personas.length ||
        value.researchRequest.personas.some((persona) => !reported.includes(persona))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["researchStage", "reports"],
          message: "synthesis requires one report for every requested persona",
        });
      }
    }
    if (
      value.workItemId !== value.researchRequest.workItemId ||
      value.workflowId !== value.researchRequest.requestId ||
      value.baseSha !== value.researchRequest.baseSha
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["researchRequest"],
        message: "research dispatch identity does not match its request",
      });
    }
  });

const agentCheckpointUri = z
  .string()
  .regex(/^artifact:\/\/\/agent-runs\/[a-z0-9-]+\/checkpoint\.json$/);

const agentJobDispatchResultBaseSchema = z
  .object({
    version: z.literal(VERSION.agentJobDispatchResult),
    runId: workflowRunIdentifier,
    checkpointUri: agentCheckpointUri,
    checkpointDigest: sha256Digest,
    checkpointSizeBytes: z.number().int().positive().max(25_000_000),
    patchUri: z
      .string()
      .regex(/^artifact:\/\/\/agent-runs\/[a-z0-9-]+\/changes\.patch$/),
    patchDigest: sha256Digest,
    patchSizeBytes: z.number().int().nonnegative().max(2_000_000),
  })
  .strict();

export const agentJobDispatchResultSchema = z.discriminatedUnion("role", [
  agentJobDispatchResultBaseSchema
    .extend({
      role: z.literal("coding-agent"),
      codingOutcome: codingOutcomeSchema.optional(),
    })
    .strict(),
  agentJobDispatchResultBaseSchema
    .extend({
      role: z.literal("critic-agent"),
      criticReview: adversarialReviewSchema,
    })
    .strict(),
  agentJobDispatchResultBaseSchema
    .extend({
      role: z.literal("qa-contract-researcher"),
      researchResult: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("persona"),
            report: researchPersonaReportSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("synthesis"),
            synthesis: researchSynthesisSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]).superRefine((result, context) => {
  const prefix = `artifact:///agent-runs/${result.runId}/`;
  if (
    result.checkpointUri !== `${prefix}checkpoint.json` ||
    result.patchUri !== `${prefix}changes.patch`
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "Agent Job result artifact URIs must match its run ID",
    });
  }
});

const ticketChangesSchema = z
  .object({
    descriptionHtml: safeText(50_000),
  })
  .strict();

const taskUpsertSchema = z
  .object({
    type: z.literal("task.upsert"),
    key: identifier,
    targetWorkItemId: uuid.nullable(),
    expectedDescriptionDigest: sha256Digest.nullable(),
    name: safeText(500),
    descriptionHtml: safeText(50_000),
  })
  .strict();

export const researchPlaneMutationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("comment.create"),
      targetWorkItemId: uuid,
      bodyHtml: safeText(50_000),
      attachments: z.array(evidenceReferenceSchema).max(32).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("ticket.update"),
      targetWorkItemId: uuid,
      changes: ticketChangesSchema,
    })
    .strict(),
  taskUpsertSchema,
]);

export const researchMutationBatchSchema = z
  .object({
    version: z.literal(VERSION.researchMutationBatch),
    requestId: identifier,
    projectId: uuid,
    sourceWorkItemId: uuid,
    mutations: z.array(researchPlaneMutationSchema).min(2).max(7),
  })
  .strict()
  .superRefine((batch, context) => {
    const [first, ...rest] = batch.mutations;
    const last = rest.at(-1);
    if (
      first?.type !== "ticket.update" ||
      first.targetWorkItemId !== batch.sourceWorkItemId ||
      last?.type !== "comment.create" ||
      last.targetWorkItemId !== batch.sourceWorkItemId ||
      rest.slice(0, -1).some((mutation) => mutation.type !== "task.upsert")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutations"],
        message:
          "research mutations must refine the source description, upsert up to five project tasks, then comment on the source",
      });
    }
    for (const [index, mutation] of batch.mutations.entries()) {
      if (
        mutation.type === "task.upsert" &&
        (mutation.targetWorkItemId === null) !==
          (mutation.expectedDescriptionDigest === null)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mutations", index, "expectedDescriptionDigest"],
          message:
            "existing task updates require both a target and its expected description digest",
        });
      }
    }
    const taskKeys = batch.mutations
      .filter((mutation) => mutation.type === "task.upsert")
      .map((mutation) => mutation.key);
    if (new Set(taskKeys).size !== taskKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutations"],
        message: "research task upsert keys must be unique",
      });
    }
  });

export const researchPacketSchema = z
  .object({
    version: z.literal(VERSION.researchPacket),
    personas: researchPersonasSchema,
    perspectives: z
      .array(
        z
          .object({
            persona: researchPersonaHandleSchema,
            outcome: z.enum(["findings", "no-additional-findings"]),
            summary: safeText(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(researchPersonaHandles.length),
    requestId: identifier,
    projectId: uuid,
    workItemId: uuid,
    baseSha: gitSha,
    projectContextDigest: sha256Digest,
    planeRevisionDigest: sha256Digest,
    summary: safeText(2_000),
    synthesis: researchSynthesisSchema,
    currentBehavior: z.array(safeText(4_000)).max(100),
    expectedBehavior: z.array(safeText(4_000)).max(100),
    fixtureManifest: evidenceReferenceSchema.optional(),
    evidence: z.array(evidenceReferenceSchema).max(32),
    videoNotApplicableReason: z.string().min(1).max(1_000).optional(),
    decisions: z
      .array(
        z
          .object({
            question: safeText(2_000),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    proposedMutations: researchMutationBatchSchema,
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((packet, context) => {
    const videos = packet.evidence.filter((item) => item.kind === "video");
    if (videos.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "research packet may include at most one canonical video",
      });
    }
    if (videos.length === 1 && packet.videoNotApplicableReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["videoNotApplicableReason"],
        message: "video rationale is invalid when a canonical video is present",
      });
    }
    if (
      packet.projectId !== packet.proposedMutations.projectId ||
      packet.workItemId !== packet.proposedMutations.sourceWorkItemId ||
      packet.requestId !== packet.proposedMutations.requestId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedMutations"],
        message: "research mutation batch does not match the source request",
      });
    }
    if (packet.synthesis.requestId !== packet.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["synthesis", "requestId"],
        message: "research synthesis does not match the packet request",
      });
    }
    const requested = new Set(packet.personas);
    const reported = new Set(
      packet.perspectives.map((perspective) => perspective.persona),
    );
    if (
      requested.size !== packet.personas.length ||
      reported.size !== packet.perspectives.length ||
      requested.size !== reported.size ||
      [...requested].some((persona) => !reported.has(persona))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perspectives"],
        message:
          "research packet must report one terminal perspective for every requested persona",
      });
    }
  });

export const codingRequestSchema = z
  .object({
    version: z.literal(VERSION.codingRequest),
    requestId: identifier,
    eventId: identifier,
    ...requestProjectIdentity,
    requestedBy: z.union([
      uuid,
      z.string().regex(/^github:[1-9][0-9]{0,15}$/),
    ]),
    controlPlaneSha: gitSha,
    planeRevisionDigest: sha256Digest,
    ticketSnapshot: ticketSnapshotSchema,
    researchDisposition: z
      .object({
        mode: z.enum(["required", "optional", "skipped"]),
        rationale: safeText(2_000),
      })
      .strict(),
    researchPacket: researchPacketSchema.optional(),
    humanReview: humanReviewRequestSchema.optional(),
    workItem: workItemRequestSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.requestId !== request.workItem.workflowId ||
      request.workItem.runId !== request.workItem.workflowId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workItem", "workflowId"],
        message:
          "coding request identity must match its workflow and initial run identity",
      });
    }
    validateRequestProjectContext(
      {
        ...request,
        repository: request.workItem.repository,
        controlPlaneSha: request.controlPlaneSha,
        baseSha: request.workItem.baseSha,
      },
      context,
    );
    if (request.ticketSnapshot.workItemId !== request.workItem.workItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketSnapshot", "workItemId"],
        message: "ticket snapshot does not match the coding request",
      });
    }
    if (
      request.humanReview !== undefined &&
      (request.humanReview.reviewedHeadSha !== request.workItem.baseSha ||
        request.humanReview.headRef !== request.workItem.branch ||
        request.humanReview.repository !==
          `${request.workItem.repository.owner}/${request.workItem.repository.name}`)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["humanReview"],
        message: "human review identity does not match its coding target",
      });
    }
    if (request.researchDisposition.mode === "required" && !request.researchPacket) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["researchPacket"],
        message: "required coding research must include its immutable packet",
      });
    }
    if (request.researchDisposition.mode === "skipped" && request.researchPacket) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["researchPacket"],
        message: "skipped coding research cannot include a packet",
      });
    }
    if (request.researchPacket) {
      if (
        request.researchPacket.projectId !== request.projectId ||
        request.researchPacket.workItemId !== request.workItem.workItemId ||
        request.researchPacket.baseSha !== request.workItem.baseSha ||
        request.researchPacket.projectContextDigest !==
          request.projectContext.digest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["researchPacket"],
          message:
            "coding request research packet does not match its project context or work item",
        });
      }
    }
  });

export const workflowTransitionNoticeSchema = z
  .object({
    version: z.literal(VERSION.workflowTransitionNotice),
    workspaceId: uuid,
    projectId: uuid,
    workItemId: uuid,
    repository,
    workflowId: workflowRunIdentifier,
    state: z.enum(["completed", "failed", "cancelled"]),
    sequence: z.number().int().positive(),
    summary: safeText(1_000),
  })
  .strict();

const readinessIdentity = {
  version: z.literal(VERSION.readinessGate),
  projectId: uuid,
  workItemId: uuid,
  repository,
  baseSha: gitSha,
  planeRevisionDigest: sha256Digest,
  evaluatedAt: isoDateTime,
};

const readinessCriterionSchema = z
  .object({
    id: identifier,
    category: z.enum([
      "intent",
      "source",
      "current-behavior",
      "reproduction",
      "expected-behavior",
      "fixture",
      "oracle",
      "cleanup",
      "provenance",
      "coverage",
      "independence",
      "retention",
      "video",
      "decision",
      "other",
    ]),
    requirement: z.enum(["required", "recommended"]),
    applicability: z.enum(["applicable", "not-applicable"]),
    status: z.enum(["satisfied", "missing", "not-applicable"]),
    rationale: safeText(2_000),
    evidence: z.array(evidenceReferenceSchema).max(8).default([]),
  })
  .strict()
  .superRefine((criterion, context) => {
    const statusIsNotApplicable = criterion.status === "not-applicable";
    const criterionIsNotApplicable = criterion.applicability === "not-applicable";
    if (statusIsNotApplicable !== criterionIsNotApplicable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "criterion status must agree with applicability",
      });
    }
  });

export const readinessGateSchema = z
  .object({
    ...readinessIdentity,
    policy: z.literal("qa-ticket-readiness/v1"),
    profile: z.enum(["research", "implementation", "qualification"]),
    objective: safeText(4_000),
    expectedOutcome: safeText(4_000),
    criteria: z.array(readinessCriterionSchema).min(1).max(100),
    blockingProductDecisions: z.number().int().nonnegative().max(100),
    ready: z.boolean(),
  })
  .strict()
  .superRefine((gate, context) => {
    const criterionIds = new Set<string>();
    for (const [index, criterion] of gate.criteria.entries()) {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criteria", index, "id"],
          message: "readiness criterion ids must be unique",
        });
      }
      criterionIds.add(criterion.id);
    }

    const hasMissingRequiredCriterion = gate.criteria.some(
      (criterion) =>
        criterion.requirement === "required" &&
        criterion.applicability === "applicable" &&
        criterion.status === "missing",
    );
    const computedReady =
      gate.blockingProductDecisions === 0 && !hasMissingRequiredCriterion;
    if (gate.ready !== computedReady) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ready"],
        message:
          "ready must be derived from applicable required criteria and blocking product decisions",
      });
    }
  });

export const qaContractResearcherPolicy = Object.freeze({
  persona: "qa-contract-researcher/v2",
  trigger: "human-authored registered @ai-* persona mention",
  personaHandles: Object.freeze(researchPersonaHandles),
  allowedMutationTypes: Object.freeze([
    "comment.create",
    "ticket.update",
    "task.upsert",
  ]),
  forbiddenMutationTypes: Object.freeze([
    "state.update",
    "label.upsert",
    "label.attach",
    "label.detach",
    "project.update",
    "ticket.create",
    "ticket.cancel-proposal",
    "ticket.cancel",
    "ticket.delete",
    "project.delete",
  ]),
} as const);

function personaMentionPattern(): RegExp {
  return /(^|[\s([{:;,])(@ai-[a-z][a-z0-9-]*)(?=$|[\s)\]}:;,!.?])/g;
}

export function parseResearchPersonaRound(
  comment: string,
): Readonly<{ personas: ResearchPersonaHandle[]; brief: string }> | null {
  const personas: ResearchPersonaHandle[] = [];
  const seen = new Set<ResearchPersonaHandle>();
  const registered = new Set<string>(researchPersonaHandles);
  const matcher = personaMentionPattern();
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(comment)) !== null) {
    const handle = match[2];
    if (
      handle !== undefined &&
      registered.has(handle) &&
      !seen.has(handle as ResearchPersonaHandle)
    ) {
      seen.add(handle as ResearchPersonaHandle);
      personas.push(handle as ResearchPersonaHandle);
    }
  }
  if (personas.length === 0) return null;

  const brief = comment
    .replace(personaMentionPattern(), "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { personas, brief };
}

export function classifyPlaneCommentRequest(
  comment: string,
): Readonly<{
  intent: "research" | "response" | "source_change" | "steering";
  personas: ResearchPersonaHandle[];
}> | null {
  const normalized = z.string().min(1).max(8_000).parse(comment.trim());
  const personaRound = parseResearchPersonaRound(normalized);
  const requestText = (personaRound?.brief ?? normalized).trim();
  const lower = requestText.toLowerCase();
  const explicitlyRequestsWork =
    personaRound !== null ||
    /^(?:please\s+|kindly\s+)?(?:(?:can|could|would|will)\s+you\b|(?:investigate|research|review|fix|update|change|implement|add|remove|explain|answer|respond|continue|resume|pause|stop|cancel|fork)\b)/i.test(
      requestText,
    );
  if (!explicitlyRequestsWork) return null;

  const intent = /\b(?:continue|resume|pause|stop|cancel|fork|steer)\b/.test(lower)
    ? "steering"
    : /\b(?:fix|update|change|implement|add|remove|revise|revision|edit)\b/.test(
          lower,
        )
      ? "source_change"
      : /\?|\b(?:explain|answer|respond|reply)\b/.test(lower)
        ? "response"
        : "research";
  return { intent, personas: personaRound?.personas ?? [] };
}

export function createPlaneSessionRequestId(input: {
  eventId: string;
  commentId: string;
  planeRevisionDigest: string;
  intent: "research" | "response" | "source_change" | "steering";
}): string {
  return logicalId("plane-session-request", {
    version: VERSION.planeSessionRequest,
    eventId: uuid.parse(input.eventId),
    commentId: uuid.parse(input.commentId),
    planeRevisionDigest: sha256Digest.parse(input.planeRevisionDigest),
    intent: input.intent,
  });
}

export function createPlaneSessionRequestFromPlaneComment(
  input: unknown,
  source: {
    repository: z.infer<typeof repository>;
    controlPlaneSha: string;
    baseSha: string;
    planeRevisionDigest: string;
    projectContext: ProjectContext;
    ticketSnapshot: z.infer<typeof ticketSnapshotSchema>;
  },
): PlaneSessionRequest | null {
  const event = planeCommentEventSchema.parse(input);
  const classification = classifyPlaneCommentRequest(event.comment);
  if (
    event.action !== "create" ||
    event.actor.kind !== "human" ||
    classification === null
  ) {
    return null;
  }
  return planeSessionRequestSchema.parse({
    version: VERSION.planeSessionRequest,
    requestId: createPlaneSessionRequestId({
      eventId: event.eventId,
      commentId: event.commentId,
      planeRevisionDigest: source.planeRevisionDigest,
      intent: classification.intent,
    }),
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    workItemId: event.workItemId,
    triggerCommentId: event.commentId,
    requestedBy: event.actor.id,
    repository: source.repository,
    controlPlaneSha: source.controlPlaneSha,
    baseSha: source.baseSha,
    planeRevisionDigest: source.planeRevisionDigest,
    ticketSnapshot: source.ticketSnapshot,
    projectContext: source.projectContext,
    intent: classification.intent,
    personas: classification.personas,
    comment: event.comment,
    requestedAt: event.occurredAt,
  });
}

export function createResearchRequestId(input: {
  eventId: string;
  commentId: string;
  planeRevisionDigest: string;
}): string {
  return logicalId("research-request", {
    version: VERSION.researchRequest,
    eventId: uuid.parse(input.eventId),
    commentId: uuid.parse(input.commentId),
    planeRevisionDigest: sha256Digest.parse(input.planeRevisionDigest),
  });
}

export function createResearchRequestFromPlaneComment(
  input: unknown,
  source: {
    repository: z.infer<typeof repository>;
    controlPlaneSha: string;
    baseSha: string;
    planeRevisionDigest: string;
    projectContext: ProjectContext;
    ticketSnapshot: z.infer<typeof ticketSnapshotSchema>;
    defaultBrief: string;
  },
): ResearchRequest | null {
  const event = planeCommentEventSchema.parse(input);
  const round = parseResearchPersonaRound(event.comment);
  if (
    event.action !== "create" ||
    event.actor.kind !== "human" ||
    round === null
  ) {
    return null;
  }

  return researchRequestSchema.parse({
    version: VERSION.researchRequest,
    requestId: createResearchRequestId({
      eventId: event.eventId,
      commentId: event.commentId,
      planeRevisionDigest: source.planeRevisionDigest,
    }),
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    workItemId: event.workItemId,
    triggerCommentId: event.commentId,
    requestedBy: event.actor.id,
    repository: source.repository,
    controlPlaneSha: source.controlPlaneSha,
    baseSha: source.baseSha,
    planeRevisionDigest: source.planeRevisionDigest,
    ticketSnapshot: source.ticketSnapshot,
    projectContext: source.projectContext,
    personas: round.personas,
    brief: round.brief || source.defaultBrief,
    requestedAt: event.occurredAt,
  });
}

export function verifyPlaneWebhookSignature(input: {
  secret: string;
  rawBody: string | Buffer;
  signature: string;
}): boolean {
  if (input.secret.length === 0 || !/^[0-9a-f]{64}$/i.test(input.signature)) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(input.signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const contractVersions = VERSION;

export type SecretReference = z.infer<typeof secretReferenceSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type WorkItemRequest = z.infer<typeof workItemRequestSchema>;
export type ProjectContextDocument = z.infer<
  typeof projectContextDocumentSchema
>;
export type ProjectContext = z.infer<typeof projectContextSchema>;
export type CodingRequest = z.infer<typeof codingRequestSchema>;
export type HumanReviewRequest = z.infer<typeof humanReviewRequestSchema>;
export type GitHubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export type CandidatePublication = z.infer<typeof candidatePublicationSchema>;
export type CandidatePublicationResult = z.infer<
  typeof candidatePublicationResultSchema
>;
export type GitHubPullRequestStackPosition = z.infer<
  typeof githubPullRequestStackPositionSchema
>;
export type GitHubPullRequestStackSnapshot = z.infer<
  typeof githubPullRequestStackSnapshotSchema
>;
export type GitHubPullRequestStackLink = z.infer<
  typeof githubPullRequestStackLinkSchema
>;
export type WorkflowTransitionNotice = z.infer<
  typeof workflowTransitionNoticeSchema
>;
export type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;
export type LifecycleAttention = z.infer<typeof lifecycleAttentionSchema>;
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type LifecycleProfile = z.infer<typeof lifecycleProfileSchema>;
export type ProviderLifecycleState = z.infer<
  typeof providerLifecycleStateSchema
>;
export type ProviderLifecycleBinding = z.infer<
  typeof providerLifecycleBindingSchema
>;
export type WorkItemLifecycleEvent = z.infer<
  typeof workItemLifecycleEventSchema
>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlResult = z.infer<typeof controlResultSchema>;
export type PlaneCommentEvent = z.infer<typeof planeCommentEventSchema>;
export type PlaneSessionRequest = z.infer<typeof planeSessionRequestSchema>;
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchPersonaReport = z.infer<
  typeof researchPersonaReportSchema
>;
export type ResearchSynthesis = z.infer<typeof researchSynthesisSchema>;
export type ResearchCitation = z.infer<typeof researchCitationSchema>;
export type TicketSnapshot = z.infer<typeof ticketSnapshotSchema>;
export type AgentJobDispatchRequest = z.infer<
  typeof agentJobDispatchRequestSchema
>;
export type AgentJobDispatchResult = z.infer<
  typeof agentJobDispatchResultSchema
>;
export type ResearchPersonaHandle = z.infer<typeof researchPersonaHandleSchema>;
export type ResearchPlaneMutation = z.infer<typeof researchPlaneMutationSchema>;
export type ResearchMutationBatch = z.infer<typeof researchMutationBatchSchema>;
export type ResearchPacket = z.infer<typeof researchPacketSchema>;
export type ReadinessGate = z.infer<typeof readinessGateSchema>;
