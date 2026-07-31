import { z } from "zod";
import type { GitHubPullRequestStackSnapshot } from "@renoconcierge/codeops-contracts";
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

function nativeStackFromEvent(
  event: GitHubPullRequestEvent,
): StoredPullRequestBinding["nativeStack"] {
  const stack = event.stack ?? null;
  return stack === null
    ? undefined
    : {
        ...stack,
        active: true,
      };
}

function exactNativeStack(
  binding: StoredPullRequestBinding,
  event: GitHubPullRequestEvent,
): boolean {
  const stack = event.stack ?? null;
  if (binding.nativeStack === undefined) return stack === null;
  return (
    binding.nativeStack.active &&
    stack !== null &&
    binding.nativeStack.number === stack.number &&
    binding.nativeStack.position === stack.position &&
    binding.nativeStack.base.ref === stack.base.ref &&
    stack.size >= binding.nativeStack.size
  );
}

function updatedNativeStack(
  binding: StoredPullRequestBinding,
  event: GitHubPullRequestEvent,
): StoredPullRequestBinding["nativeStack"] {
  if ((event.stack ?? null) !== null) return nativeStackFromEvent(event);
  return binding.nativeStack === undefined
    ? undefined
    : { ...binding.nativeStack, active: false };
}

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
  const exactStack = exactNativeStack(binding, input.event);
  if (
    input.event.action === "closed" &&
    input.event.merged &&
    exactHead &&
    exactRefs &&
    exactStack
  ) {
    await input.completeTicket({ binding, event: input.event });
    await input.bindings.put({
      ...binding,
      state: "merged",
      ...((input.event.stack ?? null) === null
        ? {}
        : { nativeStack: nativeStackFromEvent(input.event) }),
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
      : !exactStack
        ? binding.nativeStack === undefined && (input.event.stack ?? null) !== null
          ? "bound-pr-native-stack-requires-requalification"
          : (input.event.stack ?? null) === null
            ? "bound-pr-native-stack-removed"
            : "bound-pr-native-stack-drifted"
      : input.event.action === "closed"
      ? "bound-pr-closed-without-merge"
        : input.event.action === "synchronize"
        ? "bound-pr-head-requires-requalification"
        : input.event.action === "reopened"
          ? "bound-pr-reopened-requires-requalification"
          : input.event.action === "converted_to_draft"
            ? "bound-pr-draft-requires-attention"
            : "bound-pr-metadata-requires-requalification";
  await input.bindings.put({
    ...binding,
    state: input.event.action === "closed" ? "closed" : "open",
    headSha: input.event.headSha,
    baseRef: input.event.baseRef,
    ...(updatedNativeStack(binding, input.event) === undefined
      ? {}
      : { nativeStack: updatedNativeStack(binding, input.event) }),
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

export async function reconcileGitHubPullRequestMergeGroup(input: {
  event: GitHubPullRequestEvent;
  receivedAt: string;
  bindings: PullRequestBindingStore;
  loadStack: (
    stackNumber: number,
  ) => Promise<GitHubPullRequestStackSnapshot>;
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
}): Promise<readonly GitHubReconciliationResult[]> {
  if (
    input.event.action !== "closed" ||
    !input.event.merged ||
    (input.event.stack ?? null) === null
  ) {
    return [
      await reconcileGitHubPullRequestEvent(input),
    ];
  }
  const eventStack = input.event.stack!;
  const snapshot = await input.loadStack(eventStack.number);
  if (
    snapshot.repository !== input.event.repository ||
    snapshot.number !== eventStack.number ||
    snapshot.pullRequests.length !== eventStack.size
  ) {
    throw new Error("GitHub merged stack snapshot identity drifted");
  }
  const current = snapshot.pullRequests[eventStack.position - 1];
  if (
    current === undefined ||
    current.number !== input.event.number ||
    current.head.sha !== input.event.headSha ||
    current.head.ref !== input.event.headRef ||
    current.base.ref !== input.event.baseRef ||
    current.mergedAt === null
  ) {
    throw new Error("GitHub merged stack snapshot omitted the exact webhook PR");
  }
  const stackBaseSha = snapshot.pullRequests[0]!.base.sha;
  const results: GitHubReconciliationResult[] = [];
  for (const [index, pullRequest] of snapshot.pullRequests.entries()) {
    if (pullRequest.mergedAt === null) continue;
    results.push(
      await reconcileGitHubPullRequestEvent({
        ...input,
        event: {
          kind: "pull_request",
          repository: snapshot.repository,
          number: pullRequest.number,
          action: "closed",
          merged: true,
          headSha: pullRequest.head.sha,
          headRef: pullRequest.head.ref,
          baseRef: pullRequest.base.ref,
          stack: {
            number: snapshot.number,
            size: snapshot.pullRequests.length,
            position: index + 1,
            base: {
              ref: snapshot.baseRef,
              sha: stackBaseSha,
            },
          },
        },
      }),
    );
  }
  return results;
}
