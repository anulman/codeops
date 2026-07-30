import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const pullRequestEventSchema = z
  .object({
    action: z.enum(["closed", "reopened", "synchronize"]),
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
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubPullRequestEvent = Readonly<{
  repository: string;
  number: number;
  action: "closed" | "reopened" | "synchronize";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
}>;

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

export function parseGitHubPullRequestEvent(input: {
  rawBody: Buffer;
  event: string;
}): GitHubPullRequestEvent | null {
  if (input.event !== "pull_request") return null;
  const payload = pullRequestEventSchema.parse(
    JSON.parse(input.rawBody.toString("utf8")) as unknown,
  );
  return {
    repository: payload.repository.full_name,
    number: payload.pull_request.number,
    action: payload.action,
    merged: payload.pull_request.merged,
    headSha: payload.pull_request.head.sha,
    headRef: payload.pull_request.head.ref,
    baseRef: payload.pull_request.base.ref,
  };
}
