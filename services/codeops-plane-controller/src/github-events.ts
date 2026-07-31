import { createHmac, timingSafeEqual } from "node:crypto";
import {
  githubPullRequestStackPositionSchema,
  type GitHubPullRequestStackPosition,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";

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
          })
          .passthrough(),
        stack: githubPullRequestStackPositionSchema.nullable().optional(),
      })
      .passthrough(),
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
        user: z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            login: z
              .string()
              .min(1)
              .max(100)
              .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/),
            type: z.literal("User"),
          })
          .passthrough(),
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
  stack: GitHubPullRequestStackPosition | null;
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
  reviewedHeadSha: string;
  currentHeadSha: string;
  headRef: string;
  baseRef: string;
  stack: GitHubPullRequestStackPosition | null;
  submittedAt: string;
}>;

export type GitHubEvent =
  | GitHubPullRequestEvent
  | GitHubPullRequestReviewEvent;

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
      stack: payload.pull_request.stack ?? null,
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
      reviewedHeadSha: payload.review.commit_id,
      currentHeadSha: payload.pull_request.head.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      stack: payload.pull_request.stack ?? null,
      submittedAt: payload.review.submitted_at,
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
