import { createHash } from "node:crypto";
import {
  canonicalSerialize,
  contractVersions,
  createResearchRequestFromPlaneComment,
  parseResearchPersonaRound,
  type ResearchRequest,
  verifyPlaneWebhookSignature,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";

export {
  applyResearchMutationBatch,
  type MutationResult,
  type PlaneContentClient,
  type PlaneLabelRecord,
  type PlaneProjectContentPatch,
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
  projectResearchPacket,
  type ResearchProjectionResult,
} from "./projection.js";
export {
  createPlaneWebhookRequestListener,
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

const workItemSnapshotSchema = z
  .object({
    id: uuid,
    project: uuid,
    workspace: uuid,
    name: z.string(),
    description_html: z.string().nullable().optional(),
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

export type PlaneWebhookHeaders = Readonly<{
  delivery: string;
  event: string;
  signature: string;
}>;

export type PlaneSourceSnapshot = Readonly<{
  workItem: unknown;
  project: unknown;
}>;

export type ResearchAdmission = Readonly<{
  eventId: string;
  request: ResearchRequest;
  planeRevisionDigest: string;
}>;

export type ResearchRequestEnqueueResult = "enqueued" | "already-enqueued";

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

export async function admitPlaneResearchComment(input: {
  rawBody: Buffer;
  headers: PlaneWebhookHeaders;
  webhookSecret: string;
  allowedHumanActorIds: ReadonlySet<string>;
  repository: { owner: string; name: string };
  baseSha: string;
  receivedAt: string;
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

  const payload = planeV2CommentWebhookSchema.parse(
    JSON.parse(input.rawBody.toString("utf8")) as unknown,
  );
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

  const comment = payload.data.comment.comment_stripped.trim();
  if (parseResearchPersonaRound(comment) === null) return null;
  if (!input.allowedHumanActorIds.has(payload.data.comment.actor_id)) {
    // Controller/persona-authored replies may quote or mention persona handles.
    // Ignoring every non-admitted actor prevents recursive dispatch without
    // weakening the positive human allowlist.
    return null;
  }

  const source = await input.loadSource({
    workspaceId: payload.workspace_id,
    projectId: payload.data.project_id,
    workItemId: payload.entity_id,
  });
  const workItem = workItemSnapshotSchema.parse(source.workItem);
  const project = projectSnapshotSchema.parse(source.project);
  if (
    workItem.id !== payload.entity_id ||
    workItem.project !== project.id ||
    workItem.workspace !== payload.workspace_id ||
    project.workspace !== payload.workspace_id ||
    (payload.data.project_id !== undefined &&
      payload.data.project_id !== project.id)
  ) {
    throw new Error("Plane source snapshot is outside the signed event scope");
  }

  const planeRevisionDigest = `sha256:${createHash("sha256")
    .update(
      canonicalSerialize({
        project: {
          id: project.id,
          name: project.name,
          descriptionHtml: project.description_html ?? null,
          updatedAt: project.updated_at,
        },
        workItem: {
          id: workItem.id,
          name: workItem.name,
          descriptionHtml: workItem.description_html ?? null,
          priority: workItem.priority,
          state: workItem.state,
          labels: [...workItem.labels].sort(),
          assignees: [...workItem.assignees].sort(),
          module: workItem.module ?? null,
          parent: workItem.parent ?? null,
          updatedAt: workItem.updated_at,
        },
        trigger: {
          commentId: payload.data.comment.id,
          eventId: payload.event_id,
        },
      }),
    )
    .digest("hex")}`;

  const request = createResearchRequestFromPlaneComment(
    {
      version: contractVersions.planeCommentEvent,
      deliveryId: payload.delivery_id,
      eventId: payload.event_id,
      action: "create",
      workspaceId: payload.workspace_id,
      projectId: project.id,
      workItemId: workItem.id,
      commentId: payload.data.comment.id,
      actor: {
        id: payload.data.comment.actor_id,
        kind: "human",
      },
      comment,
      occurredAt: z.string().datetime({ offset: true }).parse(input.receivedAt),
    },
    {
      repository: input.repository,
      baseSha: gitSha.parse(input.baseSha),
      planeRevisionDigest,
      defaultBrief: [workItem.name, workItem.description_stripped ?? ""]
        .filter((value) => value.trim().length > 0)
        .join("\n\n")
        .slice(0, 8_000),
    },
  );
  if (request === null) {
    throw new Error("admitted Plane research event did not produce a request");
  }
  return {
    eventId: payload.event_id,
    request,
    planeRevisionDigest,
  };
}

function researchRequestDigest(request: ResearchRequest): string {
  const { requestedAt: _receivedAt, ...stableRequest } = request;
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(stableRequest))
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
  const payloadDigest = researchRequestDigest(admission.request);
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
    payloadDigest,
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
        requestId: admission.request.requestId,
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
      payloadDigest,
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
          now: now(),
        });
      }
      return {
        status: "enqueued",
        requestId: admission.request.requestId,
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
      now: now(),
    });
    requestClaim = undefined;
    if (eventClaim !== undefined) {
      await input.ledger.complete({
        claim: eventClaim,
        outcome: "request-enqueued",
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
