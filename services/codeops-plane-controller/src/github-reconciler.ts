import { z } from "zod";
import type { GitHubPullRequestEvent } from "./github-events.js";
import type {
  PullRequestBindingStore,
  StoredPullRequestBinding,
} from "./pr-binding-store.js";

export type GitHubReconciliationResult =
  | Readonly<{ status: "ignored"; reason: string }>
  | Readonly<{
      status: "completed";
      workItemId: string;
      projectId: string;
    }>
  | Readonly<{
      status: "attention-required";
      workItemId: string;
      projectId: string;
      reason: string;
    }>;

/**
 * Reconciles only exact, durable ticket↔PR bindings. Plane lifecycle writes and
 * dependent scheduling remain injected capabilities so this core is
 * deterministic and retries are idempotent.
 */
export async function reconcileGitHubPullRequestEvent(input: {
  event: GitHubPullRequestEvent;
  receivedAt: string;
  bindings: PullRequestBindingStore;
  completeTicket: (input: {
    binding: StoredPullRequestBinding;
    event: GitHubPullRequestEvent;
  }) => Promise<void>;
  requireAttention: (input: {
    binding: StoredPullRequestBinding;
    event: GitHubPullRequestEvent;
    reason: string;
  }) => Promise<void>;
  reevaluateProject: (input: {
    workspaceId: string;
    projectId: string;
  }) => Promise<void>;
}): Promise<GitHubReconciliationResult> {
  const receivedAt = z.string().datetime({ offset: true }).parse(input.receivedAt);
  const binding = await input.bindings.getByPullRequest({
    repository: input.event.repository,
    number: input.event.number,
  });
  if (binding === null) {
    return { status: "ignored", reason: "pull-request-is-not-bound" };
  }
  if (binding.state === "merged") {
    return { status: "ignored", reason: "pull-request-merge-already-reconciled" };
  }

  const exactHead = binding.headSha === input.event.headSha;
  const exactRefs =
    binding.headRef === input.event.headRef &&
    binding.baseRef === input.event.baseRef;
  if (
    input.event.action === "closed" &&
    input.event.merged &&
    exactHead &&
    exactRefs
  ) {
    await input.completeTicket({ binding, event: input.event });
    await input.bindings.put({
      ...binding,
      state: "merged",
      qualified: false,
      updatedAt: receivedAt,
    });
    await input.reevaluateProject({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
    });
    return {
      status: "completed",
      workItemId: binding.workItemId,
      projectId: binding.projectId,
    };
  }

  const reason = !exactHead
    ? "bound-pr-head-drifted"
    : !exactRefs
      ? "bound-pr-ref-drifted"
    : input.event.action === "closed"
      ? "bound-pr-closed-without-merge"
      : input.event.action === "synchronize"
        ? "bound-pr-head-requires-requalification"
        : "bound-pr-reopened-requires-requalification";
  await input.bindings.put({
    ...binding,
    state: input.event.action === "closed" ? "closed" : "open",
    headSha: input.event.headSha,
    qualified: false,
    updatedAt: receivedAt,
  });
  await input.requireAttention({ binding, event: input.event, reason });
  await input.reevaluateProject({
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
  });
  return {
    status: "attention-required",
    workItemId: binding.workItemId,
    projectId: binding.projectId,
    reason,
  };
}
