import { createHash } from "node:crypto";
import { canonicalSerialize } from "@renoconcierge/codeops-contracts";
import { z } from "zod";
import type { ResearchDedupLedger } from "./dedup-ledger.js";
import type {
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from "./github-events.js";
import type {
  PullRequestBindingStore,
  StoredPullRequestBinding,
} from "./pr-binding-store.js";

export type GitHubSessionEvent =
  | GitHubIssueCommentEvent
  | GitHubPullRequestReviewCommentEvent
  | GitHubPullRequestEvent;

export type GitHubSessionReconciliationResult =
  | Readonly<{ status: "ignored"; reason: string }>
  | Readonly<{
      status: "steered";
      sessionId: string;
      workItemId: string;
      duplicate: boolean;
    }>;

export interface GitHubSessionSteeringRequest {
  readonly binding: StoredPullRequestBinding;
  readonly event:
    | Exclude<GitHubSessionEvent, GitHubIssueCommentEvent>
    | (GitHubIssueCommentEvent & {
        readonly currentHeadSha: string;
        readonly headRef: string;
        readonly baseRef: string;
      });
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
}

function stableEventId(event: GitHubSessionEvent): string {
  switch (event.kind) {
    case "issue_comment":
      return `github-pr-comment:${event.commentId}:${event.updatedAt}`;
    case "pull_request_review_comment":
      return `github-pr-review-comment:${event.commentId}:${event.updatedAt}`;
    case "pull_request":
      return `github-pr-change:${event.number}:${event.action}:${event.headSha}:${event.updatedAt}`;
  }
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventPrompt(event: GitHubSessionEvent): string {
  if (event.kind === "issue_comment") return event.body;
  if (event.kind === "pull_request_review_comment") {
    const location = event.line === null ? event.path : `${event.path}:${event.line}`;
    return `[GitHub inline review comment on ${location}]\n\n${event.body}`;
  }
  return [
    `GitHub PR #${event.number} changed: ${event.action}.`,
    `Title: ${event.title}`,
    `Head: ${event.headRef} at ${event.headSha}`,
    `Base: ${event.baseRef}`,
  ].join("\n");
}

function eventActor(event: GitHubSessionEvent): {
  id: number;
  login: string;
  type: "User" | "Bot";
} {
  return { id: event.actorId, login: event.actorLogin, type: event.actorType };
}

function matchesBinding(
  event: GitHubSessionEvent,
  binding: StoredPullRequestBinding,
  currentPullRequest?: Readonly<{
    state: "open" | "closed";
    headSha: string;
    headRef: string;
    baseRef: string;
  }>,
): boolean {
  if (
    binding.repository !== event.repository ||
    binding.number !== event.number ||
    binding.state !== "open"
  ) {
    return false;
  }
  if (event.kind === "issue_comment") {
    return (
      event.pullRequestState === "open" &&
      currentPullRequest?.state === "open" &&
      binding.headSha === currentPullRequest.headSha &&
      binding.headRef === currentPullRequest.headRef &&
      binding.baseRef === currentPullRequest.baseRef
    );
  }
  if (event.kind === "pull_request_review_comment") {
    return (
      event.pullRequestState === "open" &&
      event.commentHeadSha === event.currentHeadSha &&
      binding.headSha === event.currentHeadSha &&
      binding.headRef === event.headRef &&
      binding.baseRef === event.baseRef
    );
  }
  return (
    event.action !== "closed" &&
    binding.headSha === event.headSha &&
    binding.headRef === event.headRef &&
    binding.baseRef === event.baseRef
  );
}

export async function reconcileGitHubSessionEvent(input: {
  event: GitHubSessionEvent;
  receivedAt: string;
  allowedActorIds: ReadonlySet<number>;
  bindings: PullRequestBindingStore;
  ledger: ResearchDedupLedger;
  resolveCurrentPullRequest: (input: {
    repository: string;
    number: number;
  }) => Promise<Readonly<{
    repository: string;
    number: number;
    state: "open" | "closed";
    headSha: string;
    headRef: string;
    baseRef: string;
  }>>;
  steer: (request: GitHubSessionSteeringRequest) => Promise<{ sessionId: string }>;
}): Promise<GitHubSessionReconciliationResult> {
  const receivedAt = z.string().datetime({ offset: true }).parse(input.receivedAt);
  const actor = eventActor(input.event);
  if (actor.type !== "User" || !input.allowedActorIds.has(actor.id)) {
    return { status: "ignored", reason: "actor-is-not-allowlisted" };
  }
  const binding = await input.bindings.getByPullRequest({
    repository: input.event.repository,
    number: input.event.number,
  });
  if (binding === null) {
    return { status: "ignored", reason: "pull-request-is-not-bound" };
  }
  const currentPullRequest =
    input.event.kind === "issue_comment"
      ? await input.resolveCurrentPullRequest({
          repository: input.event.repository,
          number: input.event.number,
        })
      : undefined;
  if (
    currentPullRequest !== undefined &&
    (currentPullRequest.repository !== input.event.repository ||
      currentPullRequest.number !== input.event.number)
  ) {
    throw new Error("current pull-request resolution returned a different identity");
  }
  if (!matchesBinding(input.event, binding, currentPullRequest)) {
    return { status: "ignored", reason: "event-does-not-match-bound-current-head" };
  }
  const stableId = stableEventId(input.event);
  const claim = await input.ledger.claim({
    kind: "event",
    stableId,
    payloadDigest: `sha256:${createHash("sha256")
      .update(canonicalSerialize(input.event))
      .digest("hex")}`,
    now: receivedAt,
  });
  if (claim.status === "busy") {
    throw new Error("GitHub session event is already processing");
  }
  if (claim.status === "complete") {
    return {
      status: "steered",
      sessionId:
        claim.resultId ??
        (() => {
          throw new Error("completed GitHub session event omitted session identity");
        })(),
      workItemId: binding.workItemId,
      duplicate: true,
    };
  }
  try {
    const result = await input.steer({
      binding,
      event:
        input.event.kind === "issue_comment"
          ? {
              ...input.event,
              currentHeadSha: currentPullRequest!.headSha,
              headRef: currentPullRequest!.headRef,
              baseRef: currentPullRequest!.baseRef,
            }
          : input.event,
      prompt: eventPrompt(input.event),
      idempotencyKey: deterministicUuid(stableId),
      principalId: `github:${actor.id}`,
    });
    await input.ledger.complete({
      claim,
      outcome: "request-enqueued",
      resultId: result.sessionId,
      now: receivedAt,
    });
    return {
      status: "steered",
      sessionId: result.sessionId,
      workItemId: binding.workItemId,
      duplicate: false,
    };
  } catch (error) {
    await input.ledger.fail({
      claim,
      failure: "GitHub session steering failed",
      now: receivedAt,
    });
    throw error;
  }
}
