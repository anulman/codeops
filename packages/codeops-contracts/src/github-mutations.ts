import { z } from "zod";

const repository = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const pullRequestNumber = z.number().int().positive().max(2_147_483_647);
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const operationId = z.string().regex(/^githubmutation-[0-9a-f]{64}$/);
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

export const githubPullRequestUpdateBranchInputSchema = z
  .object({
    repository,
    pullRequestNumber,
    expectedHeadSha: gitSha,
  })
  .strict();

export const githubPullRequestUpdateInputSchema = z
  .object({
    repository,
    pullRequestNumber,
    expectedHeadSha: gitSha,
    expectedBaseSha: gitSha,
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().max(50_000).optional(),
    baseBranch: branch.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.body !== undefined ||
      input.baseBranch !== undefined,
    "GitHub pull-request update must change at least one bounded field",
  );

export const githubReviewThreadReplyInputSchema = z
  .object({
    repository,
    pullRequestNumber,
    expectedHeadSha: gitSha,
    threadId: z.string().min(1).max(256),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const githubCheckRerunInputSchema = z
  .object({
    repository,
    expectedHeadSha: gitSha,
    checkRunId: positiveId,
  })
  .strict();

export const githubMutationOperationSchema = z.enum([
  "pull_request_update_branch",
  "pull_request_update",
  "review_thread_reply",
  "check_rerun",
]);

const runtimeMutationBase = z.object({
  version: z.literal("codeops.session-runtime-github-mutation-request/v1"),
  claimToken: uuid,
  operationId,
});

const providerMutationBase = z.object({
  version: z.literal("codeops.github-mutation-provider-request/v1"),
  operationId,
  payloadDigest: sha256Digest,
  permissionDigest: sha256Digest,
  provenance: z
    .object({
      sessionId: z.string().min(1).max(128),
      dispatchId: uuid,
      principalDigest: sha256Digest,
    })
    .strict(),
});

function mutationRequestBranches<T extends z.ZodRawShape>(base: z.ZodObject<T>) {
  return [
    base.extend({
      operation: z.literal("pull_request_update_branch"),
      input: githubPullRequestUpdateBranchInputSchema,
    }).strict(),
    base.extend({
      operation: z.literal("pull_request_update"),
      input: githubPullRequestUpdateInputSchema,
    }).strict(),
    base.extend({
      operation: z.literal("review_thread_reply"),
      input: githubReviewThreadReplyInputSchema,
    }).strict(),
    base.extend({
      operation: z.literal("check_rerun"),
      input: githubCheckRerunInputSchema,
    }).strict(),
  ] as const;
}

export const sessionRuntimeGitHubMutationRequestSchema = z.discriminatedUnion(
  "operation",
  mutationRequestBranches(runtimeMutationBase),
);

export const githubMutationProviderRequestSchema = z.discriminatedUnion(
  "operation",
  mutationRequestBranches(providerMutationBase),
);

const resultBase = { repository, operationId } as const;

export const githubPullRequestUpdateBranchResultSchema = z
  .object({
    version: z.literal("codeops.github-pull-request-update-branch-result/v1"),
    ...resultBase,
    pullRequestNumber,
    previousHeadSha: gitSha,
    headSha: gitSha,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ previousHeadSha, headSha }) => previousHeadSha !== headSha,
    "GitHub update-branch result must advance the pull-request head",
  )
  .refine(
    ({ pullRequestNumber: number, repository: repo, url }) =>
      new URL(url).pathname === `/${repo}/pull/${number}`,
    "GitHub pull-request URL identity is inconsistent",
  );

export const githubPullRequestUpdateResultSchema = z
  .object({
    version: z.literal("codeops.github-pull-request-update-result/v1"),
    ...resultBase,
    pullRequestNumber,
    headSha: gitSha,
    baseSha: gitSha,
    title: z.string().max(500),
    body: z.string().max(50_000),
    baseBranch: branch,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ pullRequestNumber: number, repository: repo, url }) =>
      new URL(url).pathname === `/${repo}/pull/${number}`,
    "GitHub pull-request URL identity is inconsistent",
  );

export const githubReviewThreadReplyResultSchema = z
  .object({
    version: z.literal("codeops.github-review-thread-reply-result/v1"),
    ...resultBase,
    pullRequestNumber,
    headSha: gitSha,
    threadId: z.string().min(1).max(256),
    commentId: positiveId,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ pullRequestNumber: number, repository: repo, url }) =>
      new URL(url).pathname.startsWith(`/${repo}/pull/${number}`),
    "GitHub review-reply URL identity is inconsistent",
  );

export const githubCheckRerunResultSchema = z
  .object({
    version: z.literal("codeops.github-check-rerun-result/v1"),
    ...resultBase,
    headSha: gitSha,
    checkRunId: positiveId,
    accepted: z.literal(true),
  })
  .strict();

export const githubMutationResultSchema = z.union([
  githubPullRequestUpdateBranchResultSchema,
  githubPullRequestUpdateResultSchema,
  githubReviewThreadReplyResultSchema,
  githubCheckRerunResultSchema,
]);

export type GitHubMutationOperation = z.infer<
  typeof githubMutationOperationSchema
>;
export type SessionRuntimeGitHubMutationRequest = z.infer<
  typeof sessionRuntimeGitHubMutationRequestSchema
>;
export type GitHubMutationProviderRequest = z.infer<
  typeof githubMutationProviderRequestSchema
>;
export type GitHubMutationResult = z.infer<typeof githubMutationResultSchema>;
