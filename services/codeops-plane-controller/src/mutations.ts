import {
  canonicalSerialize,
  researchMutationBatchSchema,
  type ResearchMutationBatch,
} from "@codeops/codeops-contracts";
import {
  RESEARCH_MANAGED_HEADING,
  RESEARCH_TASK_MANAGED_HEADING,
} from "@codeops/codeops-contracts/managed-content";
import { createHash } from "node:crypto";

export type PlaneWorkItemRecord = Readonly<{
  id: string;
  project: string;
  labels: readonly string[];
  name: string;
  descriptionHtml: string;
}>;

export type PlaneWorkItemContentPatch = Readonly<{
  name?: string;
  description_html?: string;
}>;

export interface PlaneContentClient {
  getWorkItem(projectId: string, workItemId: string): Promise<PlaneWorkItemRecord>;
  createComment(
    projectId: string,
    workItemId: string,
    input: Readonly<{
      comment_html: string;
      external_source: "codeops";
      external_id: string;
    }>,
  ): Promise<Readonly<{ id: string }>>;
  updateWorkItem(
    projectId: string,
    workItemId: string,
    input: PlaneWorkItemContentPatch,
  ): Promise<void>;
  listProjectWorkItems(projectId: string): Promise<readonly PlaneWorkItemRecord[]>;
  createWorkItem(
    projectId: string,
    input: Readonly<{ name: string; description_html: string }>,
  ): Promise<PlaneWorkItemRecord>;
}

export type MutationResult = Readonly<{
  index: number;
  type: ResearchMutationBatch["mutations"][number]["type"];
  targetId: string;
}>;

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
        url.search === "" &&
        (url.hash === "" || /^#L\d+-L\d+$/.test(url.hash))
      ) {
        continue;
      }
    }
    if (/^<\/a>$/i.test(tag)) continue;
    throw new Error(`content HTML contains a forbidden tag: ${tag}`);
  }
}

function attachmentReferencesHtml(
  attachments: Extract<
    ResearchMutationBatch["mutations"][number],
    { type: "comment.create" }
  >["attachments"],
): string {
  if (attachments.length === 0) return "";
  const items = attachments.map((attachment) => {
    const label = `${attachment.kind} · ${attachment.digest} · ${attachment.mediaType}`;
    if (attachment.uri.startsWith("https://")) {
      return `<li><a href="${escapeHtml(attachment.uri)}">${escapeHtml(label)}</a></li>`;
    }
    return `<li><code>${escapeHtml(attachment.uri)}</code> · ${escapeHtml(label)}</li>`;
  });
  return `<p><strong>Retained checkpoints</strong></p><ul>${items.join("")}</ul>`;
}

function externalId(requestId: string, index: number, purpose: string): string {
  return createHash("sha256")
    .update(canonicalSerialize({ requestId, index, purpose }))
    .digest("hex");
}

const taskMarkerPattern =
  /\[codeops-research-task:([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})\]/g;

function taskMarker(key: string): string {
  return `[codeops-research-task:${key}]`;
}

function descriptionDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePlaneContentHtml(value: string): string {
  let normalized = value.replaceAll(
    /<a href="([^"]+)" rel="noopener noreferrer">/gi,
    '<a href="$1">',
  );
  if (
    normalized.startsWith("<div>") &&
    normalized.endsWith("</div>") &&
    (normalized.includes(RESEARCH_MANAGED_HEADING) ||
      normalized.includes(RESEARCH_TASK_MANAGED_HEADING))
  ) {
    normalized = normalized.slice("<div>".length, -"</div>".length);
  }
  return normalized;
}

function descriptionsEquivalent(current: string, proposed: string): boolean {
  return (
    normalizePlaneContentHtml(current) === normalizePlaneContentHtml(proposed)
  );
}

function assertPreservedContentAndSafeManagedHtml(input: {
  current: string;
  proposed: string;
  managedHeading: string;
}): void {
  const current = normalizePlaneContentHtml(input.current);
  const proposed = normalizePlaneContentHtml(input.proposed);
  const managedIndex = proposed.indexOf(input.managedHeading);
  if (managedIndex < 0) {
    throw new Error("research mutation is missing its managed content boundary");
  }
  const currentPreserved = current.split(input.managedHeading)[0]!.trim();
  const proposedPreserved = proposed.slice(0, managedIndex).trim();
  if (proposedPreserved !== currentPreserved) {
    throw new Error("research mutation changed preserved human-authored content");
  }
  assertSafeContentHtml(proposed.slice(managedIndex));
}

async function assertSourceTicket(
  client: PlaneContentClient,
  projectId: string,
  sourceWorkItemId: string,
): Promise<PlaneWorkItemRecord> {
  const item = await client.getWorkItem(projectId, sourceWorkItemId);
  if (item.id !== sourceWorkItemId || item.project !== projectId) {
    throw new Error("research mutation target is outside the source ticket");
  }
  return item;
}

async function resolveTaskTarget(
  client: PlaneContentClient,
  projectId: string,
  mutation: Extract<
    ResearchMutationBatch["mutations"][number],
    { type: "task.upsert" }
  >,
): Promise<PlaneWorkItemRecord | undefined> {
  const items = await client.listProjectWorkItems(projectId);
  const keyed = items.filter((item) =>
    [...item.descriptionHtml.matchAll(taskMarkerPattern)].some(
      (match) => match[1] === mutation.key,
    ),
  );
  if (keyed.length > 1) {
    throw new Error(`duplicate Plane tasks share research key ${mutation.key}`);
  }
  if (mutation.targetWorkItemId === null) return keyed[0];
  const target = await client.getWorkItem(projectId, mutation.targetWorkItemId);
  if (target.id !== mutation.targetWorkItemId || target.project !== projectId) {
    throw new Error("research task update target is outside the admitted project");
  }
  if (keyed.length === 1 && keyed[0]!.id !== target.id) {
    throw new Error(`research task key ${mutation.key} belongs to another task`);
  }
  return target;
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
  const sourceTicket = await assertSourceTicket(
    input.client,
    batch.projectId,
    batch.sourceWorkItemId,
  );
  const taskTargets = new Map<number, PlaneWorkItemRecord | undefined>();
  for (const [index, mutation] of batch.mutations.entries()) {
    if (mutation.type === "ticket.update") {
      if (mutation.targetWorkItemId !== batch.sourceWorkItemId) {
        throw new Error("research description refinement must target the source ticket");
      }
      assertPreservedContentAndSafeManagedHtml({
        current: sourceTicket.descriptionHtml,
        proposed: mutation.changes.descriptionHtml,
        managedHeading: RESEARCH_MANAGED_HEADING,
      });
    } else if (mutation.type === "comment.create") {
      if (mutation.targetWorkItemId !== batch.sourceWorkItemId) {
        throw new Error("research synthesis comment must target the source ticket");
      }
      assertSafeContentHtml(mutation.bodyHtml);
    } else {
      if (!mutation.descriptionHtml.includes(taskMarker(mutation.key))) {
        throw new Error("research task description is missing its stable key");
      }
      const target = await resolveTaskTarget(
        input.client,
        batch.projectId,
        mutation,
      );
      if (target === undefined) {
        assertSafeContentHtml(mutation.descriptionHtml);
      }
      if (
        target !== undefined &&
        (target.name !== mutation.name ||
          !descriptionsEquivalent(
            target.descriptionHtml,
            mutation.descriptionHtml,
          )) &&
        (mutation.expectedDescriptionDigest === null ||
          descriptionDigest(target.descriptionHtml) !==
            mutation.expectedDescriptionDigest)
      ) {
        throw new Error(`research task ${mutation.key} changed after admission`);
      }
      if (target !== undefined) {
        assertPreservedContentAndSafeManagedHtml({
          current: target.descriptionHtml,
          proposed: mutation.descriptionHtml,
          managedHeading: RESEARCH_TASK_MANAGED_HEADING,
        });
      }
      taskTargets.set(index, target);
    }
  }

  const results: MutationResult[] = [];
  for (const [index, mutation] of batch.mutations.entries()) {
    if (mutation.type === "ticket.update") {
      if (
        !descriptionsEquivalent(
          sourceTicket.descriptionHtml,
          mutation.changes.descriptionHtml,
        )
      ) {
        await input.client.updateWorkItem(
          batch.projectId,
          batch.sourceWorkItemId,
          {
            description_html: mutation.changes.descriptionHtml,
          },
        );
      }
    } else if (mutation.type === "comment.create") {
      await input.client.createComment(
        batch.projectId,
        batch.sourceWorkItemId,
        {
          comment_html: `${mutation.bodyHtml}${attachmentReferencesHtml(
            mutation.attachments,
          )}`,
          external_source: "codeops",
          external_id: externalId(batch.requestId, index, mutation.type),
        },
      );
    } else {
      const target = taskTargets.get(index);
      if (target === undefined) {
        const created = await input.client.createWorkItem(batch.projectId, {
          name: mutation.name,
          description_html: mutation.descriptionHtml,
        });
        if (created.project !== batch.projectId) {
          throw new Error("Plane created research task outside the admitted project");
        }
        results.push({
          index,
          type: mutation.type,
          targetId: created.id,
        });
        continue;
      }
      if (
        target.name !== mutation.name ||
        !descriptionsEquivalent(target.descriptionHtml, mutation.descriptionHtml)
      ) {
        await input.client.updateWorkItem(batch.projectId, target.id, {
          name: mutation.name,
          description_html: mutation.descriptionHtml,
        });
      }
      results.push({
        index,
        type: mutation.type,
        targetId: target.id,
      });
      continue;
    }
    results.push({
      index,
      type: mutation.type,
      targetId: batch.sourceWorkItemId,
    });
  }
  return results;
}
