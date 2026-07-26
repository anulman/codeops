import {
  canonicalSerialize,
  researchMutationBatchSchema,
  type EvidenceReference,
  type ResearchMutationBatch,
} from "@renoconcierge/codeops-contracts";
import { createHash } from "node:crypto";

export type PlaneWorkItemRecord = Readonly<{
  id: string;
  project: string;
  labels: readonly string[];
}>;

export type PlaneLabelRecord = Readonly<{
  id: string;
  name: string;
  color: string;
  description: string;
}>;

export type PlaneTerminalState = "cancelled" | "completed";

export type PlaneWorkItemContentPatch = Readonly<{
  name?: string;
  description_html?: string;
  priority?: "none" | "urgent" | "high" | "medium" | "low";
  module?: string | null;
  parent?: string | null;
  assignees?: readonly string[];
  labels?: readonly string[];
}>;

export type PlaneProjectContentPatch = Readonly<{
  name?: string;
  description?: string;
}>;

export interface PlaneContentClient {
  getWorkItem(projectId: string, workItemId: string): Promise<PlaneWorkItemRecord>;
  listLabels(projectId: string): Promise<readonly PlaneLabelRecord[]>;
  createLabel(
    projectId: string,
    input: Readonly<{ name: string; color: string; description: string }>,
  ): Promise<PlaneLabelRecord>;
  updateLabel(
    projectId: string,
    labelId: string,
    input: Readonly<{ name: string; color: string; description: string }>,
  ): Promise<PlaneLabelRecord>;
  createComment(
    projectId: string,
    workItemId: string,
    input: Readonly<{
      comment_html: string;
      external_source: "codeops";
      external_id: string;
    }>,
  ): Promise<Readonly<{ id: string }>>;
  updateProject(
    projectId: string,
    input: PlaneProjectContentPatch,
  ): Promise<void>;
  updateWorkItem(
    projectId: string,
    workItemId: string,
    input: PlaneWorkItemContentPatch,
  ): Promise<void>;
  createWorkItem(
    projectId: string,
    input: PlaneWorkItemContentPatch & Readonly<{ name: string }>,
  ): Promise<PlaneWorkItemRecord>;
  transitionWorkItemToTerminalState(
    projectId: string,
    workItemId: string,
    terminalState: PlaneTerminalState,
  ): Promise<void>;
  assertTerminalStateAvailable(
    projectId: string,
    terminalState: PlaneTerminalState,
  ): Promise<void>;
}

export type MutationResult = Readonly<{
  index: number;
  type: ResearchMutationBatch["mutations"][number]["type"];
  targetId?: string;
}>;

const labelKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const labelMarkerPattern = /\[codeops-key:([a-z0-9][a-z0-9._-]{0,127})\]/g;

function labelMarker(key: string): string {
  if (!labelKeyPattern.test(key)) throw new Error(`invalid label key: ${key}`);
  return `[codeops-key:${key}]`;
}

function labelDescription(key: string, description: string): string {
  const marker = labelMarker(key);
  return description.length === 0 ? marker : `${description}\n\n${marker}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertSafeContentHtml(value: string): void {
  const tags = value.match(/<[^>]*>/g) ?? [];
  const text = value.replaceAll(/<[^>]*>/g, "");
  if (text.includes("<") || text.includes(">")) {
    throw new Error("content HTML contains malformed markup");
  }
  for (const tag of tags) {
    if (
      /^<\/?(?:p|br|ul|ol|li|strong|em|code|pre|blockquote|h[1-4])\s*\/?>$/i.test(
        tag,
      )
    ) {
      continue;
    }
    const anchor = tag.match(/^<a href="([^"]+)">$/i);
    const href = anchor?.[1];
    if (href !== undefined) {
      const url = new URL(href);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      ) {
        continue;
      }
    }
    if (/^<\/a>$/i.test(tag)) continue;
    throw new Error(`content HTML contains a forbidden tag: ${tag}`);
  }
}

function evidenceReferencesHtml(evidence: readonly EvidenceReference[]): string {
  if (evidence.length === 0) return "";
  const items = evidence.map((attachment) => {
    const label = `${attachment.kind} · ${attachment.digest} · ${attachment.mediaType}`;
    if (attachment.uri.startsWith("https://")) {
      return `<li><a href="${escapeHtml(attachment.uri)}">${escapeHtml(label)}</a></li>`;
    }
    return `<li><code>${escapeHtml(attachment.uri)}</code> · ${escapeHtml(label)}</li>`;
  });
  return `<p><strong>Evidence</strong></p><ul>${items.join("")}</ul>`;
}

function externalId(requestId: string, index: number, purpose: string): string {
  return createHash("sha256")
    .update(canonicalSerialize({ requestId, index, purpose }))
    .digest("hex");
}

async function assertSameProject(
  client: PlaneContentClient,
  projectId: string,
  workItemId: string,
): Promise<PlaneWorkItemRecord> {
  const item = await client.getWorkItem(projectId, workItemId);
  if (item.id !== workItemId || item.project !== projectId) {
    throw new Error(`work item ${workItemId} is outside project ${projectId}`);
  }
  return item;
}

async function findLabel(
  client: PlaneContentClient,
  projectId: string,
  key: string,
): Promise<PlaneLabelRecord | undefined> {
  const marker = labelMarker(key);
  const matches = (await client.listLabels(projectId)).filter((label) =>
    label.description.includes(marker),
  );
  if (matches.length > 1) {
    throw new Error(`duplicate Plane labels for key ${key}`);
  }
  return matches[0];
}

async function requireLabel(
  client: PlaneContentClient,
  projectId: string,
  key: string,
): Promise<PlaneLabelRecord> {
  const label = await findLabel(client, projectId, key);
  if (label === undefined) throw new Error(`unknown Plane label key ${key}`);
  return label;
}

async function upsertLabel(
  client: PlaneContentClient,
  projectId: string,
  input: Readonly<{
    key: string;
    name: string;
    color: string;
    description: string;
  }>,
): Promise<PlaneLabelRecord> {
  const description = labelDescription(input.key, input.description);
  const existing = await findLabel(client, projectId, input.key);
  if (existing === undefined) {
    return client.createLabel(projectId, {
      name: input.name,
      color: input.color,
      description,
    });
  }
  return client.updateLabel(projectId, existing.id, {
    name: input.name,
    color: input.color,
    description,
  });
}

async function preflightMutationBatch(
  client: PlaneContentClient,
  batch: ResearchMutationBatch,
): Promise<void> {
  await assertSameProject(client, batch.projectId, batch.sourceWorkItemId);

  const labelCounts = new Map<string, number>();
  for (const label of await client.listLabels(batch.projectId)) {
    for (const match of label.description.matchAll(labelMarkerPattern)) {
      const key = match[1];
      if (key !== undefined) {
        labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of labelCounts) {
    if (count > 1) throw new Error(`duplicate Plane labels for key ${key}`);
  }

  const availableLabelKeys = new Set(labelCounts.keys());
  const upsertedLabelKeys = new Set<string>();
  for (const mutation of batch.mutations) {
    switch (mutation.type) {
      case "comment.create": {
        await assertSameProject(
          client,
          batch.projectId,
          mutation.targetWorkItemId,
        );
        assertSafeContentHtml(mutation.bodyHtml);
        break;
      }
      case "label.attach":
      case "label.detach":
      case "ticket.update": {
        await assertSameProject(
          client,
          batch.projectId,
          mutation.targetWorkItemId,
        );
        break;
      }
      case "ticket.cancel":
      case "ticket.complete": {
        await assertSameProject(
          client,
          batch.projectId,
          mutation.targetWorkItemId,
        );
        await client.assertTerminalStateAvailable(
          batch.projectId,
          mutation.type === "ticket.cancel" ? "cancelled" : "completed",
        );
        break;
      }
      case "label.upsert":
        if (upsertedLabelKeys.has(mutation.key)) {
          throw new Error(`duplicate label upsert for key ${mutation.key}`);
        }
        upsertedLabelKeys.add(mutation.key);
        availableLabelKeys.add(mutation.key);
        break;
      case "project.update":
        break;
      case "ticket.create":
        assertSafeContentHtml(mutation.descriptionHtml);
        break;
    }

    if (
      mutation.type === "ticket.cancel" &&
      mutation.supersededByWorkItemId !== undefined
    ) {
      await assertSameProject(
        client,
        batch.projectId,
        mutation.supersededByWorkItemId,
      );
      if (mutation.supersededByWorkItemId === mutation.targetWorkItemId) {
        throw new Error("a work item cannot supersede itself");
      }
    }
    if (
      mutation.type === "ticket.update" &&
      mutation.changes.parentId !== undefined &&
      mutation.changes.parentId !== null
    ) {
      await assertSameProject(
        client,
        batch.projectId,
        mutation.changes.parentId,
      );
    }
    if (
      mutation.type === "ticket.update" &&
      mutation.changes.descriptionHtml !== undefined
    ) {
      assertSafeContentHtml(mutation.changes.descriptionHtml);
    }
    if (
      mutation.type === "ticket.create" &&
      mutation.parentId !== undefined &&
      mutation.parentId !== null
    ) {
      await assertSameProject(client, batch.projectId, mutation.parentId);
    }
    if (
      (mutation.type === "label.attach" ||
        mutation.type === "label.detach") &&
      !availableLabelKeys.has(mutation.key)
    ) {
      throw new Error(`unknown Plane label key ${mutation.key}`);
    }
    if (mutation.type === "ticket.create") {
      for (const key of mutation.labelKeys) {
        if (!availableLabelKeys.has(key)) {
          throw new Error(`unknown Plane label key ${key}`);
        }
      }
    }
  }
}

async function setLabelAttached(input: {
  client: PlaneContentClient;
  projectId: string;
  workItemId: string;
  label: PlaneLabelRecord;
  attached: boolean;
}): Promise<void> {
  const item = await assertSameProject(
    input.client,
    input.projectId,
    input.workItemId,
  );
  const labels = new Set(item.labels);
  if (input.attached) labels.add(input.label.id);
  else labels.delete(input.label.id);
  await input.client.updateWorkItem(input.projectId, input.workItemId, {
    labels: [...labels].sort(),
  });
}

function ticketPatch(
  changes: Extract<
    ResearchMutationBatch["mutations"][number],
    { type: "ticket.update" }
  >["changes"],
): PlaneWorkItemContentPatch {
  return {
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.descriptionHtml === undefined
      ? {}
      : { description_html: changes.descriptionHtml }),
    ...(changes.priority === undefined ? {} : { priority: changes.priority }),
    ...(changes.moduleId === undefined ? {} : { module: changes.moduleId }),
    ...(changes.parentId === undefined ? {} : { parent: changes.parentId }),
    ...(changes.assigneeIds === undefined
      ? {}
      : { assignees: changes.assigneeIds }),
  };
}

export async function applyResearchMutationBatch(input: {
  batch: unknown;
  expected: Readonly<{
    requestId: string;
    projectId: string;
    sourceWorkItemId: string;
  }>;
  client: PlaneContentClient;
}): Promise<readonly MutationResult[]> {
  const batch = researchMutationBatchSchema.parse(input.batch);
  if (
    batch.requestId !== input.expected.requestId ||
    batch.projectId !== input.expected.projectId ||
    batch.sourceWorkItemId !== input.expected.sourceWorkItemId
  ) {
    throw new Error("research mutation batch does not match admitted request");
  }
  await preflightMutationBatch(input.client, batch);

  const results: MutationResult[] = [];
  for (const [index, mutation] of batch.mutations.entries()) {
    switch (mutation.type) {
      case "comment.create": {
        await assertSameProject(
          input.client,
          batch.projectId,
          mutation.targetWorkItemId,
        );
        await input.client.createComment(
          batch.projectId,
          mutation.targetWorkItemId,
          {
            comment_html: `${mutation.bodyHtml}${evidenceReferencesHtml(mutation.attachments)}`,
            external_source: "codeops",
            external_id: externalId(batch.requestId, index, mutation.type),
          },
        );
        results.push({
          index,
          type: mutation.type,
          targetId: mutation.targetWorkItemId,
        });
        break;
      }
      case "label.upsert": {
        const label = await upsertLabel(input.client, batch.projectId, mutation);
        results.push({ index, type: mutation.type, targetId: label.id });
        break;
      }
      case "label.attach":
      case "label.detach": {
        const label = await requireLabel(
          input.client,
          batch.projectId,
          mutation.key,
        );
        await setLabelAttached({
          client: input.client,
          projectId: batch.projectId,
          workItemId: mutation.targetWorkItemId,
          label,
          attached: mutation.type === "label.attach",
        });
        results.push({
          index,
          type: mutation.type,
          targetId: mutation.targetWorkItemId,
        });
        break;
      }
      case "project.update": {
        await input.client.updateProject(batch.projectId, {
          ...(mutation.changes.name === undefined
            ? {}
            : { name: mutation.changes.name }),
          ...(mutation.changes.description === undefined
            ? {}
            : { description: mutation.changes.description }),
        });
        results.push({ index, type: mutation.type, targetId: batch.projectId });
        break;
      }
      case "ticket.update": {
        await assertSameProject(
          input.client,
          batch.projectId,
          mutation.targetWorkItemId,
        );
        if (mutation.changes.parentId !== undefined && mutation.changes.parentId !== null) {
          await assertSameProject(
            input.client,
            batch.projectId,
            mutation.changes.parentId,
          );
        }
        await input.client.updateWorkItem(
          batch.projectId,
          mutation.targetWorkItemId,
          ticketPatch(mutation.changes),
        );
        results.push({
          index,
          type: mutation.type,
          targetId: mutation.targetWorkItemId,
        });
        break;
      }
      case "ticket.create": {
        if (mutation.parentId !== undefined && mutation.parentId !== null) {
          await assertSameProject(
            input.client,
            batch.projectId,
            mutation.parentId,
          );
        }
        const labels = await Promise.all(
          mutation.labelKeys.map(async (key) =>
            (await requireLabel(input.client, batch.projectId, key)).id,
          ),
        );
        const created = await input.client.createWorkItem(batch.projectId, {
          name: mutation.name,
          description_html: mutation.descriptionHtml,
          ...(mutation.moduleId === undefined ? {} : { module: mutation.moduleId }),
          ...(mutation.parentId === undefined ? {} : { parent: mutation.parentId }),
          labels: [...new Set(labels)].sort(),
        });
        if (created.project !== batch.projectId) {
          throw new Error("Plane created a work item outside the admitted project");
        }
        results.push({ index, type: mutation.type, targetId: created.id });
        break;
      }
      case "ticket.cancel": {
        const replacement =
          mutation.supersededByWorkItemId === undefined
            ? ""
            : `<p><strong>Canonical replacement:</strong> <code>${escapeHtml(mutation.supersededByWorkItemId)}</code></p>`;
        await input.client.createComment(
          batch.projectId,
          mutation.targetWorkItemId,
          {
            comment_html: `<p><strong>Cancelled by QA Contract Researcher</strong></p><p><strong>Basis:</strong> ${escapeHtml(mutation.basis)}</p><p>${escapeHtml(mutation.reason)}</p>${replacement}${evidenceReferencesHtml(mutation.evidence)}`,
            external_source: "codeops",
            external_id: externalId(batch.requestId, index, mutation.type),
          },
        );
        await input.client.transitionWorkItemToTerminalState(
          batch.projectId,
          mutation.targetWorkItemId,
          "cancelled",
        );
        results.push({
          index,
          type: mutation.type,
          targetId: mutation.targetWorkItemId,
        });
        break;
      }
      case "ticket.complete": {
        await input.client.createComment(
          batch.projectId,
          mutation.targetWorkItemId,
          {
            comment_html: `<p><strong>Completed by QA Contract Researcher</strong></p><p>${escapeHtml(mutation.reason)}</p>${evidenceReferencesHtml(mutation.evidence)}`,
            external_source: "codeops",
            external_id: externalId(batch.requestId, index, mutation.type),
          },
        );
        await input.client.transitionWorkItemToTerminalState(
          batch.projectId,
          mutation.targetWorkItemId,
          "completed",
        );
        results.push({
          index,
          type: mutation.type,
          targetId: mutation.targetWorkItemId,
        });
        break;
      }
    }
  }
  return results;
}
