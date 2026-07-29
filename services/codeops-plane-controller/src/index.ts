import { createHash } from "node:crypto";
import {
  canonicalSerialize,
  codingRequestSchema,
  contractVersions,
  createResearchRequestFromPlaneComment,
  type ProjectContextDocument,
  parseResearchPersonaRound,
  type CodingRequest,
  type ResearchRequest,
  verifyPlaneWebhookSignature,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";
import { compileProjectContext } from "./project-context.js";

export {
  applyResearchMutationBatch,
  type MutationResult,
  type PlaneContentClient,
  type PlaneWorkItemContentPatch,
  type PlaneWorkItemRecord,
} from "./mutations.js";
export {
  createPlaneApiClient,
  type PlaneApiClient,
  type PlaneApiClientConfig,
} from "./plane-api.js";
export {
  createFileResearchDedupLedger,
  type DedupClaim,
  type FileResearchDedupLedgerConfig,
  type ResearchDedupLedger,
} from "./dedup-ledger.js";
export {
  createFileResearchPacketStore,
  type ResearchPacketStore,
} from "./research-packet-store.js";
export {
  compileProjectContext,
  loadProjectContextDocuments,
  projectContextDocumentPaths,
} from "./project-context.js";
export {
  projectResearchPacket,
  type ResearchProjectionResult,
} from "./projection.js";
export {
  createPlaneWebhookRequestListener,
  createRepositoryHeadResolver,
  createTemporalCodingEnqueuer,
  createTemporalResearchEnqueuer,
} from "./runtime.js";

const uuid = z.string().uuid();
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);

const planeV2CommentWebhookSchema = z
  .object({
    version: z.literal("v2"),
    delivery_id: uuid,
    event_id: uuid,
    entity_id: uuid,
    entity_type: z.literal("issue"),
    event: z.literal("workitem.comment.created"),
    webhook_id: uuid,
    workspace_id: uuid,
    data: z
      .object({
        id: uuid,
        project_id: uuid.optional(),
        comment: z
          .object({
            id: uuid,
            actor_id: uuid,
            issue_id: uuid,
            comment_stripped: z.string().max(8_000),
          })
          .passthrough(),
      })
      .passthrough(),
    previous_attributes: z.record(z.unknown()),
  })
  .strict();

const planeCeCommentWebhookSchema = z
  .object({
    event: z.literal("issue_comment"),
    action: z.literal("created"),
    webhook_id: uuid,
    workspace_id: uuid,
    data: z
      .object({
        id: uuid,
        comment_html: z.string().max(50_000),
        edited_at: z.null(),
        created_by: uuid,
        project: uuid,
        workspace: uuid,
        issue: uuid,
        actor: uuid,
      })
      .passthrough(),
    activity: z.record(z.unknown()).optional(),
  })
  .strict();

const planeCeIssueWebhookSchema = z
  .object({
    event: z.literal("issue"),
    action: z.literal("updated"),
    webhook_id: uuid,
    workspace_id: uuid,
    data: z
      .object({
        id: uuid,
        project: uuid,
        workspace: uuid,
        state: z
          .object({
            id: uuid,
          })
          .passthrough(),
        updated_at: z.string().datetime({ offset: true }),
      })
      .passthrough(),
    activity: z
      .object({
        field: z.literal("state_id"),
        old_value: uuid,
        new_value: uuid,
        actor: z
          .object({
            id: uuid,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict();

const workItemSnapshotSchema = z
  .object({
    id: uuid,
    project: uuid,
    workspace: uuid,
    name: z.string(),
    description_html: z.string().max(100_000).nullable().optional(),
    description_stripped: z.string().max(50_000).nullable().optional(),
    priority: z.string(),
    state: uuid,
    labels: z.array(uuid),
    assignees: z.array(uuid),
    module: uuid.nullable().optional(),
    parent: uuid.nullable().optional(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

const projectSnapshotSchema = z
  .object({
    id: uuid,
    workspace: uuid,
    name: z.string(),
    description_html: z.string().nullable().optional(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

const workItemCommentSnapshotSchema = z
  .object({
    id: uuid,
    comment_html: z.string().max(50_000),
    created_by: uuid,
    created_at: z.string().datetime({ offset: true }),
    external_source: z.string().nullable().optional(),
  })
  .passthrough();

const relationKinds = [
  "blocking",
  "blocked_by",
  "duplicate",
  "relates_to",
  "start_after",
  "start_before",
  "finish_after",
  "finish_before",
] as const;
const relationEntriesSchema = z.array(
  z
    .object({
      project_id: uuid,
      issue_id: uuid,
    })
    .passthrough(),
);
const workItemRelationsSnapshotSchema = z
  .object({
    blocking: relationEntriesSchema,
    blocked_by: relationEntriesSchema,
    duplicate: relationEntriesSchema,
    relates_to: relationEntriesSchema,
    start_after: relationEntriesSchema,
    start_before: relationEntriesSchema,
    finish_after: relationEntriesSchema,
    finish_before: relationEntriesSchema,
  })
  .passthrough();

export type PlaneWebhookHeaders = Readonly<{
  delivery: string;
  event: string;
  signature: string;
}>;

export type PlaneSourceSnapshot = Readonly<{
  workItem: unknown;
  project: unknown;
  comments?: unknown;
  relations?: unknown;
  projectWorkItems?: unknown;
}>;

export type ResearchAdmission = Readonly<{
  eventId: string;
  request: ResearchRequest;
  planeRevisionDigest: string;
}>;

export type ReadyAdmission = Readonly<{
  eventId: string;
  request: CodingRequest;
  planeRevisionDigest: string;
}>;

export type ResearchRequestEnqueueResult = "enqueued" | "already-enqueued";
export type CodingRequestEnqueueResult = ResearchRequestEnqueueResult;

export type ResearchWebhookProcessingResult =
  | Readonly<{ status: "ignored" }>
  | Readonly<{
      status: "busy";
      scope: "event" | "request";
      leaseExpiresAt: string;
    }>
  | Readonly<{
      status: "enqueued";
      requestId: string;
      duplicate: boolean;
    }>;
export type ReadyWebhookProcessingResult = ResearchWebhookProcessingResult;

type NormalizedPlaneCommentEvent = Readonly<{
  deliveryId: string;
  eventId: string;
  workspaceId: string;
  projectId: string | undefined;
  workItemId: string;
  commentId: string;
  actorId: string;
  comment: string;
}>;

function decodePlaneCommentText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => {
      const codePoint = Number(value);
      return Number.isSafeInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => {
      const codePoint = Number.parseInt(value, 16);
      return Number.isSafeInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function planeHtmlText(value: string): string {
  return decodePlaneCommentText(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function workItemDescription(
  workItem: z.infer<typeof workItemSnapshotSchema>,
): string {
  const stripped = (workItem.description_stripped ?? "").trim();
  if (stripped !== "") return stripped;
  return z
    .string()
    .max(50_000)
    .parse(planeHtmlText(workItem.description_html ?? ""));
}

function planeCeCommentText(
  html: string,
  personaUserIds: ReadonlyMap<string, string>,
): string {
  const withPersonas = html.replace(
    /<mention-component\b([^>]*)>(?:<\/mention-component>)?/gi,
    (_match, attributes: string) => {
      const identifier =
        /\bentity_identifier="([0-9a-f-]+)"/i.exec(attributes)?.[1];
      return identifier === undefined
        ? " "
        : (personaUserIds.get(identifier.toLowerCase()) ?? " ");
    },
  );
  const text = withPersonas
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return z
    .string()
    .max(8_000)
    .parse(
      decodePlaneCommentText(text)
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim(),
    );
}

function normalizePlaneCommentEvent(input: {
  rawPayload: unknown;
  headers: PlaneWebhookHeaders;
  personaUserIds: ReadonlyMap<string, string>;
}): NormalizedPlaneCommentEvent {
  const v2 = planeV2CommentWebhookSchema.safeParse(input.rawPayload);
  if (v2.success) {
    const payload = v2.data;
    if (
      input.headers.delivery !== payload.delivery_id ||
      input.headers.event !== payload.event
    ) {
      throw new Error("Plane webhook headers do not match the signed payload");
    }
    if (
      payload.entity_id !== payload.data.id ||
      payload.entity_id !== payload.data.comment.issue_id
    ) {
      throw new Error("Plane webhook work-item identities do not match");
    }
    return {
      deliveryId: payload.delivery_id,
      eventId: payload.event_id,
      workspaceId: payload.workspace_id,
      projectId: payload.data.project_id,
      workItemId: payload.entity_id,
      commentId: payload.data.comment.id,
      actorId: payload.data.comment.actor_id,
      comment: payload.data.comment.comment_stripped.trim(),
    };
  }

  const payload = planeCeCommentWebhookSchema.parse(input.rawPayload);
  if (
    input.headers.event !== payload.event ||
    payload.data.workspace !== payload.workspace_id ||
    payload.data.actor !== payload.data.created_by
  ) {
    throw new Error("Plane CE webhook headers or identities do not match");
  }
  return {
    deliveryId: uuid.parse(input.headers.delivery),
    // Plane CE retries change X-Plane-Delivery but retain the comment UUID.
    eventId: payload.data.id,
    workspaceId: payload.workspace_id,
    projectId: payload.data.project,
    workItemId: payload.data.issue,
    commentId: payload.data.id,
    actorId: payload.data.actor,
    comment: planeCeCommentText(
      payload.data.comment_html,
      input.personaUserIds,
    ),
  };
}

export async function admitPlaneResearchComment(input: {
  rawBody: Buffer;
  headers: PlaneWebhookHeaders;
  webhookSecret: string;
  allowedHumanActorIds: ReadonlySet<string>;
  personaUserIds?: ReadonlyMap<string, string>;
  repository: { owner: string; name: string };
  controlPlaneSha: string;
  baseSha: string;
  receivedAt: string;
  projectContextDocuments: readonly ProjectContextDocument[];
  loadSource: (input: {
    workspaceId: string;
    projectId: string | undefined;
    workItemId: string;
  }) => Promise<PlaneSourceSnapshot>;
}): Promise<ResearchAdmission | null> {
  if (
    !verifyPlaneWebhookSignature({
      secret: input.webhookSecret,
      rawBody: input.rawBody,
      signature: input.headers.signature,
    })
  ) {
    throw new Error("invalid Plane webhook signature");
  }

  const event = normalizePlaneCommentEvent({
    rawPayload: JSON.parse(input.rawBody.toString("utf8")) as unknown,
    headers: input.headers,
    personaUserIds: input.personaUserIds ?? new Map(),
  });

  if (parseResearchPersonaRound(event.comment) === null) return null;
  if (!input.allowedHumanActorIds.has(event.actorId)) {
    // Controller/persona-authored replies may quote or mention persona handles.
    // Ignoring every non-admitted actor prevents recursive dispatch without
    // weakening the positive human allowlist.
    return null;
  }

  const source = await input.loadSource({
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    workItemId: event.workItemId,
  });
  const workItem = workItemSnapshotSchema.parse(source.workItem);
  const project = projectSnapshotSchema.parse(source.project);
  const comments = z
    .array(workItemCommentSnapshotSchema)
    .parse(source.comments ?? []);
  const relations = workItemRelationsSnapshotSchema.parse(
    source.relations ??
      Object.fromEntries(relationKinds.map((kind) => [kind, []])),
  );
  const projectWorkItems = z
    .array(workItemSnapshotSchema)
    .max(200)
    .parse(source.projectWorkItems ?? []);
  if (
    workItem.id !== event.workItemId ||
    workItem.project !== project.id ||
    workItem.workspace !== event.workspaceId ||
    project.workspace !== event.workspaceId ||
    (event.projectId !== undefined && event.projectId !== project.id)
  ) {
    throw new Error("Plane source snapshot is outside the signed event scope");
  }

  const relevantComments = comments
    .filter((comment) => comment.external_source !== "codeops")
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .slice(-20)
    .map((comment) => ({
      id: comment.id,
      bodyHtml: comment.comment_html.slice(0, 8_000),
      createdBy: comment.created_by,
      createdAt: comment.created_at,
    }));
  const relationSnapshot = relationKinds
    .flatMap((kind) =>
      (relations[kind] as readonly { project_id: string; issue_id: string }[]).map(
        (relation) => ({
          kind,
          projectId: relation.project_id,
          workItemId: relation.issue_id,
        }),
      ),
    )
    .sort((left, right) =>
      `${left.kind}:${left.projectId}:${left.workItemId}`.localeCompare(
        `${right.kind}:${right.projectId}:${right.workItemId}`,
      ),
    );
  const ticketSnapshot = {
    workItemId: workItem.id,
    name: workItem.name,
    descriptionHtml: workItem.description_html ?? "",
    priority: workItem.priority,
    stateId: workItem.state,
    labelIds: [...workItem.labels].sort(),
    assigneeIds: [...workItem.assignees].sort(),
    moduleId: workItem.module ?? null,
    parentId: workItem.parent ?? null,
    updatedAt: workItem.updated_at,
    relevantComments,
    relations: relationSnapshot,
    projectTasks: projectWorkItems
      .filter((item) => item.id !== workItem.id)
      .map((item) => ({
        workItemId: item.id,
        name: item.name,
        descriptionHtml: item.description_html ?? "",
        descriptionDigest: `sha256:${createHash("sha256")
          .update(item.description_html ?? "")
          .digest("hex")}`,
        priority: item.priority,
        stateId: item.state,
        updatedAt: item.updated_at,
      }))
      .sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
  };
  const planeRevisionDigest = `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        project: {
          id: project.id,
          name: project.name,
          descriptionHtml: project.description_html ?? null,
          updatedAt: project.updated_at,
        },
        ticketSnapshot,
        trigger: {
          commentId: event.commentId,
          eventId: event.eventId,
        },
      }),
    )
    .digest("hex")}`;
  const projectContext = compileProjectContext({
    repository: input.repository,
    controlPlaneSha: input.controlPlaneSha,
    baseSha: input.baseSha,
    workspaceId: event.workspaceId,
    project: {
      id: project.id,
      name: project.name,
      descriptionHtml: project.description_html,
      updatedAt: project.updated_at,
    },
    documents: input.projectContextDocuments,
  });

  const request = createResearchRequestFromPlaneComment(
    {
      version: contractVersions.planeCommentEvent,
      deliveryId: event.deliveryId,
      eventId: event.eventId,
      action: "create",
      workspaceId: event.workspaceId,
      projectId: project.id,
      workItemId: workItem.id,
      commentId: event.commentId,
      actor: {
        id: event.actorId,
        kind: "human",
      },
      comment: event.comment,
      occurredAt: z.string().datetime({ offset: true }).parse(input.receivedAt),
    },
    {
      repository: input.repository,
      controlPlaneSha: gitSha.parse(input.controlPlaneSha),
      baseSha: gitSha.parse(input.baseSha),
      planeRevisionDigest,
      projectContext,
      ticketSnapshot,
      defaultBrief: [workItem.name, workItemDescription(workItem)]
        .filter((value) => value.trim().length > 0)
        .join("\n\n")
        .slice(0, 8_000),
    },
  );
  if (request === null) {
    throw new Error("admitted Plane research event did not produce a request");
  }
  return {
    eventId: event.eventId,
    request,
    planeRevisionDigest,
  };
}

export function identifyPlaneReadyTransition(input: {
  rawBody: Buffer;
  headers: PlaneWebhookHeaders;
  webhookSecret: string;
  allowedHumanActorIds: ReadonlySet<string>;
  readyStateId: string;
}):
  | {
      payload: z.infer<typeof planeCeIssueWebhookSchema>;
      eventId: string;
      projectId: string;
      workItemId: string;
    }
  | null {
  if (
    !verifyPlaneWebhookSignature({
      secret: input.webhookSecret,
      rawBody: input.rawBody,
      signature: input.headers.signature,
    })
  ) {
    throw new Error("invalid Plane webhook signature");
  }

  const parsed = planeCeIssueWebhookSchema.safeParse(
    JSON.parse(input.rawBody.toString("utf8")) as unknown,
  );
  if (!parsed.success) return null;
  const payload = parsed.data;
  uuid.parse(input.headers.delivery);
  if (
    input.headers.event !== payload.event ||
    payload.data.workspace !== payload.workspace_id ||
    payload.data.state.id !== payload.activity.new_value
  ) {
    throw new Error("Plane Ready webhook headers or identities do not match");
  }

  const readyStateId = uuid.parse(input.readyStateId);
  if (
    payload.activity.old_value === payload.activity.new_value ||
    payload.activity.new_value !== readyStateId ||
    !input.allowedHumanActorIds.has(payload.activity.actor.id)
  ) {
    return null;
  }
  return {
    payload,
    eventId: `ready-event:${createHash("sha256")
      .update(
        canonicalSerialize({
          workspaceId: payload.workspace_id,
          projectId: payload.data.project,
          workItemId: payload.data.id,
          transition: {
            actorId: payload.activity.actor.id,
            oldStateId: payload.activity.old_value,
            newStateId: payload.activity.new_value,
            updatedAt: payload.data.updated_at,
          },
        }),
      )
      .digest("hex")}`,
    projectId: payload.data.project,
    workItemId: payload.data.id,
  };
}

export async function admitPlaneReadyTransition(input: {
  rawBody: Buffer;
  headers: PlaneWebhookHeaders;
  webhookSecret: string;
  allowedHumanActorIds: ReadonlySet<string>;
  readyStateId: string;
  repository: { owner: string; name: string };
  controlPlaneSha: string;
  baseSha: string;
  receivedAt: string;
  projectContextDocuments: readonly ProjectContextDocument[];
  loadResearchPacket: (input: {
    projectId: string;
    workItemId: string;
  }) => Promise<import("@renoconcierge/codeops-contracts").ResearchPacket | null>;
  loadSource: (input: {
    workspaceId: string;
    projectId: string;
    workItemId: string;
  }) => Promise<PlaneSourceSnapshot>;
}): Promise<ReadyAdmission | null> {
  const identified = identifyPlaneReadyTransition(input);
  if (identified === null) return null;
  const { payload } = identified;
  const readyStateId = uuid.parse(input.readyStateId);

  const source = await input.loadSource({
    workspaceId: payload.workspace_id,
    projectId: payload.data.project,
    workItemId: payload.data.id,
  });
  const workItem = workItemSnapshotSchema.parse(source.workItem);
  const project = projectSnapshotSchema.parse(source.project);
  const comments = z
    .array(workItemCommentSnapshotSchema)
    .parse(source.comments ?? []);
  const relations = workItemRelationsSnapshotSchema.parse(
    source.relations ??
      Object.fromEntries(relationKinds.map((kind) => [kind, []])),
  );
  const projectWorkItems = z
    .array(workItemSnapshotSchema)
    .max(200)
    .parse(source.projectWorkItems ?? []);
  if (
    workItem.id !== payload.data.id ||
    workItem.project !== payload.data.project ||
    workItem.workspace !== payload.workspace_id ||
    project.id !== payload.data.project ||
    project.workspace !== payload.workspace_id ||
    workItem.state !== readyStateId ||
    workItem.updated_at !== payload.data.updated_at
  ) {
    throw new Error("Plane Ready snapshot is outside the signed event scope");
  }

  const repository = {
    owner: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .parse(input.repository.owner),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .parse(input.repository.name),
  };
  const controlPlaneSha = gitSha.parse(input.controlPlaneSha);
  const baseSha = gitSha.parse(input.baseSha);
  const requestedAt = z
    .string()
    .datetime({ offset: true })
    .parse(input.receivedAt);
  const transition = {
    actorId: payload.activity.actor.id,
    oldStateId: payload.activity.old_value,
    newStateId: payload.activity.new_value,
    updatedAt: payload.data.updated_at,
  };
  const ticketSnapshot = {
    workItemId: workItem.id,
    name: workItem.name,
    descriptionHtml: workItem.description_html ?? "",
    priority: workItem.priority,
    stateId: workItem.state,
    labelIds: [...workItem.labels].sort(),
    assigneeIds: [...workItem.assignees].sort(),
    moduleId: workItem.module ?? null,
    parentId: workItem.parent ?? null,
    updatedAt: workItem.updated_at,
    relevantComments: comments
      .filter((comment) => comment.external_source !== "codeops")
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(-20)
      .map((comment) => ({
        id: comment.id,
        bodyHtml: comment.comment_html.slice(0, 8_000),
        createdBy: comment.created_by,
        createdAt: comment.created_at,
      })),
    relations: relationKinds
      .flatMap((kind) =>
        (
          relations[kind] as readonly {
            project_id: string;
            issue_id: string;
          }[]
        ).map((relation) => ({
          kind,
          projectId: relation.project_id,
          workItemId: relation.issue_id,
        })),
      )
      .sort((left, right) =>
        `${left.kind}:${left.projectId}:${left.workItemId}`.localeCompare(
          `${right.kind}:${right.projectId}:${right.workItemId}`,
        ),
      ),
    projectTasks: projectWorkItems
      .filter((item) => item.id !== workItem.id)
      .map((item) => ({
        workItemId: item.id,
        name: item.name,
        descriptionHtml: item.description_html ?? "",
        descriptionDigest: `sha256:${createHash("sha256")
          .update(item.description_html ?? "")
          .digest("hex")}`,
        priority: item.priority,
        stateId: item.state,
        updatedAt: item.updated_at,
      }))
      .sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
  };
  const eventId = identified.eventId;
  const planeRevisionDigest = `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        project: {
          id: project.id,
          name: project.name,
          descriptionHtml: project.description_html ?? null,
          updatedAt: project.updated_at,
        },
        ticketSnapshot,
        transition,
      }),
    )
    .digest("hex")}`;
  const projectContext = compileProjectContext({
    repository,
    controlPlaneSha,
    baseSha,
    workspaceId: payload.workspace_id,
    project: {
      id: project.id,
      name: project.name,
      descriptionHtml: project.description_html,
      updatedAt: project.updated_at,
    },
    documents: input.projectContextDocuments,
  });
  const storedResearchPacket = await input.loadResearchPacket({
    projectId: project.id,
    workItemId: workItem.id,
  });
  const researchPacket =
    storedResearchPacket !== null &&
    storedResearchPacket.projectId === project.id &&
    storedResearchPacket.workItemId === workItem.id &&
    storedResearchPacket.baseSha === baseSha &&
    storedResearchPacket.projectContextDigest === projectContext.digest
      ? storedResearchPacket
      : null;
  const researchDisposition =
    researchPacket === null
      ? {
          mode: "skipped" as const,
          rationale:
            storedResearchPacket === null
              ? "The human-authorized Ready ticket has bounded acceptance criteria and no ticket-specific research packet."
              : "The stored research packet does not match the admitted target revision and was not used.",
        }
      : {
          mode: "optional" as const,
          rationale:
            "A ticket-specific immutable research packet is available as additional implementation context.",
        };
  const requestHash = createHash("sha256")
    .update(
      canonicalSerialize({
        eventId,
        planeRevisionDigest,
        repository,
        controlPlaneSha,
        baseSha,
      }),
    )
    .digest("hex");
  const requestId = `coding-${requestHash.slice(0, 57)}`;
  const description = workItemDescription(workItem);
  if (description.length === 0) {
    throw new Error("Ready work item must define acceptance criteria");
  }
  const acceptanceCriteria: string[] = [];
  for (let offset = 0; offset < description.length; offset += 2_000) {
    acceptanceCriteria.push(description.slice(offset, offset + 2_000));
  }

  return {
    eventId,
    request: codingRequestSchema.parse({
      version: contractVersions.codingRequest,
      requestId,
      eventId,
      workspaceId: payload.workspace_id,
      projectId: project.id,
      projectContext,
      requestedBy: payload.activity.actor.id,
      controlPlaneSha,
      planeRevisionDigest,
      ticketSnapshot,
      researchDisposition,
      ...(researchPacket === null ? {} : { researchPacket }),
      workItem: {
        version: contractVersions.workItem,
        workItemId: workItem.id,
        workflowId: requestId,
        runId: requestId,
        repository,
        baseSha,
        branch: `codeops/${workItem.id.slice(0, 8)}-${requestHash.slice(0, 12)}`,
        summary: z.string().min(1).max(500).parse(workItem.name.trim()),
        acceptanceCriteria,
        secretReferences: [],
        requestedAt,
      },
    }),
    planeRevisionDigest,
  };
}

function codingRequestDigest(request: CodingRequest): string {
  const { requestedAt: _requestedAt, ...stableWorkItem } = request.workItem;
  return `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        ...request,
        workItem: stableWorkItem,
      }),
    )
    .digest("hex")}`;
}

function codingEventDigest(request: CodingRequest): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        eventId: request.eventId,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        workItemId: request.workItem.workItemId,
        requestedBy: request.requestedBy,
        planeRevisionDigest: request.planeRevisionDigest,
      }),
    )
    .digest("hex")}`;
}

export async function processPlaneReadyWebhook(
  input: Parameters<typeof admitPlaneReadyTransition>[0] & {
    ledger: import("./dedup-ledger.js").ResearchDedupLedger;
    enqueue: (input: {
      workflowId: string;
      request: CodingRequest;
    }) => Promise<CodingRequestEnqueueResult>;
    publishAccepted?: (input: {
      request: CodingRequest;
      enqueueResult: CodingRequestEnqueueResult;
    }) => Promise<void>;
    now?: () => string;
  },
): Promise<ReadyWebhookProcessingResult> {
  const admission = await admitPlaneReadyTransition(input);
  if (admission === null) return { status: "ignored" };

  const now = input.now ?? (() => new Date().toISOString());
  const eventPayloadDigest = codingEventDigest(admission.request);
  const requestPayloadDigest = codingRequestDigest(admission.request);
  let eventClaim:
    | Extract<import("./dedup-ledger.js").DedupClaim, { status: "acquired" }>
    | undefined;
  let requestClaim:
    | Extract<import("./dedup-ledger.js").DedupClaim, { status: "acquired" }>
    | undefined;

  const claimedEvent = await input.ledger.claim({
    kind: "event",
    stableId: admission.eventId,
    payloadDigest: eventPayloadDigest,
    now: now(),
  });
  if (claimedEvent.status === "busy") {
    return {
      status: "busy",
      scope: "event",
      leaseExpiresAt: claimedEvent.leaseExpiresAt,
    };
  }
  if (claimedEvent.status === "complete") {
    if (claimedEvent.outcome !== "request-enqueued") {
      throw new Error(
        `completed Ready event has unexpected outcome ${claimedEvent.outcome}`,
      );
    }
    return {
      status: "enqueued",
      requestId: claimedEvent.resultId ?? admission.request.requestId,
      duplicate: true,
    };
  }
  eventClaim = claimedEvent;

  try {
    const claimedRequest = await input.ledger.claim({
      kind: "request",
      stableId: admission.request.requestId,
      payloadDigest: requestPayloadDigest,
      now: now(),
    });
    if (claimedRequest.status === "busy") {
      await input.ledger.fail({
        claim: eventClaim,
        failure: "matching coding request is already processing",
        now: now(),
      });
      return {
        status: "busy",
        scope: "request",
        leaseExpiresAt: claimedRequest.leaseExpiresAt,
      };
    }
    if (claimedRequest.status === "complete") {
      if (claimedRequest.outcome !== "request-enqueued") {
        throw new Error(
          `completed coding request has unexpected outcome ${claimedRequest.outcome}`,
        );
      }
      await input.ledger.complete({
        claim: eventClaim,
        outcome: "request-enqueued",
        resultId: admission.request.requestId,
        now: now(),
      });
      return {
        status: "enqueued",
        requestId: admission.request.requestId,
        duplicate: true,
      };
    }
    requestClaim = claimedRequest;

    const enqueueResult = await input.enqueue({
      workflowId: admission.request.workItem.workflowId,
      request: admission.request,
    });
    if (enqueueResult !== "enqueued" && enqueueResult !== "already-enqueued") {
      throw new Error("coding enqueuer returned an invalid outcome");
    }
    await input.publishAccepted?.({
      request: admission.request,
      enqueueResult,
    });
    await input.ledger.complete({
      claim: requestClaim,
      outcome: "request-enqueued",
      resultId: admission.request.requestId,
      now: now(),
    });
    requestClaim = undefined;
    await input.ledger.complete({
      claim: eventClaim,
      outcome: "request-enqueued",
      resultId: admission.request.requestId,
      now: now(),
    });
    eventClaim = undefined;
    return {
      status: "enqueued",
      requestId: admission.request.requestId,
      duplicate: enqueueResult === "already-enqueued",
    };
  } catch (error) {
    if (requestClaim !== undefined) {
      await input.ledger.fail({
        claim: requestClaim,
        failure: "Ready webhook processing failed",
        now: now(),
      });
    }
    if (eventClaim !== undefined) {
      await input.ledger.fail({
        claim: eventClaim,
        failure: "Ready webhook processing failed",
        now: now(),
      });
    }
    throw error;
  }
}

function researchRequestDigest(request: ResearchRequest): string {
  const { requestedAt: _receivedAt, ...stableRequest } = request;
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(stableRequest))
    .digest("hex")}`;
}

function researchEventDigest(request: ResearchRequest): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        projectId: request.projectId,
        workItemId: request.workItemId,
        triggerCommentId: request.triggerCommentId,
        requestedBy: request.requestedBy,
        personas: request.personas,
        brief: request.brief,
      }),
    )
    .digest("hex")}`;
}

export async function processPlaneResearchWebhook(
  input: Parameters<typeof admitPlaneResearchComment>[0] & {
    ledger: import("./dedup-ledger.js").ResearchDedupLedger;
    enqueue: (input: {
      workflowId: string;
      request: ResearchRequest;
    }) => Promise<ResearchRequestEnqueueResult>;
    now?: () => string;
  },
): Promise<ResearchWebhookProcessingResult> {
  const admission = await admitPlaneResearchComment(input);
  if (admission === null) return { status: "ignored" };

  const now = input.now ?? (() => new Date().toISOString());
  const eventPayloadDigest = researchEventDigest(admission.request);
  const requestPayloadDigest = researchRequestDigest(admission.request);
  let eventClaim:
    | Extract<
        import("./dedup-ledger.js").DedupClaim,
        { status: "acquired" }
      >
    | undefined;
  let requestClaim:
    | Extract<
        import("./dedup-ledger.js").DedupClaim,
        { status: "acquired" }
      >
    | undefined;

  const claimedEvent = await input.ledger.claim({
    kind: "event",
    stableId: admission.eventId,
    payloadDigest: eventPayloadDigest,
    now: now(),
  });
  if (claimedEvent.status === "busy") {
    return {
      status: "busy",
      scope: "event",
      leaseExpiresAt: claimedEvent.leaseExpiresAt,
    };
  }
  if (claimedEvent.status === "complete") {
    if (claimedEvent.outcome === "request-enqueued") {
      return {
        status: "enqueued",
        requestId: claimedEvent.resultId ?? admission.request.requestId,
        duplicate: true,
      };
    }
    if (claimedEvent.outcome !== "request-created") {
      throw new Error(
        `completed research event has unexpected outcome ${claimedEvent.outcome}`,
      );
    }
  } else {
    eventClaim = claimedEvent;
  }

  try {
    const claimedRequest = await input.ledger.claim({
      kind: "request",
      stableId: admission.request.requestId,
      payloadDigest: requestPayloadDigest,
      now: now(),
    });
    if (claimedRequest.status === "busy") {
      if (eventClaim !== undefined) {
        await input.ledger.fail({
          claim: eventClaim,
          failure: "matching research request is already processing",
          now: now(),
        });
      }
      return {
        status: "busy",
        scope: "request",
        leaseExpiresAt: claimedRequest.leaseExpiresAt,
      };
    }
    if (claimedRequest.status === "complete") {
      if (claimedRequest.outcome !== "request-enqueued") {
        throw new Error(
          `completed research request has unexpected outcome ${claimedRequest.outcome}`,
        );
      }
      if (eventClaim !== undefined) {
        await input.ledger.complete({
          claim: eventClaim,
          outcome: "request-enqueued",
          resultId: claimedRequest.resultId ?? admission.request.requestId,
          now: now(),
        });
      }
      return {
        status: "enqueued",
        requestId: claimedRequest.resultId ?? admission.request.requestId,
        duplicate: true,
      };
    }
    requestClaim = claimedRequest;

    const enqueueResult = await input.enqueue({
      workflowId: admission.request.requestId,
      request: admission.request,
    });
    if (
      enqueueResult !== "enqueued" &&
      enqueueResult !== "already-enqueued"
    ) {
      throw new Error("research enqueuer returned an invalid outcome");
    }

    await input.ledger.complete({
      claim: requestClaim,
      outcome: "request-enqueued",
      resultId: admission.request.requestId,
      now: now(),
    });
    requestClaim = undefined;
    if (eventClaim !== undefined) {
      await input.ledger.complete({
        claim: eventClaim,
        outcome: "request-enqueued",
        resultId: admission.request.requestId,
        now: now(),
      });
      eventClaim = undefined;
    }
    return {
      status: "enqueued",
      requestId: admission.request.requestId,
      duplicate: enqueueResult === "already-enqueued",
    };
  } catch (error) {
    const failure = "research webhook processing failed";
    if (requestClaim !== undefined) {
      await input.ledger.fail({
        claim: requestClaim,
        failure,
        now: now(),
      });
    }
    if (eventClaim !== undefined) {
      await input.ledger.fail({
        claim: eventClaim,
        failure,
        now: now(),
      });
    }
    throw error;
  }
}
