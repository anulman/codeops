import { createHash } from "node:crypto";
import {
  canonicalSerialize,
  codingRequestSchema,
  createProjectContext,
  githubReviewCommentSchema,
  humanReviewRequestSchema,
  type CodingRequest,
  type GitHubReviewComment,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";
import type { ResearchDedupLedger } from "./dedup-ledger.js";
import type { GitHubPullRequestReviewEvent } from "./github-events.js";
import type {
  PullRequestBindingStore,
  StoredPullRequestBinding,
} from "./pr-binding-store.js";

export type GitHubReviewReconciliationResult =
  | Readonly<{ status: "ignored"; reason: string }>
  | Readonly<{
      status: "revision-enqueued";
      workItemId: string;
      workflowId: string;
      duplicate: boolean;
    }>
  | Readonly<{
      status: "qualified";
      workItemId: string;
      projectId: string;
      duplicate: boolean;
    }>;

export function createHumanReviewCodingRequest(input: {
  source: CodingRequest;
  event: GitHubPullRequestReviewEvent;
  comments: readonly GitHubReviewComment[];
}): CodingRequest {
  const source = codingRequestSchema.parse(input.source);
  if (source.humanReview !== undefined) {
    throw new Error("human review revision must derive from an initial Ready request");
  }
  const repository = `${source.workItem.repository.owner}/${source.workItem.repository.name}`;
  if (
    input.event.repository !== repository ||
    input.event.reviewedHeadSha !== input.event.currentHeadSha
  ) {
    throw new Error("human review target does not match the exact current PR head");
  }
  const comments = z
    .array(githubReviewCommentSchema)
    .max(100)
    .parse([...input.comments])
    .sort((left, right) => left.id - right.id);
  const review = humanReviewRequestSchema.parse({
    version: "codeops.human-review-request/v1",
    repository,
    pullRequestNumber: input.event.number,
    reviewId: input.event.reviewId,
    reviewedHeadSha: input.event.reviewedHeadSha,
    headRef: input.event.headRef,
    baseRef: input.event.baseRef,
    reviewer: {
      id: input.event.reviewerId,
      login: input.event.reviewerLogin,
    },
    state: input.event.state,
    submittedAt: input.event.submittedAt,
    summary: input.event.body,
    comments,
  });
  const digest = createHash("sha256")
    .update(canonicalSerialize(review))
    .digest("hex");
  const workflowId = `review-${digest.slice(0, 57)}`;
  const {
    digest: _projectContextDigest,
    ...projectContextIdentity
  } = source.projectContext;
  const projectContext = createProjectContext({
    ...projectContextIdentity,
    baseSha: input.event.reviewedHeadSha,
  });
  return codingRequestSchema.parse({
    ...source,
    requestId: workflowId,
    eventId: `github-review:${input.event.reviewId}`,
    requestedBy: `github:${input.event.reviewerId}`,
    projectContext,
    researchDisposition: {
      mode: "skipped",
      rationale:
        "A human PR revision is bound to the exact reviewed head; earlier research evidence is not silently rebound to that revision.",
    },
    humanReview: review,
    workItem: {
      ...source.workItem,
      workflowId,
      runId: workflowId,
      baseSha: input.event.reviewedHeadSha,
      branch: input.event.headRef,
      requestedAt: input.event.submittedAt,
    },
    researchPacket: undefined,
  });
}

function eventDigest(input: {
  event: GitHubPullRequestReviewEvent;
  comments: readonly GitHubReviewComment[];
}): string {
  return `sha256:${createHash("sha256")
    .update(canonicalSerialize(input))
    .digest("hex")}`;
}

export async function reconcileGitHubPullRequestReviewEvent(input: {
  event: GitHubPullRequestReviewEvent;
  receivedAt: string;
  allowedReviewerIds: ReadonlySet<number>;
  bindings: PullRequestBindingStore;
  ledger: ResearchDedupLedger;
  loadComments: (input: {
    repository: string;
    number: number;
    reviewId: number;
  }) => Promise<readonly GitHubReviewComment[]>;
  loadInitialRequest: (workItemId: string) => Promise<CodingRequest | null>;
  enqueueRevision: (input: {
    binding: StoredPullRequestBinding;
    request: CodingRequest;
  }) => Promise<"enqueued" | "already-enqueued">;
  beginRevision: (input: {
    binding: StoredPullRequestBinding;
    event: GitHubPullRequestReviewEvent;
  }) => Promise<void>;
  qualify: (input: {
    binding: StoredPullRequestBinding;
    event: GitHubPullRequestReviewEvent;
  }) => Promise<boolean>;
  reevaluateProject: (input: {
    workspaceId: string;
    projectId: string;
  }) => Promise<void>;
}): Promise<GitHubReviewReconciliationResult> {
  const receivedAt = z.string().datetime({ offset: true }).parse(input.receivedAt);
  if (
    input.event.reviewerType !== "User" ||
    !input.allowedReviewerIds.has(input.event.reviewerId)
  ) {
    return { status: "ignored", reason: "reviewer-is-not-allowlisted" };
  }
  const binding = await input.bindings.getByPullRequest({
    repository: input.event.repository,
    number: input.event.number,
  });
  if (binding === null) {
    return { status: "ignored", reason: "pull-request-is-not-bound" };
  }
  if (
    binding.state !== "open" ||
    binding.headSha !== input.event.currentHeadSha ||
    binding.headSha !== input.event.reviewedHeadSha ||
    binding.headRef !== input.event.headRef ||
    binding.baseRef !== input.event.baseRef ||
    (binding.nativeStack === undefined
      ? (input.event.stack ?? null) !== null
      : !binding.nativeStack.active ||
        (input.event.stack ?? null) === null ||
        binding.nativeStack.number !== input.event.stack!.number ||
        binding.nativeStack.position !== input.event.stack!.position ||
        binding.nativeStack.base.ref !== input.event.stack!.base.ref ||
        input.event.stack!.size < binding.nativeStack.size)
  ) {
    return { status: "ignored", reason: "review-does-not-match-bound-current-head" };
  }

  const comments =
    input.event.state === "approved"
      ? []
      : await input.loadComments({
          repository: input.event.repository,
          number: input.event.number,
          reviewId: input.event.reviewId,
        });
  if (
    input.event.state === "commented" &&
    input.event.body.trim().length === 0 &&
    comments.length === 0
  ) {
    return { status: "ignored", reason: "commented-review-has-no-requests" };
  }

  const stableId = `github-review:${input.event.reviewId}`;
  const claim = await input.ledger.claim({
    kind: "event",
    stableId,
    payloadDigest: eventDigest({ event: input.event, comments }),
    now: receivedAt,
  });
  if (claim.status === "busy") {
    throw new Error("GitHub review event is already processing");
  }
  if (claim.status === "complete") {
    return input.event.state === "approved"
      ? {
          status: "qualified",
          workItemId: binding.workItemId,
          projectId: binding.projectId,
          duplicate: true,
        }
      : {
          status: "revision-enqueued",
          workItemId: binding.workItemId,
          workflowId:
            claim.resultId ??
            (() => {
              throw new Error("completed review revision omitted workflow identity");
            })(),
          duplicate: true,
        };
  }

  try {
    if (input.event.state === "approved") {
      if (!(await input.qualify({ binding, event: input.event }))) {
        throw new Error("approved PR head has not passed required qualification");
      }
      await input.bindings.put({
        ...binding,
        qualified: true,
        updatedAt: receivedAt,
      });
      await input.reevaluateProject({
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
      });
      await input.ledger.complete({
        claim,
        outcome: "ignored",
        resultId: binding.workItemId,
        now: receivedAt,
      });
      return {
        status: "qualified",
        workItemId: binding.workItemId,
        projectId: binding.projectId,
        duplicate: false,
      };
    }

    const source = await input.loadInitialRequest(binding.workItemId);
    if (source === null) {
      throw new Error("bound PR has no durable initial coding request");
    }
    const request = createHumanReviewCodingRequest({
      source,
      event: input.event,
      comments,
    });
    await input.bindings.put({
      ...binding,
      qualified: false,
      updatedAt: receivedAt,
    });
    await input.beginRevision({ binding, event: input.event });
    await input.reevaluateProject({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
    });
    const enqueueResult = await input.enqueueRevision({ binding, request });
    await input.ledger.complete({
      claim,
      outcome: "request-enqueued",
      resultId: request.requestId,
      now: receivedAt,
    });
    return {
      status: "revision-enqueued",
      workItemId: binding.workItemId,
      workflowId: request.requestId,
      duplicate: enqueueResult === "already-enqueued",
    };
  } catch (error) {
    await input.ledger.fail({
      claim,
      failure: "GitHub review reconciliation failed",
      now: receivedAt,
    });
    throw error;
  }
}
