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
const agentArtifactUri = (fileName: "checkpoint.json" | "changes.patch") =>
  z
    .string()
    .regex(
      new RegExp(
        `^artifact:\\/\\/\\/agent-runs\\/[a-z0-9-]+\\/${fileName.replace(".", "\\.")}$`,
      ),
    );

const passingTestSchema = z
  .object({
    command: safeText(500),
    status: z.literal("passed"),
    summary: safeText(1_000),
  })
  .strict();

export const codingOutcomeSchema = z
  .object({
    version: z.literal("codeops.coding-outcome/v1"),
    summary: safeText(2_000),
    tests: z.array(passingTestSchema).min(1).max(20),
  })
  .strict();

export const candidateCheckpointSchema = z
  .object({
    round: z.number().int().min(1).max(4),
    runId: workflowRunIdentifier,
    checkpoint: z
      .object({
        uri: agentArtifactUri("checkpoint.json"),
        digest: sha256Digest,
        sizeBytes: z.number().int().positive().max(25_000_000),
      })
      .strict(),
    patch: z
      .object({
        uri: agentArtifactUri("changes.patch"),
        digest: sha256Digest,
        sizeBytes: z.number().int().nonnegative().max(2_000_000),
      })
      .strict(),
    codingOutcome: codingOutcomeSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    const expectedPrefix = `artifact:///agent-runs/${candidate.runId}/`;
    if (
      candidate.checkpoint.uri !== `${expectedPrefix}checkpoint.json` ||
      candidate.patch.uri !== `${expectedPrefix}changes.patch`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runId"],
        message: "candidate artifact URIs must match its exact coding run",
      });
    }
  });

const adversarialReviewCategorySchema = z.enum([
  "ticket-completion",
  "unused-code",
  "simplicity-maintainability",
  "existing-systems",
  "test-effectiveness",
  "user-facing-behavior",
  "security-privacy",
]);

const adversarialReviewLensSchema = z
  .object({
    status: z.enum(["clear", "finding"]),
    summary: safeText(1_500),
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
    problem: safeText(2_000),
    impact: safeText(2_000),
    recommendation: safeText(2_000),
    resolution: z.enum(["must-fix", "accepted-tradeoff", "not-actionable"]),
    justification: safeText(1_500).optional(),
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
    if (
      ["ticket-completion", "security-privacy"].includes(finding.category) &&
      finding.resolution !== "must-fix"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message:
          "ticket-completion and security/privacy findings must be fixed in the candidate",
      });
    }
  });

const fastFollowRecommendationSchema = z
  .object({
    id: identifier,
    area: z.enum([
      "product",
      "web",
      "database",
      "security",
      "privacy",
      "infrastructure",
      "testing",
      "other",
    ]),
    priority: z.enum(["high", "medium", "low"]),
    reason: z.enum([
      "out-of-scope",
      "follow-on-improvement",
      "operational-hardening",
    ]),
    title: safeText(300),
    rationale: safeText(2_000),
    planeMutationAuthorized: z.literal(false),
  })
  .strict();

export const adversarialReviewSchema = z
  .object({
    version: z.literal("codeops.adversarial-review/v1"),
    workflowId: workflowRunIdentifier,
    workItemId: identifier,
    baseSha: gitSha,
    reviewerId: z.literal("critic-agent"),
    reviewedAt: isoDateTime,
    candidate: candidateCheckpointSchema,
    lenses: z
      .object({
        ticketCompletion: adversarialReviewLensSchema,
        unusedCode: adversarialReviewLensSchema,
        simplicityMaintainability: adversarialReviewLensSchema,
        existingSystems: adversarialReviewLensSchema,
        testEffectiveness: adversarialReviewLensSchema,
        userFacingBehavior: adversarialReviewLensSchema,
        securityPrivacy: adversarialReviewLensSchema,
      })
      .strict(),
    findings: z.array(adversarialReviewFindingSchema).max(20),
    verificationTests: z.array(passingTestSchema).min(1).max(20),
    fastFollowRecommendations: z
      .array(fastFollowRecommendationSchema)
      .max(10),
    verdict: z.enum(["pass", "revision-required"]),
    summary: safeText(2_000),
  })
  .strict()
  .superRefine((review, context) => {
    const ids = [
      ...review.findings.map((finding) => finding.id),
      ...review.fastFollowRecommendations.map(
        (recommendation) => recommendation.id,
      ),
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "review finding and fast-follow IDs must be unique",
      });
    }
    const lensCategories = {
      ticketCompletion: "ticket-completion",
      unusedCode: "unused-code",
      simplicityMaintainability: "simplicity-maintainability",
      existingSystems: "existing-systems",
      testEffectiveness: "test-effectiveness",
      userFacingBehavior: "user-facing-behavior",
      securityPrivacy: "security-privacy",
    } as const;
    for (const lens of Object.keys(
      lensCategories,
    ) as (keyof typeof lensCategories)[]) {
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

export type CandidateCheckpoint = z.infer<typeof candidateCheckpointSchema>;
export type CodingOutcome = z.infer<typeof codingOutcomeSchema>;
export type AdversarialReview = z.infer<typeof adversarialReviewSchema>;
