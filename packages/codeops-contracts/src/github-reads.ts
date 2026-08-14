import { z } from "zod";

const repository = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const issueNumber = z.number().int().positive().max(2_147_483_647);
const branch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      value !== "HEAD" &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !/[\x00-\x20\x7f~^:?*[\\]/.test(value) &&
      !value.split("/").some(
        (part) =>
          part === "" ||
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      ),
    "GitHub branch name is invalid",
  );
const boundedRead = z.number().int().positive().max(200_000).default(100_000);
const timestamp = z.string().datetime({ offset: true });
const webUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === ""
    );
  }, "GitHub result URL must use the exact HTTPS origin");
const externalDetailsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
    );
  }, "GitHub check details URL must use HTTPS without credentials");

function repositoryPath(value: string): string {
  return `/${value.split("/").map(encodeURIComponent).join("/")}`;
}

export const githubPullRequestGetInputSchema = z
  .object({ repository, pullRequestNumber: issueNumber })
  .strict();

export const githubPullRequestDiffInputSchema = z
  .object({
    repository,
    pullRequestNumber: issueNumber,
    expectedHeadSha: gitSha,
    maxBytes: boundedRead.default(200_000),
  })
  .strict();

export const githubReviewThreadsInputSchema = z
  .object({
    repository,
    pullRequestNumber: issueNumber,
    expectedHeadSha: gitSha,
    limit: z.number().int().positive().max(100).default(100),
  })
  .strict();

export const githubChecksInputSchema = z
  .object({ repository, headSha: gitSha })
  .strict();

export const githubCheckLogsInputSchema = z
  .object({
    repository,
    headSha: gitSha,
    checkRunId: positiveId,
    maxBytes: boundedRead.default(200_000),
  })
  .strict();

export const githubProtectedBranchInputSchema = z
  .object({ repository, branch })
  .strict();

export const githubSearchInputSchema = z
  .object({
    repository,
    kind: z.enum(["issues", "pull_requests"]),
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(50).default(20),
  })
  .strict();

export const githubPullRequestSnapshotSchema = z
  .object({
    version: z.literal("codeops.github-pull-request-snapshot/v1"),
    repository,
    pullRequestNumber: issueNumber,
    title: z.string().max(500),
    body: z.string().max(50_000),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    draft: z.boolean(),
    authorLogin: z.string().min(1).max(100).nullable(),
    baseBranch: branch,
    baseSha: gitSha,
    headBranch: branch,
    headSha: gitSha,
    updatedAt: timestamp,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ merged, state }) => !merged || state === "closed",
    "a merged pull request must be closed",
  )
  .refine(
    ({ pullRequestNumber, repository, url }) =>
      new URL(url).pathname ===
      `${repositoryPath(repository)}/pull/${pullRequestNumber}`,
    "GitHub pull-request URL identity is inconsistent",
  );

const boundedTextShape = {
  repository,
  headSha: gitSha,
  content: z.string().max(200_000),
  contentBytes: z.number().int().nonnegative().max(200_000),
  sourceBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
} as const;

function refineBoundedText(
  value: {
    readonly content: string;
    readonly contentBytes: number;
    readonly sourceBytes: number;
    readonly truncated: boolean;
  },
  context: z.RefinementCtx,
): void {
  if (new TextEncoder().encode(value.content).byteLength !== value.contentBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounded GitHub content byte count is invalid",
    });
  }
  if (value.contentBytes > value.sourceBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounded GitHub content cannot exceed its source",
    });
  }
  if (value.truncated !== (value.contentBytes < value.sourceBytes)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounded GitHub truncation metadata is inconsistent",
    });
  }
}

export const githubPullRequestDiffResultSchema = z
  .object({
    version: z.literal("codeops.github-pull-request-diff-result/v1"),
    ...boundedTextShape,
    pullRequestNumber: issueNumber,
  })
  .strict()
  .superRefine(refineBoundedText);

export const githubReviewThreadCommentSchema = z
  .object({
    commentId: positiveId,
    authorLogin: z.string().min(1).max(100).nullable(),
    body: z.string().max(20_000),
    createdAt: timestamp,
    url: webUrl,
  })
  .strict();

export const githubReviewThreadSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    resolved: z.boolean(),
    path: z.string().min(1).max(1_024).nullable(),
    line: z.number().int().positive().nullable(),
    originalLine: z.number().int().positive().nullable(),
    comments: z.array(githubReviewThreadCommentSchema).min(1).max(100),
  })
  .strict();

export const githubReviewThreadsResultSchema = z
  .object({
    version: z.literal("codeops.github-review-threads-result/v1"),
    repository,
    pullRequestNumber: issueNumber,
    headSha: gitSha,
    threads: z.array(githubReviewThreadSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export const githubCheckRunSchema = z
  .object({
    checkRunId: positiveId,
    name: z.string().min(1).max(500),
    status: z.enum([
      "queued",
      "in_progress",
      "completed",
      "waiting",
      "requested",
      "pending",
    ]),
    conclusion: z
      .enum([
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "startup_failure",
        "stale",
      ])
      .nullable(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    detailsUrl: externalDetailsUrl.nullable(),
  })
  .strict()
  .refine(
    ({ conclusion, status }) =>
      status === "completed" ? conclusion !== null : conclusion === null,
    "GitHub check conclusion must match completion state",
  );

export const githubChecksResultSchema = z
  .object({
    version: z.literal("codeops.github-checks-result/v1"),
    repository,
    headSha: gitSha,
    checks: z.array(githubCheckRunSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export const githubCheckLogsResultSchema = z
  .object({
    version: z.literal("codeops.github-check-logs-result/v1"),
    ...boundedTextShape,
    checkRunId: positiveId,
  })
  .strict()
  .superRefine(refineBoundedText);

export const githubProtectedBranchResultSchema = z
  .object({
    version: z.literal("codeops.github-protected-branch-result/v1"),
    repository,
    branch,
    headSha: gitSha,
    protected: z.literal(true),
  })
  .strict();

export const githubSearchItemSchema = z
  .object({
    kind: z.enum(["issue", "pull_request"]),
    number: issueNumber,
    title: z.string().max(500),
    excerpt: z.string().max(2_000),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().nullable(),
    authorLogin: z.string().min(1).max(100).nullable(),
    updatedAt: timestamp,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ draft, kind }) =>
      kind === "pull_request" ? draft !== null : draft === null,
    "GitHub draft state must match the search result kind",
  );

export const githubSearchResultSchema = z
  .object({
    version: z.literal("codeops.github-search-result/v1"),
    repository,
    kind: z.enum(["issues", "pull_requests"]),
    query: z.string().max(500),
    items: z.array(githubSearchItemSchema).max(50),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine(({ items, kind, repository }, context) => {
    const expectedKind = kind === "issues" ? "issue" : "pull_request";
    for (const [index, item] of items.entries()) {
      if (item.kind !== expectedKind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "kind"],
          message: "GitHub search result kind is inconsistent",
        });
      }
      const collection = item.kind === "issue" ? "issues" : "pull";
      if (
        new URL(item.url).pathname !==
        `${repositoryPath(repository)}/${collection}/${item.number}`
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "url"],
          message: "GitHub search result URL identity is inconsistent",
        });
      }
    }
  });

export type GitHubPullRequestGetInput = z.infer<
  typeof githubPullRequestGetInputSchema
>;
export type GitHubPullRequestDiffInput = z.infer<
  typeof githubPullRequestDiffInputSchema
>;
export type GitHubReviewThreadsInput = z.infer<
  typeof githubReviewThreadsInputSchema
>;
export type GitHubChecksInput = z.infer<typeof githubChecksInputSchema>;
export type GitHubCheckLogsInput = z.infer<typeof githubCheckLogsInputSchema>;
export type GitHubProtectedBranchInput = z.infer<
  typeof githubProtectedBranchInputSchema
>;
export type GitHubSearchInput = z.infer<typeof githubSearchInputSchema>;
export type GitHubPullRequestSnapshot = z.infer<
  typeof githubPullRequestSnapshotSchema
>;
export type GitHubPullRequestDiffResult = z.infer<
  typeof githubPullRequestDiffResultSchema
>;
export type GitHubReviewThreadsResult = z.infer<
  typeof githubReviewThreadsResultSchema
>;
export type GitHubChecksResult = z.infer<typeof githubChecksResultSchema>;
export type GitHubCheckLogsResult = z.infer<
  typeof githubCheckLogsResultSchema
>;
export type GitHubProtectedBranchResult = z.infer<
  typeof githubProtectedBranchResultSchema
>;
export type GitHubSearchResult = z.infer<typeof githubSearchResultSchema>;
