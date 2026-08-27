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
const repositoryPath = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "GitHub repository path is invalid",
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

export const githubBranchPublishInputSchema = z
  .object({
    repository,
    mode: z.enum(["create", "fast_forward"]).optional(),
    expectedHeadSha: gitSha.describe("Admitted base-branch snapshot checked during publication preflight; not the atomic target-ref fence for fast-forward publication"),
    expectedBranchHeadSha: gitSha.optional(),
    expectedBranchHeadEffectId: operationId.optional(),
    baseBranch: branch,
    branchName: branch,
    commitMessage: z.string().trim().min(1).max(500),
    changes: z.array(z.object({
      path: repositoryPath,
      oldText: z.string().max(100_000),
      newText: z.string().max(100_000),
    }).strict().superRefine((change, context) => {
      if (change.oldText.length === 0 && change.newText.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A new published file must not be empty",
          path: ["newText"],
        });
      }
    })).min(1).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === "fast_forward" && input.expectedBranchHeadSha === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Fast-forward publication requires the expected branch head", path: ["expectedBranchHeadSha"] });
    }
    if (input.mode === "fast_forward" && input.expectedBranchHeadEffectId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Fast-forward publication requires prior provider-effect evidence", path: ["expectedBranchHeadEffectId"] });
    }
    if (input.mode !== "fast_forward" && input.expectedBranchHeadSha !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Create publication must not bind an existing branch head", path: ["expectedBranchHeadSha"] });
    }
    if (input.mode !== "fast_forward" && input.expectedBranchHeadEffectId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Create publication must not claim prior provider-effect evidence", path: ["expectedBranchHeadEffectId"] });
    }
    if (input.baseBranch === input.branchName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Published branch must differ from its base branch",
        path: ["branchName"],
      });
    }
    if (new Set(input.changes.map(({ path }) => path)).size !== input.changes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Published branch changes must use unique paths",
        path: ["changes"],
      });
    }
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 40_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Published branch input exceeds 40000 bytes",
        path: ["changes"],
      });
    }
  });

export const githubPullRequestCreateInputSchema = z
  .object({
    repository,
    expectedHeadSha: gitSha,
    expectedBaseSha: gitSha,
    headBranch: branch,
    baseBranch: branch,
    title: z.string().trim().min(1).max(500),
    body: z.string().max(50_000),
    draft: z.boolean(),
  })
  .strict()
  .refine(
    (input) => input.headBranch !== input.baseBranch,
    "Pull-request head and base branches must differ",
  );

export const githubMutationOperationSchema = z.enum([
  "branch_publish",
  "pull_request_create",
  "pull_request_update_branch",
  "pull_request_update",
  "review_thread_reply",
  "check_rerun",
]);

export const providerEffectStateSchema = z.enum([
  "authorized",
  "attempting",
  "succeeded",
  "failed",
  "unknown",
  "reconciled_satisfied",
  "reconciled_not_observed",
  "operator_resolved",
]);

export const providerEffectReconciliationActionSchema = z.enum([
  "none",
  "inspect_branch_commit",
  "search_pull_request_marker",
  "inspect_pull_request",
  "search_review_thread_marker",
  "compare_pull_request_head",
  "inspect_check_attempts",
  "operator_review",
]);

const isoDateTime = z.string().datetime({ offset: true });

export const providerEffectReceiptSchema = z
  .object({
    version: z.literal("codeops.provider-effect-receipt/v1"),
    effectId: operationId,
    provider: z.literal("github"),
    repository,
    operation: githubMutationOperationSchema,
    pullRequestNumber: pullRequestNumber.nullable(),
    targetId: z.string().min(1).max(256).nullable(),
    expectedHeadSha: gitSha,
    payloadDigest: sha256Digest,
    permissionDigest: sha256Digest,
    sessionId: z.string().min(1).max(128),
    dispatchId: uuid,
    state: providerEffectStateSchema,
    authorizedAt: isoDateTime,
    attemptedAt: isoDateTime.nullable(),
    resolvedAt: isoDateTime.nullable(),
    reconciliationAction: providerEffectReconciliationActionSchema,
    resolutionSummary: z.string().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const terminal = [
      "succeeded",
      "failed",
      "reconciled_satisfied",
      "reconciled_not_observed",
      "operator_resolved",
    ].includes(receipt.state);
    if (receipt.state === "authorized" && receipt.attemptedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorized provider effect cannot have an attempt time",
        path: ["attemptedAt"],
      });
    }
    if (receipt.state !== "authorized" && receipt.attemptedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attempted provider effect requires an attempt time",
        path: ["attemptedAt"],
      });
    }
    if (terminal !== (receipt.resolvedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "terminal provider effect requires one resolution time",
        path: ["resolvedAt"],
      });
    }
    if (terminal !== (receipt.resolutionSummary !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "terminal provider effect requires one bounded resolution summary",
        path: ["resolutionSummary"],
      });
    }
  });

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
      operation: z.literal("branch_publish"),
      input: githubBranchPublishInputSchema,
    }).strict(),
    base.extend({
      operation: z.literal("pull_request_create"),
      input: githubPullRequestCreateInputSchema,
    }).strict(),
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

export const githubMutationReconciliationProviderRequestSchema = z
  .object({
    version: z.literal("codeops.github-mutation-reconciliation-provider-request/v1"),
    request: githubMutationProviderRequestSchema,
    attemptedAt: isoDateTime,
  })
  .strict();

const resultBase = { repository, operationId } as const;

export const githubBranchPublishResultSchema = z
  .object({
    version: z.literal("codeops.github-branch-publish-result/v1"),
    ...resultBase,
    baseBranch: branch,
    branchName: branch,
    baseSha: gitSha,
    headSha: gitSha,
    url: webUrl,
  })
  .strict()
  .refine(
    ({ baseSha, headSha }) => baseSha !== headSha,
    "Published branch result must advance the base commit",
  );

export const githubPullRequestCreateResultSchema = z
  .object({
    version: z.literal("codeops.github-pull-request-create-result/v1"),
    ...resultBase,
    pullRequestNumber,
    headSha: gitSha,
    baseSha: gitSha,
    headBranch: branch,
    baseBranch: branch,
    title: z.string().max(500),
    body: z.string().max(50_000),
    draft: z.boolean(),
    url: webUrl,
  })
  .strict()
  .refine(
    ({ pullRequestNumber: number, repository: repo, url }) =>
      new URL(url).pathname === `/${repo}/pull/${number}`,
    "GitHub pull-request URL identity is inconsistent",
  );

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
  githubBranchPublishResultSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestUpdateBranchResultSchema,
  githubPullRequestUpdateResultSchema,
  githubReviewThreadReplyResultSchema,
  githubCheckRerunResultSchema,
]);

export const githubMutationReconciliationResultSchema = z.discriminatedUnion(
  "state",
  [
    z.object({
      version: z.literal("codeops.github-mutation-reconciliation-result/v1"),
      state: z.literal("reconciled_satisfied"),
      result: githubMutationResultSchema,
      summary: z.string().min(1).max(1_000),
    }).strict(),
    z.object({
      version: z.literal("codeops.github-mutation-reconciliation-result/v1"),
      state: z.enum(["reconciled_not_observed", "unknown"]),
      result: z.null(),
      summary: z.string().min(1).max(1_000),
    }).strict(),
  ],
);

export type GitHubMutationOperation = z.infer<
  typeof githubMutationOperationSchema
>;
export type ProviderEffectState = z.infer<typeof providerEffectStateSchema>;
export type ProviderEffectReceipt = z.infer<typeof providerEffectReceiptSchema>;
export type SessionRuntimeGitHubMutationRequest = z.infer<
  typeof sessionRuntimeGitHubMutationRequestSchema
>;
export type GitHubMutationProviderRequest = z.infer<
  typeof githubMutationProviderRequestSchema
>;
export type GitHubMutationResult = z.infer<typeof githubMutationResultSchema>;
export type GitHubMutationReconciliationProviderRequest = z.infer<
  typeof githubMutationReconciliationProviderRequestSchema
>;
export type GitHubMutationReconciliationResult = z.infer<
  typeof githubMutationReconciliationResultSchema
>;
