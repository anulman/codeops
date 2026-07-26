import { createHash } from "node:crypto";
import {
  canonicalSerialize,
  contractVersions,
  createResearchRequestFromPlaneComment,
  type ResearchRequest,
  verifyPlaneWebhookSignature,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";

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
  request: ResearchRequest;
  planeRevisionDigest: string;
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
  if (comment !== "/research") return null;
  if (!input.allowedHumanActorIds.has(payload.data.comment.actor_id)) {
    throw new Error("Plane webhook actor is not an admitted human researcher");
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
    },
  );
  if (request === null) {
    throw new Error("admitted Plane research event did not produce a request");
  }
  return { request, planeRevisionDigest };
}
