import {
  canonicalSerialize,
  workItemCommentResultSchema,
  workItemCreateResultSchema,
  workItemProjectionSchema,
  workItemProviderCommentRequestSchema,
  workItemProviderCreateRequestSchema,
  workItemProviderGetRequestSchema,
  workItemProviderRelateRequestSchema,
  workItemProviderSearchRequestSchema,
  workItemProviderUpdateRequestSchema,
  workItemRelateResultSchema,
  workItemSearchResultSchema,
  workItemUpdateResultSchema,
  type WorkItemCommentResult,
  type WorkItemCreateResult,
  type WorkItemProjection,
  type WorkItemRelateResult,
  type WorkItemSearchResult,
  type WorkItemUpdateResult,
  type WorkItemProviderCreateRequest,
} from "@codeops/codeops-contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PlaneApiClient } from "./plane-api.js";

const uuid = z.string().uuid();
const planeWorkItemSchema = z
  .object({
    id: uuid,
    project: uuid,
    name: z.string().max(500).default(""),
    description_html: z.string().nullable().optional(),
    description_stripped: z.string().nullable().optional(),
    priority: z.string().max(64).default("none"),
    state: uuid.optional(),
    labels: z.array(uuid).max(100).default([]),
    updated_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();
const relationSnapshotSchema = z.record(
  z.array(
    z
      .object({ project_id: uuid, issue_id: uuid })
      .passthrough(),
  ),
);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function descriptionHtml(request: WorkItemProviderCreateRequest): string {
  const paragraphs = request.description
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
  return `${paragraphs}<p><em>Created by CodeOps (${request.mode}).</em></p><!-- codeops-work-item:v1 operation=${request.operationId} payload=${request.payloadDigest} -->`;
}

function bodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function projection(input: {
  repository: string;
  item: unknown;
}): WorkItemProjection {
  const item = planeWorkItemSchema.parse(input.item);
  const revisionSource = {
    id: item.id,
    project: item.project,
    name: item.name,
    descriptionHtml: item.description_html ?? "",
    priority: item.priority,
    stateId: item.state ?? null,
    labelIds: [...item.labels].sort(),
    updatedAt: item.updated_at ?? null,
  };
  return workItemProjectionSchema.parse({
    version: "codeops.work-item-projection/v1",
    provider: "plane",
    repository: input.repository,
    workItemId: item.id,
    title: item.name,
    description: item.description_stripped ?? item.description_html ?? "",
    priority: item.priority,
    stateId: item.state ?? null,
    labelIds: [...item.labels].sort(),
    updatedAt: item.updated_at ?? null,
    revision: `sha256:${createHash("sha256")
      .update(canonicalSerialize(revisionSource))
      .digest("hex")}`,
  });
}

function assertPlane(provider: string): void {
  if (provider !== "plane") {
    throw new Error("Plane adapter cannot serve a different provider");
  }
}

export async function createPlaneWorkItem(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemCreateResult> {
  const request = workItemProviderCreateRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const operationMarker = `operation=${request.operationId}`;
  const payloadMarker = `payload=${request.payloadDigest}`;
  const matches = (await input.client.listProjectWorkItems(input.projectId)).filter(
    (item) => item.descriptionHtml.includes(operationMarker),
  );
  if (matches.length > 1) {
    throw new Error("multiple Plane work items share one CodeOps operation identity");
  }
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (
      !existing.descriptionHtml.includes(payloadMarker) ||
      existing.name !== request.title
    ) {
      throw new Error("Plane work item conflicts with its CodeOps operation identity");
    }
    return workItemCreateResultSchema.parse({
      version: "codeops.work-item-create-result/v1",
      provider: "plane",
      operationId: request.operationId,
      repository: request.repository,
      workItemId: existing.id,
      disposition: "existing",
    });
  }
  const create =
    request.mode === "triage"
      ? input.client.createIntakeWorkItem.bind(input.client)
      : input.client.createWorkItem.bind(input.client);
  const created = await create(input.projectId, {
    name: request.title,
    description_html: descriptionHtml(request),
  });
  return workItemCreateResultSchema.parse({
    version: "codeops.work-item-create-result/v1",
    provider: "plane",
    operationId: request.operationId,
    repository: request.repository,
    workItemId: created.id,
    disposition: "created",
  });
}

export async function getPlaneWorkItem(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemProjection> {
  const request = workItemProviderGetRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const item = planeWorkItemSchema.parse(
    await input.client.getWorkItemSnapshot(input.projectId, request.workItemId),
  );
  if (item.project !== input.projectId) {
    throw new Error("Plane work item escaped the configured project");
  }
  return projection({ repository: request.repository, item });
}

export async function searchPlaneWorkItems(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemSearchResult> {
  const request = workItemProviderSearchRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const query = request.query.toLocaleLowerCase();
  const items = (await input.client.listProjectWorkItemSnapshots(input.projectId))
    .map((item) => planeWorkItemSchema.parse(item))
    .filter((item) => item.project === input.projectId)
    .filter((item) =>
      `${item.name}\n${item.description_stripped ?? ""}\n${item.description_html ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .slice(0, request.limit)
    .map((item) => projection({ repository: request.repository, item }));
  return workItemSearchResultSchema.parse({
    version: "codeops.work-item-search-result/v1",
    provider: "plane",
    repository: request.repository,
    query: request.query,
    items,
  });
}

export async function commentOnPlaneWorkItem(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemCommentResult> {
  const request = workItemProviderCommentRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const current = planeWorkItemSchema.parse(
    await input.client.getWorkItemSnapshot(input.projectId, request.workItemId),
  );
  if (current.project !== input.projectId) {
    throw new Error("Plane work item escaped the configured project");
  }
  const comment = await input.client.createComment(
    input.projectId,
    request.workItemId,
    {
      comment_html: `${bodyHtml(request.body)}<!-- codeops-work-item-comment:v1 operation=${request.operationId} payload=${request.payloadDigest} -->`,
      external_source: "codeops",
      external_id: `work-item-comment:${request.operationId}`,
    },
  );
  return workItemCommentResultSchema.parse({
    version: "codeops.work-item-comment-result/v1",
    provider: "plane",
    repository: request.repository,
    workItemId: request.workItemId,
    commentId: comment.id,
    operationId: request.operationId,
    disposition: comment.disposition ?? "created",
  });
}

export async function updatePlaneWorkItem(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemUpdateResult> {
  const request = workItemProviderUpdateRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const before = await getPlaneWorkItem({
    request: {
      version: "codeops.work-item-provider-get-request/v1",
      provider: request.provider,
      operationId: request.operationId,
      payloadDigest: request.payloadDigest,
      repository: request.repository,
      workItemId: request.workItemId,
      provenance: request.provenance,
    },
    projectId: input.projectId,
    client: input.client,
  });
  const desiredMatches =
    (request.title === undefined || request.title === before.title) &&
    (request.description === undefined || request.description === before.description);
  if (before.revision !== request.expectedRevision) {
    if (desiredMatches) {
      return workItemUpdateResultSchema.parse({
        version: "codeops.work-item-update-result/v1",
        provider: "plane",
        repository: request.repository,
        operationId: request.operationId,
        disposition: "existing",
        item: before,
      });
    }
    return workItemUpdateResultSchema.parse({
      version: "codeops.work-item-update-result/v1",
      provider: "plane",
      repository: request.repository,
      operationId: request.operationId,
      disposition: "reload-required",
      item: before,
    });
  }
  if (desiredMatches) {
    return workItemUpdateResultSchema.parse({
      version: "codeops.work-item-update-result/v1",
      provider: "plane",
      repository: request.repository,
      operationId: request.operationId,
      disposition: "existing",
      item: before,
    });
  }
  await input.client.updateWorkItem(input.projectId, request.workItemId, {
    ...(request.title === undefined ? {} : { name: request.title }),
    ...(request.description === undefined
      ? {}
      : { description_html: bodyHtml(request.description) }),
  });
  const item = await getPlaneWorkItem({
    request: {
      version: "codeops.work-item-provider-get-request/v1",
      provider: request.provider,
      operationId: request.operationId,
      payloadDigest: request.payloadDigest,
      repository: request.repository,
      workItemId: request.workItemId,
      provenance: request.provenance,
    },
    projectId: input.projectId,
    client: input.client,
  });
  return workItemUpdateResultSchema.parse({
    version: "codeops.work-item-update-result/v1",
    provider: "plane",
    repository: request.repository,
    operationId: request.operationId,
    disposition: "updated",
    item,
  });
}

export async function relatePlaneWorkItems(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemRelateResult> {
  const request = workItemProviderRelateRequestSchema.parse(input.request);
  assertPlane(request.provider);
  const [source, target, relations] = await Promise.all([
    input.client.getWorkItemSnapshot(input.projectId, request.workItemId),
    input.client.getWorkItemSnapshot(input.projectId, request.relatedWorkItemId),
    input.client.getWorkItemRelations(input.projectId, request.workItemId),
  ]);
  if (
    planeWorkItemSchema.parse(source).project !== input.projectId ||
    planeWorkItemSchema.parse(target).project !== input.projectId
  ) {
    throw new Error("Plane relation escaped the configured project");
  }
  const current = relationSnapshotSchema.parse(relations);
  const existing = (current[request.relation] ?? []).some(
    (relation) => relation.issue_id === request.relatedWorkItemId,
  );
  if (!existing) {
    await input.client.createWorkItemRelation(
      input.projectId,
      request.workItemId,
      { relation_type: request.relation, issues: [request.relatedWorkItemId] },
    );
  }
  return workItemRelateResultSchema.parse({
    version: "codeops.work-item-relate-result/v1",
    provider: "plane",
    repository: request.repository,
    workItemId: request.workItemId,
    relatedWorkItemId: request.relatedWorkItemId,
    relation: request.relation,
    operationId: request.operationId,
    disposition: existing ? "existing" : "created",
  });
}
