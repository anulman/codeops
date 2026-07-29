import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const workflowRunIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoDateTime = z.string().datetime({ offset: true });
const safeText = (maximum: number) => z.string().min(1).max(maximum);
const repositoryPath = z
  .string()
  .min(1)
  .max(500)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9.$_/-]+$/);
const agentCheckpointUri = z
  .string()
  .regex(/^artifact:\/\/\/agent-runs\/[a-z0-9-]+\/checkpoint\.json$/);

const adversarialReviewCategorySchema = z.enum([
  "unused-code",
  "maintainability",
  "user-facing-behavior",
  "security",
]);

const adversarialReviewLensSchema = z
  .object({
    status: z.enum(["clear", "finding"]),
    summary: safeText(2_000),
  })
  .strict();

const adversarialReviewFindingSchema = z
  .object({
    id: identifier,
    category: adversarialReviewCategorySchema,
    severity: z.enum(["critical", "high", "medium", "low"]),
    path: repositoryPath,
    lineStart: z.number().int().positive().max(10_000_000).optional(),
    lineEnd: z.number().int().positive().max(10_000_000).optional(),
    problem: safeText(4_000),
    impact: safeText(4_000),
    recommendation: safeText(4_000),
    resolution: z.enum(["must-fix", "accepted-tradeoff", "not-actionable"]),
    justification: safeText(2_000).optional(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      finding.lineStart !== undefined &&
      finding.lineEnd !== undefined &&
      finding.lineEnd < finding.lineStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "review finding lineEnd cannot precede lineStart",
      });
    }
    if (
      finding.resolution !== "must-fix" &&
      finding.justification === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["justification"],
        message: "non-fix review findings require an explicit justification",
      });
    }
    if (
      ["critical", "high"].includes(finding.severity) &&
      finding.resolution !== "must-fix"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "critical and high review findings cannot be accepted or dismissed",
      });
    }
  });

export const adversarialReviewSchema = z
  .object({
    version: z.literal("codeops.adversarial-review/v1"),
    workflowId: workflowRunIdentifier,
    workItemId: identifier,
    baseSha: gitSha,
    reviewerId: identifier,
    reviewedAt: isoDateTime,
    checkpoint: z
      .object({
        uri: agentCheckpointUri,
        digest: sha256Digest,
        sizeBytes: z.number().int().positive().max(25_000_000),
      })
      .strict(),
    lenses: z
      .object({
        unusedCode: adversarialReviewLensSchema,
        maintainability: adversarialReviewLensSchema,
        userFacingBehavior: adversarialReviewLensSchema,
        security: adversarialReviewLensSchema,
      })
      .strict(),
    findings: z.array(adversarialReviewFindingSchema).max(50),
    verdict: z.enum(["pass", "revision-required"]),
    summary: safeText(2_000),
  })
  .strict()
  .superRefine((review, context) => {
    const ids = review.findings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "adversarial review finding IDs must be unique",
      });
    }
    const lensCategories = {
      unusedCode: "unused-code",
      maintainability: "maintainability",
      userFacingBehavior: "user-facing-behavior",
      security: "security",
    } as const;
    for (const lens of Object.keys(lensCategories) as (keyof typeof lensCategories)[]) {
      const category = lensCategories[lens];
      const hasFinding = review.findings.some(
        (finding) => finding.category === category,
      );
      if ((review.lenses[lens].status === "finding") !== hasFinding) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lenses", lens, "status"],
          message: "review lens status must match its structured findings",
        });
      }
    }
    const requiresRevision = review.findings.some(
      (finding) => finding.resolution === "must-fix",
    );
    if ((review.verdict === "revision-required") !== requiresRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: "review verdict must fail closed on every unresolved finding",
      });
    }
  });

export type AdversarialReview = z.infer<typeof adversarialReviewSchema>;
