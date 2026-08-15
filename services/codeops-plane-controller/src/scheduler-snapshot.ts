import { z } from "zod";
import type { PullRequestBindingStore } from "./pr-binding-store.js";
import type {
  SchedulerTicket,
  SchedulerTicketState,
} from "./scheduler.js";

const uuid = z.string().uuid();
const workItemSchema = z
  .object({
    id: uuid,
    state: uuid,
  })
  .passthrough();
const relationSchema = z
  .object({
    project_id: uuid,
    issue_id: uuid,
  })
  .passthrough();
const relationsSchema = z
  .object({
    blocked_by: z.array(relationSchema).default([]),
  })
  .passthrough();

export type SchedulerStateIds = Readonly<
  Record<Exclude<SchedulerTicketState, "unknown">, string>
>;

export async function compileSchedulerProjectSnapshot(input: {
  projectId: string;
  workItems: readonly unknown[];
  loadRelations: (workItemId: string) => Promise<unknown>;
  workflowByWorkItem: ReadonlyMap<
    string,
    SchedulerTicket["workflow"]
  >;
  stateIds: SchedulerStateIds;
  bindings: PullRequestBindingStore;
}): Promise<ReadonlyMap<string, SchedulerTicket>> {
  const projectId = uuid.parse(input.projectId);
  const stateEntries = Object.entries(input.stateIds).map(
    ([state, id]) => [state as Exclude<SchedulerTicketState, "unknown">, uuid.parse(id)] as const,
  );
  if (new Set(stateEntries.map(([, id]) => id)).size !== stateEntries.length) {
    throw new Error("scheduler state IDs must be unique");
  }
  const stateById = new Map(stateEntries.map(([state, id]) => [id, state]));
  const items = z.array(workItemSchema).max(200).parse(input.workItems);
  const uniqueItems = new Map(items.map((item) => [item.id, item]));
  if (uniqueItems.size !== items.length) {
    throw new Error("scheduler project snapshot contains duplicate work items");
  }

  const result = new Map<string, SchedulerTicket>();
  for (const workItemId of [...uniqueItems.keys()].sort()) {
    const item = uniqueItems.get(workItemId)!;
    const workflow = input.workflowByWorkItem.get(workItemId);
    if (workflow === undefined) {
      throw new Error(`scheduler workflow snapshot missing for ${workItemId}`);
    }
    const relations = relationsSchema.parse(
      await input.loadRelations(workItemId),
    );
    const blockedBy = relations.blocked_by.map((relation) => {
      if (relation.project_id !== projectId) {
        throw new Error("cross-project blockers are not schedulable");
      }
      return relation.issue_id;
    });
    if (new Set(blockedBy).size !== blockedBy.length) {
      throw new Error("scheduler relations contain duplicate blockers");
    }
    if (blockedBy.includes(workItemId)) {
      throw new Error("scheduler ticket cannot block itself");
    }
    const binding = await input.bindings.getByWorkItem(workItemId);
    result.set(workItemId, {
      id: workItemId,
      state: stateById.get(item.state) ?? "unknown",
      blockedBy: [...blockedBy].sort(),
      workflow,
      ...(binding === null
        ? {}
        : {
            pullRequest: {
              repository: binding.repository,
              number: binding.number,
              state: binding.state,
              headSha: binding.headSha,
              headRef: binding.headRef,
              baseRef: binding.baseRef,
              baseSha: binding.baseSha,
              ...(binding.baseTicketId === undefined
                ? {}
                : { baseTicketId: binding.baseTicketId }),
              ...(binding.nativeStack === undefined
                ? {}
                : { nativeStack: binding.nativeStack }),
              qualified: binding.qualified,
            },
          }),
    });
  }
  return result;
}
