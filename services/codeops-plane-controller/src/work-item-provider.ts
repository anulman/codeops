import {
  workItemCreateResultSchema,
  workItemProviderCreateRequestSchema,
  type WorkItemCreateResult,
  type WorkItemProviderCreateRequest,
} from "@codeops/codeops-contracts";
import type { PlaneApiClient } from "./plane-api.js";

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

export async function createPlaneWorkItem(input: {
  readonly request: unknown;
  readonly projectId: string;
  readonly client: PlaneApiClient;
}): Promise<WorkItemCreateResult> {
  const request = workItemProviderCreateRequestSchema.parse(input.request);
  if (request.provider !== "plane") {
    throw new Error("Plane adapter cannot serve a different provider");
  }
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
