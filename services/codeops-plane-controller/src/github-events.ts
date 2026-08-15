import { createHmac, timingSafeEqual } from "node:crypto";
import {
  githubPullRequestStackPositionSchema,
  type GitHubPullRequestStackPosition,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const githubActorSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9]|[A-Za-z0-9-]{0,92}\[bot\])?$/),
    type: z.enum(["User", "Bot"]),
  })
  .passthrough();

const githubWebhookRepositorySchema = z
  .object({
    repository: z
      .object({
        full_name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
      })
      .passthrough(),
  })
  .passthrough();

const pullRequestEventSchema = z
  .object({
    action: z.enum([
      "closed",
      "reopened",
      "synchronize",
      "edited",
      "converted_to_draft",
      "ready_for_review",
    ]),
    repository: z
      .object({
        full_name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive().max(10_000_000),
        title: z.string().min(1).max(1_000),
        html_url: z.string().url().max(2_000),
        updated_at: z.string().datetime({ offset: true }),
        merged: z.boolean(),
        head: z
          .object({
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            ref: z.string().min(1).max(200),
          })
          .passthrough(),
        base: z
          .object({
            ref: z.string().min(1).max(200),
            sha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .passthrough(),
        stack: githubPullRequestStackPositionSchema.nullable().optional(),
      })
      .passthrough(),
    sender: githubActorSchema,
  })
  .passthrough();

const pullRequestReviewEventSchema = z
  .object({
    action: z.literal("submitted"),
    repository: z
      .object({
        full_name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive().max(10_000_000),
        head: z
          .object({
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            ref: z.string().min(1).max(200),
          })
          .passthrough(),
        base: z
          .object({
            ref: z.string().min(1).max(200),
            sha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .passthrough(),
        stack: githubPullRequestStackPositionSchema.nullable().optional(),
      })
      .passthrough(),
    review: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        body: z.string().max(65_536).nullable(),
        commit_id: z.string().regex(/^[0-9a-f]{40}$/),
        state: z.enum(["changes_requested", "commented", "approved"]),
        submitted_at: z.string().datetime({ offset: true }),
        user: githubActorSchema,
      })
      .passthrough(),
  })
  .passthrough();

const issueCommentEventSchema = z
  .object({
    action: z.enum(["created", "edited"]),
    repository: z
      .object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      })
      .passthrough(),
    issue: z
      .object({
        number: z.number().int().positive().max(10_000_000),
        title: z.string().min(1).max(1_000),
        state: z.enum(["open", "closed"]),
        pull_request: z.object({ url: z.string().url().max(2_000) }).passthrough(),
      })
      .passthrough(),
    comment: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        body: z.string().min(1).max(65_536),
        html_url: z.string().url().max(2_000),
        created_at: z.string().datetime({ offset: true }),
        updated_at: z.string().datetime({ offset: true }),
        user: githubActorSchema,
      })
      .passthrough(),
  })
  .passthrough();

const pullRequestReviewCommentEventSchema = z
  .object({
    action: z.enum(["created", "edited"]),
    repository: z
      .object({
        full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive().max(10_000_000),
        title: z.string().min(1).max(1_000),
        state: z.enum(["open", "closed"]),
        head: z
          .object({
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            ref: z.string().min(1).max(200),
          })
          .passthrough(),
        base: z
          .object({
            ref: z.string().min(1).max(200),
            sha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .passthrough(),
      })
      .passthrough(),
    comment: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        pull_request_review_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        body: z.string().min(1).max(65_536),
        html_url: z.string().url().max(2_000),
        path: z.string().min(1).max(1_000),
        line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        side: z.enum(["LEFT", "RIGHT"]).nullable(),
        commit_id: z.string().regex(/^[0-9a-f]{40}$/),
        created_at: z.string().datetime({ offset: true }),
        updated_at: z.string().datetime({ offset: true }),
        user: githubActorSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubPullRequestEvent = Readonly<{
  kind: "pull_request";
  repository: string;
  number: number;
  action:
    | "closed"
    | "reopened"
    | "synchronize"
    | "edited"
    | "converted_to_draft"
    | "ready_for_review";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  stack: GitHubPullRequestStackPosition | null;
  title: string;
  url: string;
  actorId: number;
  actorLogin: string;
  actorType: "User" | "Bot";
  updatedAt: string;
}>;

export type GitHubPullRequestReviewEvent = Readonly<{
  kind: "pull_request_review";
  repository: string;
  number: number;
  action: "submitted";
  reviewId: number;
  state: "changes_requested" | "commented" | "approved";
  body: string;
  reviewerId: number;
  reviewerLogin: string;
  reviewerType: "User" | "Bot";
  reviewedHeadSha: string;
  currentHeadSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  stack: GitHubPullRequestStackPosition | null;
  submittedAt: string;
}>;

export type GitHubIssueCommentEvent = Readonly<{
  kind: "issue_comment";
  repository: string;
  number: number;
  action: "created" | "edited";
  title: string;
  pullRequestState: "open" | "closed";
  commentId: number;
  body: string;
  url: string;
  actorId: number;
  actorLogin: string;
  actorType: "User" | "Bot";
  createdAt: string;
  updatedAt: string;
}>;

export type GitHubPullRequestReviewCommentEvent = Readonly<{
  kind: "pull_request_review_comment";
  repository: string;
  number: number;
  action: "created" | "edited";
  title: string;
  pullRequestState: "open" | "closed";
  reviewId: number;
  commentId: number;
  body: string;
  url: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  commentHeadSha: string;
  currentHeadSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  actorId: number;
  actorLogin: string;
  actorType: "User" | "Bot";
  createdAt: string;
  updatedAt: string;
}>;

export type GitHubEvent =
  | GitHubPullRequestEvent
  | GitHubPullRequestReviewEvent
  | GitHubIssueCommentEvent
  | GitHubPullRequestReviewCommentEvent;

export function verifyGitHubWebhookSignature(input: {
  rawBody: Buffer;
  secret: string;
  signature: string;
}): boolean {
  if (input.secret.length < 32 || input.secret.length > 4_096) {
    throw new Error("GitHub webhook secret is invalid");
  }
  if (!/^sha256=[0-9a-f]{64}$/.test(input.signature)) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`,
  );
  const received = Buffer.from(input.signature);
  return (
    expected.length === received.length &&
    timingSafeEqual(expected, received)
  );
}

export function parseGitHubWebhookRepository(rawBody: Buffer): string {
  return githubWebhookRepositorySchema.parse(
    JSON.parse(rawBody.toString("utf8")) as unknown,
  ).repository.full_name;
}

export function parseGitHubEvent(input: {
  rawBody: Buffer;
  event: string;
}): GitHubEvent | null {
  const parsed = JSON.parse(input.rawBody.toString("utf8")) as unknown;
  if (input.event === "pull_request") {
    const payload = pullRequestEventSchema.parse(parsed);
    return {
      kind: "pull_request",
      repository: payload.repository.full_name,
      number: payload.pull_request.number,
      action: payload.action,
      merged: payload.pull_request.merged,
      headSha: payload.pull_request.head.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      baseSha: payload.pull_request.base.sha,
      stack: payload.pull_request.stack ?? null,
      title: payload.pull_request.title,
      url: payload.pull_request.html_url,
      actorId: payload.sender.id,
      actorLogin: payload.sender.login,
      actorType: payload.sender.type,
      updatedAt: payload.pull_request.updated_at,
    };
  }
  if (input.event === "pull_request_review") {
    const payload = pullRequestReviewEventSchema.parse(parsed);
    return {
      kind: "pull_request_review",
      repository: payload.repository.full_name,
      number: payload.pull_request.number,
      action: payload.action,
      reviewId: payload.review.id,
      state: payload.review.state,
      body: payload.review.body ?? "",
      reviewerId: payload.review.user.id,
      reviewerLogin: payload.review.user.login,
      reviewerType: payload.review.user.type,
      reviewedHeadSha: payload.review.commit_id,
      currentHeadSha: payload.pull_request.head.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      baseSha: payload.pull_request.base.sha,
      stack: payload.pull_request.stack ?? null,
      submittedAt: payload.review.submitted_at,
    };
  }
  if (input.event === "issue_comment") {
    const payload = issueCommentEventSchema.parse(parsed);
    return {
      kind: "issue_comment",
      repository: payload.repository.full_name,
      number: payload.issue.number,
      action: payload.action,
      title: payload.issue.title,
      pullRequestState: payload.issue.state,
      commentId: payload.comment.id,
      body: payload.comment.body,
      url: payload.comment.html_url,
      actorId: payload.comment.user.id,
      actorLogin: payload.comment.user.login,
      actorType: payload.comment.user.type,
      createdAt: payload.comment.created_at,
      updatedAt: payload.comment.updated_at,
    };
  }
  if (input.event === "pull_request_review_comment") {
    const payload = pullRequestReviewCommentEventSchema.parse(parsed);
    return {
      kind: "pull_request_review_comment",
      repository: payload.repository.full_name,
      number: payload.pull_request.number,
      action: payload.action,
      title: payload.pull_request.title,
      pullRequestState: payload.pull_request.state,
      reviewId: payload.comment.pull_request_review_id,
      commentId: payload.comment.id,
      body: payload.comment.body,
      url: payload.comment.html_url,
      path: payload.comment.path,
      line: payload.comment.line,
      side: payload.comment.side,
      commentHeadSha: payload.comment.commit_id,
      currentHeadSha: payload.pull_request.head.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      baseSha: payload.pull_request.base.sha,
      actorId: payload.comment.user.id,
      actorLogin: payload.comment.user.login,
      actorType: payload.comment.user.type,
      createdAt: payload.comment.created_at,
      updatedAt: payload.comment.updated_at,
    };
  }
  return null;
}

export function parseGitHubPullRequestEvent(input: {
  rawBody: Buffer;
  event: string;
}): GitHubPullRequestEvent | null {
  const event = parseGitHubEvent(input);
  return event?.kind === "pull_request" ? event : null;
}
