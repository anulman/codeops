import { createHash, randomUUID } from "node:crypto";
export { authenticateBearer } from "./bearer-auth.js";
import {
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  adversarialReviewSchema,
  agentJobDispatchRequestSchema,
  agentJobDispatchResultSchema,
  canonicalSerialize,
  codingOutcomeSchema,
  researchPersonaReportSchema,
  researchSynthesisSchema,
  runtimeLaunchBindingSchema,
  type RuntimeLaunchBinding,
  type AgentJobDispatchRequest,
  type AgentJobDispatchResult,
  type CandidateCheckpoint,
  githubReviewCommentSchema,
  type GitHubReviewComment,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EMPTY_PATCH_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const safeEventSchema = z
  .object({
    sequence: z.number().int().positive().max(100_000),
    type: z.string().min(1).max(200),
    toolCallId: z.string().max(500).optional(),
    title: z.string().max(500).optional(),
    status: z.string().max(200).optional(),
  })
  .strict();

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(3),
    runId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
    agentRole: z.enum([
      "coding-agent",
      "critic-agent",
      "qa-contract-researcher",
    ]),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    projectContextDigest: z.string().regex(SHA256),
    model: z.enum(["gpt-5.6-sol", "gpt-6-astra"]),
    reasoningEffort: z.literal("high"),
    sessionId: z.string().max(500).optional(),
    stopReason: z.string().max(500).optional(),
    response: z.string().max(128_100),
    events: z.array(safeEventSchema).max(100_000),
    patch: z
      .object({
        path: z.literal("changes.patch"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().nonnegative().max(2_000_000),
      })
      .strict(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

const checkpointRecordSchema = z
  .object({
    type: z.literal("codeops.checkpoint"),
    checkpointDigest: z.string().regex(SHA256),
    checkpoint: checkpointSchema,
  })
  .strict();

const patchChunkSchema = z
  .object({
    type: z.literal("codeops.patch-chunk"),
    runId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
    sequence: z.number().int().positive().max(100),
    total: z.number().int().positive().max(100),
    patchDigest: z.string().regex(SHA256),
    dataBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();

export interface RetainedCheckpoint {
  readonly checkpoint: z.infer<typeof checkpointSchema>;
  readonly checkpointDigest: string;
  readonly patch: Buffer;
}

export function parseDispatchRequest(value: unknown): AgentJobDispatchRequest {
  return agentJobDispatchRequestSchema.parse(value);
}

export async function resolveGitHubBranchHead(input: {
  repositoryUrl: string;
  repositoryReadToken: string;
  branch: "main";
  fetch?: typeof fetch;
}): Promise<string> {
  const repository = new URL(input.repositoryUrl);
  const match = repository.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (
    repository.protocol !== "https:" ||
    repository.hostname !== "github.com" ||
    repository.username !== "" ||
    repository.password !== "" ||
    repository.search !== "" ||
    repository.hash !== "" ||
    match === null
  ) {
    throw new Error("repository head resolver requires an exact GitHub HTTPS repository");
  }
  if (
    input.repositoryReadToken.length < 16 ||
    /\s/.test(input.repositoryReadToken)
  ) {
    throw new Error("repository head resolver token is invalid");
  }
  const [, owner, name] = match;
  const response = await (input.fetch ?? fetch)(
    `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/git/ref/heads/${input.branch}`,
    {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.repositoryReadToken}`,
        "User-Agent": "codeops-control-gateway",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub branch resolution failed with ${response.status}`);
  }
  const body = z
    .object({
      ref: z.literal("refs/heads/main"),
      object: z
        .object({
          type: z.literal("commit"),
          sha: z.string().regex(/^[0-9a-f]{40}$/),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(await response.json());
  return body.object.sha;
}

export interface GitHubPullRequestHead {
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

function parseGitHubRepositoryUrl(value: string): {
  owner: string;
  name: string;
} {
  const repository = new URL(value);
  const match = repository.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (
    repository.protocol !== "https:" ||
    repository.hostname !== "github.com" ||
    repository.username !== "" ||
    repository.password !== "" ||
    repository.search !== "" ||
    repository.hash !== "" ||
    match === null
  ) {
    throw new Error("GitHub operation requires an exact HTTPS repository");
  }
  return { owner: match[1]!, name: match[2]! };
}

export async function resolveGitHubPullRequestHead(input: {
  repositoryUrl: string;
  repositoryReadToken: string;
  pullRequestNumber: number;
  fetch?: typeof fetch;
}): Promise<GitHubPullRequestHead> {
  const { owner, name } = parseGitHubRepositoryUrl(input.repositoryUrl);
  const pullRequestNumber = z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .parse(input.pullRequestNumber);
  if (
    input.repositoryReadToken.length < 16 ||
    /\s/.test(input.repositoryReadToken)
  ) {
    throw new Error("pull-request head resolver token is invalid");
  }
  const response = await (input.fetch ?? fetch)(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequestNumber}`,
    {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.repositoryReadToken}`,
        "User-Agent": "codeops-control-gateway",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub pull-request head resolution failed with ${response.status}`);
  }
  const pullRequest = z
    .object({
      number: z.literal(pullRequestNumber),
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
    .passthrough()
    .parse(await response.json());
  return {
    repository: `${owner}/${name}`,
    number: pullRequest.number,
    state: pullRequest.state,
    headSha: pullRequest.head.sha,
    headRef: pullRequest.head.ref,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
  };
}

export async function loadGitHubReviewComments(input: {
  repositoryUrl: string;
  repositoryReadToken: string;
  pullRequestNumber: number;
  reviewId: number;
  fetch?: typeof fetch;
}): Promise<readonly GitHubReviewComment[]> {
  const { owner, name } = parseGitHubRepositoryUrl(input.repositoryUrl);
  const pullRequestNumber = z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .parse(input.pullRequestNumber);
  const reviewId = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(input.reviewId);
  if (
    input.repositoryReadToken.length < 16 ||
    /\s/.test(input.repositoryReadToken)
  ) {
    throw new Error("GitHub review reader token is invalid");
  }
  const requestFetch = input.fetch ?? fetch;
  async function page(number: number): Promise<readonly GitHubReviewComment[]> {
    const response = await requestFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequestNumber}/reviews/${reviewId}/comments?per_page=100&page=${number}`,
      {
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.repositoryReadToken}`,
          "User-Agent": "codeops-control-gateway",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub review comment read failed with ${response.status}`);
    }
    return z
      .array(
        z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            body: z.string().min(1).max(20_000),
            path: z.string(),
            line: z.number().int().positive().max(10_000_000).nullable(),
            side: z.enum(["LEFT", "RIGHT"]).nullable(),
            created_at: z.string().datetime({ offset: true }),
          })
          .passthrough(),
      )
      .max(100)
      .parse(await response.json())
      .map((comment) =>
        githubReviewCommentSchema.parse({
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          createdAt: comment.created_at,
        }),
      );
  }
  const first = await page(1);
  if (first.length === 100 && (await page(2)).length > 0) {
    throw new Error("GitHub review contains more than 100 inline comments");
  }
  return [...first].sort((left, right) => left.id - right.id);
}

export async function qualifyGitHubHead(input: {
  repositoryUrl: string;
  repositoryReadToken: string;
  pullRequestNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
  requiredCheckNames: readonly string[];
  fetch?: typeof fetch;
}): Promise<boolean> {
  const { owner, name } = parseGitHubRepositoryUrl(input.repositoryUrl);
  const pullRequestNumber = z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .parse(input.pullRequestNumber);
  const headSha = z.string().regex(/^[0-9a-f]{40}$/).parse(input.headSha);
  const baseRef = z
    .string()
    .min(1)
    .max(200)
    .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[A-Za-z0-9._/-]+$/)
    .parse(input.baseRef);
  const baseSha = z.string().regex(/^[0-9a-f]{40}$/).parse(input.baseSha);
  const required = new Set(
    z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(20)
      .parse(input.requiredCheckNames),
  );
  if (required.size !== input.requiredCheckNames.length) {
    throw new Error("required GitHub checks must be unique");
  }
  if (
    input.repositoryReadToken.length < 16 ||
    /\s/.test(input.repositoryReadToken)
  ) {
    throw new Error("GitHub qualification token is invalid");
  }
  const requestFetch = input.fetch ?? fetch;
  const response = await requestFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${headSha}/check-runs?per_page=100`,
    {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.repositoryReadToken}`,
        "User-Agent": "codeops-control-gateway",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub head qualification failed with ${response.status}`);
  }
  const body = z
    .object({
      total_count: z.number().int().nonnegative().max(100),
      check_runs: z
        .array(
          z
            .object({
              name: z.string().min(1).max(200),
              status: z.string().min(1).max(50),
              conclusion: z.string().max(50).nullable(),
              head_sha: z.string().regex(/^[0-9a-f]{40}$/),
            })
            .passthrough(),
        )
        .max(100),
    })
    .passthrough()
    .parse(await response.json());
  if (
    body.total_count !== body.check_runs.length ||
    body.check_runs.some(
      (check) =>
        check.head_sha !== headSha ||
        check.status !== "completed" ||
        check.conclusion !== "success",
    )
  ) {
    return false;
  }
  const passing = new Set(body.check_runs.map((check) => check.name));
  if (![...required].every((name) => passing.has(name))) return false;

  const reviewResponse = await requestFetch("https://api.github.com/graphql", {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.repositoryReadToken}`,
      "Content-Type": "application/json",
      "User-Agent": "codeops-control-gateway",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      query: [
        "query CodeOpsPullRequestQualification($owner: String!, $name: String!, $number: Int!) {",
        "  repository(owner: $owner, name: $name) {",
        "    pullRequest(number: $number) {",
        "      number state isDraft headRefOid baseRefName baseRefOid reviewDecision",
        "      reviewThreads(first: 100) {",
        "        nodes { isResolved }",
        "        pageInfo { hasNextPage }",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      variables: { owner, name, number: pullRequestNumber },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!reviewResponse.ok) {
    throw new Error(
      `GitHub pull-request qualification failed with ${reviewResponse.status}`,
    );
  }
  const review = z
    .object({
      data: z
        .object({
          repository: z
            .object({
              pullRequest: z
                .object({
                  number: z.number().int().positive().max(10_000_000),
                  state: z.literal("OPEN"),
                  isDraft: z.boolean(),
                  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
                  baseRefName: z.string().min(1).max(200),
                  baseRefOid: z.string().regex(/^[0-9a-f]{40}$/),
                  reviewDecision: z
                    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
                    .nullable(),
                  reviewThreads: z
                    .object({
                      nodes: z
                        .array(
                          z
                            .object({ isResolved: z.boolean() })
                            .passthrough(),
                        )
                        .max(100),
                      pageInfo: z
                        .object({ hasNextPage: z.boolean() })
                        .passthrough(),
                    })
                    .passthrough(),
                })
                .passthrough()
                .nullable(),
            })
            .passthrough()
            .nullable(),
        })
        .passthrough(),
      errors: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(await reviewResponse.json());
  const pullRequest = review.data.repository?.pullRequest ?? null;
  return (
    review.errors === undefined &&
    pullRequest !== null &&
    pullRequest.number === pullRequestNumber &&
    pullRequest.headRefOid === headSha &&
    pullRequest.baseRefName === baseRef &&
    pullRequest.baseRefOid === baseSha &&
    !pullRequest.isDraft &&
    pullRequest.reviewDecision === "APPROVED" &&
    !pullRequest.reviewThreads.pageInfo.hasNextPage &&
    pullRequest.reviewThreads.nodes.every((thread) => thread.isResolved)
  );
}

export function createRunIdentity(request: AgentJobDispatchRequest): {
  readonly runId: string;
  readonly requestDigest: string;
} {
  const requestDigest = createHash("sha256")
    .update(canonicalSerialize(request))
    .digest("hex");
  return {
    runId: `agent-${requestDigest.slice(0, 24)}`,
    requestDigest: `sha256:${requestDigest}`,
  };
}

const agentQualityDefaults = [
  "Tautological tests are considered harmful. Tests must exercise observable behavior independently of the implementation under test.",
  "Prefer the simplest architecture and the least code that satisfy the ticket and its acceptance criteria without sacrificing correctness, security, or maintainability.",
] as const;

const validationRecommendationDefault =
  "Suggest concrete validation mechanisms that the coding agent should use before handoff. Prefer independent, observable checks that can falsify the implementation, and include exact commands when the repository supports them.";

export function buildAgentPrompt(request: AgentJobDispatchRequest): string {
  if (request.role === "coding-agent") {
    return [
      "You are the bounded CodeOps coding agent.",
      ...agentQualityDefaults,
      `Work item: ${request.workItemId}`,
      `Exact base SHA: ${request.baseSha}`,
      `Task: ${request.summary}`,
      ...(request.codingRound === undefined
        ? []
        : [`Autonomous critic loop coding round: ${request.codingRound} of 4`]),
      `Project context digest: ${request.codingRequest.projectContext.digest}`,
      "Read /context/coding-request.json, /context/project-context.json, /context/project-documents/SOUL.md, and every trusted document under /context/project-documents/ before planning.",
      "The coding request contains the immutable current ticket, relevant human comments, relations, and a bounded same-project task index. Follow referenced approved decision tickets; do not guess missing product behavior.",
      "Treat /workspace as the exact writable target-base checkout. Trusted project-context documents are supplemental control-plane context, not files in that target checkout.",
      ...(request.codingRequest.researchPacket
        ? [
            "Read /context/research-packet.json; it is optional immutable implementation context from a completed research round.",
          ]
        : [
            `No standalone research packet is attached: ${request.codingRequest.researchDisposition.rationale}`,
          ]),
      `Acceptance criteria: ${JSON.stringify(
        request.codingRequest.workItem.acceptanceCriteria,
      )}`,
      ...(request.codingRequest.humanReview
        ? [
            "This workflow is an exact human-requested PR revision.",
            `The immutable submitted GitHub review is: ${JSON.stringify(request.codingRequest.humanReview)}`,
            "Resolve every concrete request in the review summary and inline comments. Preserve valid existing PR work, keep the change within the ticket, and explicitly cover each request with code or passing evidence.",
          ]
        : []),
      ...(request.codingRequest.adoptedPullRequest
        ? [
            "This workflow adopts one existing pull request for exact-head adversarial review.",
            `The immutable adopted pull request is: ${JSON.stringify(request.codingRequest.adoptedPullRequest)}`,
            ...(request.codingRound === 1
              ? [
                  "The workspace is already checked out at the exact adopted PR head.",
                  "Do not edit source in round 1. Inspect the PR diff and existing implementation, run the focused acceptance tests, and report the exact adopted tree as the candidate.",
                ]
              : []),
          ]
        : []),
      ...(request.revision
        ? [
            "The previous cumulative candidate patch is already applied to /workspace.",
            `The exact prior critic report is: ${JSON.stringify(request.revision.review)}`,
            "Resolve every must-fix finding without expanding the ticket. Preserve valid prior work and re-run the relevant tests.",
          ]
        : []),
      "Make small, understandable commits when useful. Pause at normal proof boundaries and run focused tests, typechecks, builds, and review with local or cluster resources. Group related commits into one coherent, reviewable increment before you request hosted CI.",
      "Run the focused tests required to prove the changed behavior before finishing. Add or strengthen tests when a critic finding exposes an unproved bug class.",
      "Do not push, open or merge a PR, deploy, or access Plane/Kubernetes.",
      ...(request.codingRound === undefined
        ? ["Finish with a concise summary of changes and tests."]
        : [
            "Every reported test must have passed in this exact workspace after the final source edit. Do not report a skipped, failed, or stale test as passed.",
            "Return only one JSON object, without Markdown fences, with exactly this shape:",
            JSON.stringify({
              version: "codeops.coding-outcome/v1",
              summary: "bounded summary of the exact cumulative candidate",
              tests: [
                {
                  command: "exact focused test command",
                  status: "passed",
                  summary: "what this passing command proves",
                },
              ],
            }),
          ]),
    ].join("\n");
  }
  if (request.role === "critic-agent") {
    const example = {
      version: "codeops.adversarial-review/v1",
      workflowId: request.workflowId,
      workItemId: request.workItemId,
      baseSha: request.baseSha,
      reviewerId: "critic-agent",
      reviewedAt: "2026-07-29T20:00:00.000Z",
      candidate: request.candidate,
      lenses: {
        ticketCompletion: {
          status: "clear",
          summary: "The bounded ticket and acceptance criteria are complete.",
        },
        unusedCode: {
          status: "clear",
          summary: "Every introduced path is used or explicitly justified.",
        },
        simplicityMaintainability: {
          status: "clear",
          summary: "The change is the smallest maintainable implementation.",
        },
        existingSystems: {
          status: "clear",
          summary: "Existing ownership boundaries are reused or extended well.",
        },
        testEffectiveness: {
          status: "clear",
          summary: "Tests prove the behavior and meaningful regression cases.",
        },
        userFacingBehavior: {
          status: "clear",
          summary: "No concrete user-facing regression remains.",
        },
        securityPrivacy: {
          status: "clear",
          summary: "No concrete security or privacy regression remains.",
        },
      },
      findings: [],
      verificationTests: [
        {
          command: "exact independently executed focused test command",
          status: "passed",
          summary: "what this critic-run command verifies",
        },
      ],
      fastFollowRecommendations: [],
      verdict: "pass",
      summary: "The exact cumulative candidate is ready for human review.",
    };
    return [
      "You are the isolated CodeOps critic agent.",
      ...agentQualityDefaults,
      validationRecommendationDefault,
      "Review only; do not edit source. The gateway will reject any source patch.",
      `Work item: ${request.workItemId}`,
      `Exact base SHA: ${request.baseSha}`,
      `Candidate coding round: ${request.codingRound} of 4`,
      `Exact candidate checkpoint: ${JSON.stringify(request.candidate)}`,
      `Task: ${request.summary}`,
      `Original task: ${request.codingRequest.workItem.summary}`,
      `Project context digest: ${request.codingRequest.projectContext.digest}`,
      "The exact cumulative candidate patch is already applied to /workspace.",
      "Read /context/coding-request.json, /context/project-context.json, and every trusted document under /context/project-documents/ before reviewing.",
      "Use the immutable ticket, relevant human comments and decisions, relations, bounded same-project Plane task index, trusted project documents, and source tree to understand how this narrow ticket fits the broader Plane project and product.",
      `Acceptance criteria: ${JSON.stringify(request.codingRequest.workItem.acceptanceCriteria)}`,
      ...(request.codingRequest.humanReview
        ? [
            `The exact human review being addressed is: ${JSON.stringify(request.codingRequest.humanReview)}`,
            "Independently verify that every concrete human review request is resolved in the cumulative candidate.",
          ]
        : []),
      ...(request.codingRequest.adoptedPullRequest
        ? [
            `The exact adopted pull request is: ${JSON.stringify(request.codingRequest.adoptedPullRequest)}`,
            "Review the complete adopted PR diff against its exact base, not only repairs added after adoption. The workspace contains the exact adopted head plus any cumulative repair patch.",
          ]
        : []),
      "Before correctness findings, assess the cumulative solution against the original user outcome and acceptance criteria, mandatory safety invariants, and explicit non-goals from the immutable task and trusted context. State these in the existing ticketCompletion, simplicityMaintainability, and existingSystems lens summaries; identify missing scope context rather than inventing requirements.",
      "First answer: Is this mechanism necessary and proportionate; is there a simpler existing alternative? A necessary safety property is not the same as the chosen mechanism. Removing unnecessary machinery is a valid remedy; never weaken mandatory isolation.",
      "Prior corrections do not redefine the original need. Across correction rounds, reassess cumulative support machinery rather than only hardening the latest implementation.",
      "Tie each finding to a violated requirement or concrete impact and the smallest sufficient remedy. Reviewers are advisory: the supervisor adjudicates simplify, retire, or justify before another correction round; recommendations do not create new gates.",
      "Pursue narrow ticket completion. Do not demand adjacent roadmap work in this candidate.",
      "Review every lens independently: ticket completion; unused/dead code; simplicity and maintainability; effective reuse or extension of existing systems; test effectiveness and likely bugs; user-facing behavior; and security/privacy.",
      "Report only the most meaningful issues that will cause problems in production. Do not report speculative, cosmetic, or low-impact concerns that fail this primary test.",
      "When a simpler architecture can mitigate a production bug, recommend that simpler architecture instead of additional complexity.",
      "Independently run at least one relevant focused test after inspecting the final source. Record every exact passing command in verificationTests; do not rely only on the coder's report.",
      "A ticket-required acceptance gap or concrete security/privacy regression is a must-fix finding, never a fast follow.",
      "Use fastFollowRecommendations for genuinely non-blocking next steps, especially valuable adjacent work discovered with evidence. Keep them narrow and actionable.",
      "For each fastFollowRecommendations item, set planeMutationAuthorized to false. The field belongs inside each recommendation item only.",
      "Never emit planeMutationAuthorized at the review root, including when fastFollowRecommendations is empty.",
      "Critical/high findings must be must-fix. A pass is impossible while any must-fix finding remains.",
      "Return only one JSON object, without Markdown fences, matching this shape:",
      JSON.stringify(example),
      "Use exact enum/category values from the example contract. Set each lens to finding iff at least one structured finding has its corresponding category. Use the current ISO-8601 time for reviewedAt.",
    ].join("\n");
  }
  if (request.researchStage.kind === "synthesis") {
    return [
      "You are the final QA Contract Researcher synthesizer.",
      ...agentQualityDefaults,
      validationRecommendationDefault,
      "Research only. The source workspace is read-only.",
      `Plane work item: ${request.workItemId}`,
      `Exact base SHA: ${request.baseSha}`,
      `Project context digest: ${request.researchRequest.projectContext.digest}`,
      "Read /context/project-context.json, /context/research-dispatch.json, and every trusted document under /context/project-documents/.",
      "Treat /workspace as the exact read-only target-base checkout. Trusted project-context documents are supplemental control-plane context and must not be cited as if they existed in that target checkout.",
      "The dispatch file contains the immutable ticket title, description, acceptance content, relevant human comments, revision, dependencies, a bounded same-project task index, and every persona report.",
      "Deduplicate findings, reconcile conflicts, and make the result specific to this ticket.",
      "Return no more than five ranked findings and three genuine product decisions.",
      "Return no more than 20 downstream findings, 5 follow-up tasks, 50 matrix rows, and 80 citations.",
      "Use at most 8 citationIds on any finding, decision, follow-up task, or matrix row; select the strongest sources. Use at most 8 sourceFindingIds on a follow-up task.",
      "For every topFindings and downstreamFindings item, category must be exactly one of: matrix-fact, product-decision, downstream-defect. Do not invent narrower category names.",
      "Use only these exact enum values: verdict = ready-to-refine, blocked-on-decisions, or insufficient-evidence; finding severity = critical, high, medium, low, or info; finding confidence = high, medium, or low; followUpTasks.area = security, database, web, infrastructure, product, or other; matrix row status = verified, gap, or decision-required. Do not invent synonyms or compound values.",
      "Omit citation.testName when the citation is not a test; never emit an empty string for an optional field.",
      "Populate the versioned route/state/credential matrix from repository truth.",
      "Classify out-of-scope defects as downstream findings.",
      "Propose two to five same-project follow-up tasks when high- or medium-severity findings have strong repository evidence; prioritize security findings. Use targetWorkItemId to update a matching task from the immutable project task index, otherwise use null to create one. Do not create duplicate tasks.",
      "Do not propose lifecycle, label, project, or comment mutations. The trusted projector alone may refine the current description and create or update these bounded tasks.",
      "Every finding and matrix row needs exact source path/line citations; include exact test names when citing a test.",
      "Return only one JSON object, without Markdown fences, with exactly this shape:",
      JSON.stringify({
        version: "codeops.research-synthesis/v1",
        requestId: request.researchRequest.requestId,
        verdict: "ready-to-refine",
        summary: "ticket-specific verdict",
        topFindings: [
          {
            id: "finding-1",
            category: "matrix-fact",
            severity: "high",
            confidence: "high",
            currentBehavior: "observed behavior",
            expectedBehavior: "expected contract",
            citationIds: ["citation-1"],
          },
        ],
        decisions: [
          {
            question: "genuine product decision",
            blocking: true,
            citationIds: ["citation-1"],
          },
        ],
        downstreamFindings: [],
        followUpTasks: [
          {
            key: "otp-rate-limit",
            area: "security",
            targetWorkItemId: null,
            title: "Bound OTP verification attempts",
            objective: "Prevent unbounded OTP guessing during the validity window.",
            acceptanceCriteria: [
              "Attempts are bounded per challenge and identity.",
              "Executable tests cover exhaustion and reset behavior.",
            ],
            sourceFindingIds: ["finding-1"],
            citationIds: ["citation-1"],
          },
        ],
        matrix: {
          version: "codeops.route-state-credential-matrix/v1",
          rows: [
            {
              id: "matrix-1",
              lifecycleState: "state",
              credentialState: "credential",
              routeOrRpc: "route or RPC",
              currentOracle: "current behavior",
              expectedOracle: "expected behavior",
              allowedSideEffects: "allowed mutations",
              status: "verified",
              citationIds: ["citation-1"],
            },
          ],
        },
        citations: [
          {
            id: "citation-1",
            path: "relative/source/path.ts",
            lineStart: 1,
            lineEnd: 2,
            testName: "exact test name when applicable",
            claim: "claim supported by these lines",
          },
        ],
      }),
    ].join("\n");
  }
  const personaScopes: Record<string, string> = {
    "@ai-security":
      "Find exploit paths, rank severity and confidence, and map trust boundaries.",
    "@ai-database":
      "Map canonical states, transitions, database privileges, and failure atomicity.",
    "@ai-web":
      "Build the route/RPC oracle matrix and cite executable browser/runtime evidence.",
    "@ai-infra":
      "Inspect deployment boundaries, runtime configuration, isolation, and failure recovery.",
    "@ai-design":
      "Inspect user-visible states, error recovery, and interaction contract gaps.",
    "@ai-product":
      "Separate ticket facts from genuine product decisions and downstream scope.",
    "@ai-ml":
      "Inspect model/data contracts, evaluation evidence, and probabilistic failure modes.",
  };
  return [
    `You are the ${request.researchStage.persona} QA Contract Researcher perspective.`,
    ...agentQualityDefaults,
    validationRecommendationDefault,
    "Research only. The source workspace is read-only.",
    `Plane work item: ${request.workItemId}`,
    `Exact base SHA: ${request.baseSha}`,
    `Brief: ${request.researchRequest.brief}`,
    `Distinct assignment: ${personaScopes[request.researchStage.persona]}`,
    `Project context digest: ${request.researchRequest.projectContext.digest}`,
    "Read /context/project-context.json, /context/research-dispatch.json, and every manifested repository document before research.",
    "The dispatch file contains the immutable ticket title, description, acceptance content, relevant human comments, revision, dependencies, and a bounded same-project task index.",
    "Stay within the distinct assignment above; classify each result as a matrix fact, product decision, or downstream defect.",
    "Every finding needs exact source path/line citations; include exact test names when citing a test.",
    "Return no more than 20 findings, 5 decisions, and 40 citations.",
    "Omit citation.testName when the citation is not a test; never emit an empty string for an optional field.",
    "Never propose or perform a Plane lifecycle-state change.",
    "Return only one JSON object, without Markdown fences, with exactly this shape:",
    JSON.stringify({
      version: "codeops.research-persona-report/v2",
      requestId: request.researchRequest.requestId,
      persona: request.researchStage.persona,
      outcome: "findings",
      summary: "bounded plain-text summary",
      findings: [
        {
          id: "finding-1",
          category: "matrix-fact",
          severity: "high",
          confidence: "high",
          currentBehavior: "observed behavior",
          expectedBehavior: "expected contract",
          citationIds: ["citation-1"],
        },
      ],
      decisions: [
        {
          question: "decision or unresolved question",
          blocking: false,
          citationIds: ["citation-1"],
        },
      ],
      citations: [
        {
          id: "citation-1",
          path: "relative/source/path.ts",
          lineStart: 1,
          lineEnd: 2,
          testName: "exact test name when applicable",
          claim: "claim supported by these lines",
        },
      ],
    }),
  ].join("\n");
}

export function parseCheckpointLogs(input: {
  logs: string;
  request: AgentJobDispatchRequest;
  runId: string;
}): RetainedCheckpoint {
  const checkpoints: unknown[] = [];
  const chunks: z.infer<typeof patchChunkSchema>[] = [];
  for (const line of input.logs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "codeops.checkpoint"
    ) {
      checkpoints.push(value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "codeops.patch-chunk"
    ) {
      chunks.push(patchChunkSchema.parse(value));
    }
  }
  if (checkpoints.length !== 1) {
    throw new Error("Agent Job must emit exactly one checkpoint record");
  }
  const rawRecord = checkpoints[0] as { checkpoint?: unknown };
  const record = checkpointRecordSchema.parse(rawRecord);
  const checkpoint = record.checkpoint;
  const serializedCheckpoint = JSON.stringify(rawRecord.checkpoint);
  if (serializedCheckpoint === undefined) {
    throw new Error("Agent Job checkpoint is not serializable");
  }
  const computedCheckpointDigest = `sha256:${createHash("sha256")
    .update(serializedCheckpoint)
    .digest("hex")}`;
  if (record.checkpointDigest !== computedCheckpointDigest) {
    throw new Error("Agent Job checkpoint digest mismatch");
  }
  if (
    checkpoint.runId !== input.runId ||
    checkpoint.agentRole !== input.request.role ||
    checkpoint.baseSha !== input.request.baseSha ||
    checkpoint.projectContextDigest !==
      (input.request.role === "coding-agent" ||
      input.request.role === "critic-agent"
        ? input.request.codingRequest.projectContext.digest
        : input.request.researchRequest.projectContext.digest)
  ) {
    throw new Error("Agent Job checkpoint identity mismatch");
  }
  if (checkpoint.error) {
    throw new Error(`Agent Job checkpoint reported failure: ${checkpoint.error}`);
  }
  if (chunks.length === 0) {
    throw new Error("Agent Job did not emit patch evidence");
  }
  const totals = new Set(chunks.map((chunk) => chunk.total));
  const digests = new Set(chunks.map((chunk) => chunk.patchDigest));
  if (totals.size !== 1 || digests.size !== 1) {
    throw new Error("Agent Job patch chunks disagree");
  }
  const total = chunks[0]!.total;
  if (
    chunks.length !== total ||
    new Set(chunks.map((chunk) => chunk.sequence)).size !== total
  ) {
    throw new Error("Agent Job patch chunks are incomplete or duplicated");
  }
  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);
  if (ordered.some((chunk, index) => chunk.sequence !== index + 1)) {
    throw new Error("Agent Job patch chunk sequence is invalid");
  }
  const patch = Buffer.concat(
    ordered.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  const patchDigest = createHash("sha256").update(patch).digest("hex");
  if (
    `sha256:${patchDigest}` !== ordered[0]!.patchDigest ||
    patchDigest !== checkpoint.patch.sha256 ||
    patch.length !== checkpoint.patch.bytes
  ) {
    throw new Error("Agent Job retained patch does not match its checkpoint");
  }
  if (
    input.request.role === "qa-contract-researcher" &&
    (patch.length !== 0 || patchDigest !== EMPTY_PATCH_SHA256)
  ) {
    throw new Error("QA Contract Researcher produced a source patch");
  }
  if (
    input.request.role === "critic-agent" &&
    (`sha256:${patchDigest}` !== input.request.candidate.patch.digest ||
      patch.length !== input.request.candidate.patch.sizeBytes)
  ) {
    throw new Error("Critic Agent changed the cumulative candidate patch");
  }
  if (
    input.request.role === "coding-agent" &&
    input.request.codingRound === 1 &&
    input.request.codingRequest.adoptedPullRequest !== undefined &&
    (patch.length !== 0 || patchDigest !== EMPTY_PATCH_SHA256)
  ) {
    throw new Error("Adopted pull-request round 1 changed the exact adopted head");
  }
  return {
    checkpoint,
    checkpointDigest: record.checkpointDigest,
    patch,
  };
}

async function atomicWrite(filePath: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
  const handle = await open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

function reconstructRetainedResult(input: {
  request: AgentJobDispatchRequest;
  runId: string;
  checkpoint: z.infer<typeof checkpointSchema>;
  checkpointDigest: string;
  patch: Buffer;
}): AgentJobDispatchResult {
  const checkpointBytes = JSON.stringify(input.checkpoint);
  const computedCheckpointDigest = `sha256:${createHash("sha256")
    .update(checkpointBytes)
    .digest("hex")}`;
  const patchDigest = createHash("sha256").update(input.patch).digest("hex");
  const projectContextDigest =
    input.request.role === "coding-agent" || input.request.role === "critic-agent"
      ? input.request.codingRequest.projectContext.digest
      : input.request.researchRequest.projectContext.digest;
  if (
    input.checkpointDigest !== computedCheckpointDigest ||
    input.checkpoint.runId !== input.runId ||
    input.checkpoint.agentRole !== input.request.role ||
    input.checkpoint.baseSha !== input.request.baseSha ||
    input.checkpoint.projectContextDigest !== projectContextDigest ||
    input.checkpoint.error !== undefined ||
    input.checkpoint.patch.sha256 !== patchDigest ||
    input.checkpoint.patch.bytes !== input.patch.length
  ) {
    throw new Error("retained Agent Job checkpoint evidence drifted");
  }
  if (
    input.request.role === "qa-contract-researcher" &&
    (input.patch.length !== 0 || patchDigest !== EMPTY_PATCH_SHA256)
  ) {
    throw new Error("retained QA Contract Researcher produced a source patch");
  }
  if (
    input.request.role === "critic-agent" &&
    (`sha256:${patchDigest}` !== input.request.candidate.patch.digest ||
      input.patch.length !== input.request.candidate.patch.sizeBytes)
  ) {
    throw new Error("retained Critic Agent patch drifted from its candidate");
  }
  if (
    input.request.role === "coding-agent" &&
    input.request.codingRound === 1 &&
    input.request.codingRequest.adoptedPullRequest !== undefined &&
    (input.patch.length !== 0 || patchDigest !== EMPTY_PATCH_SHA256)
  ) {
    throw new Error("retained adopted pull-request round changed its exact head");
  }

  const researchResponse = input.request.role === "qa-contract-researcher"
    ? parseTerminalJsonObject(input.checkpoint.response)
    : undefined;
  const criticResponse = input.request.role === "critic-agent"
    ? adversarialReviewSchema.parse(
        parseTerminalJsonObject(input.checkpoint.response),
      )
    : undefined;
  const codingResponse =
    input.request.role === "coding-agent" && input.request.codingRound !== undefined
      ? codingOutcomeSchema.parse(
          parseTerminalJsonObject(input.checkpoint.response),
        )
      : undefined;
  const result = agentJobDispatchResultSchema.parse({
    version: "codeops.agent-job-dispatch-result/v1",
    role: input.request.role,
    runId: input.runId,
    checkpointUri: `artifact:///agent-runs/${input.runId}/checkpoint.json`,
    checkpointDigest: input.checkpointDigest,
    checkpointSizeBytes: Buffer.byteLength(checkpointBytes),
    patchUri: `artifact:///agent-runs/${input.runId}/changes.patch`,
    patchDigest: `sha256:${patchDigest}`,
    patchSizeBytes: input.patch.length,
    ...(input.request.role === "critic-agent"
      ? { criticReview: criticResponse }
      : {}),
    ...(input.request.role === "coding-agent" &&
    input.request.codingRound !== undefined
      ? { codingOutcome: codingResponse }
      : {}),
    ...(input.request.role === "qa-contract-researcher"
      ? {
          researchResult:
            input.request.researchStage.kind === "persona"
              ? {
                  kind: "persona",
                  report: researchPersonaReportSchema.parse(researchResponse),
                }
              : {
                  kind: "synthesis",
                  synthesis: researchSynthesisSchema.parse(researchResponse),
                },
        }
      : {}),
  });
  if (input.request.role === "critic-agent") {
    if (
      result.role !== "critic-agent" ||
      result.criticReview.workflowId !== input.request.workflowId ||
      result.criticReview.workItemId !== input.request.workItemId ||
      result.criticReview.baseSha !== input.request.baseSha ||
      result.criticReview.candidate.round !== input.request.codingRound ||
      result.criticReview.candidate.runId !== input.request.candidate.runId ||
      canonicalSerialize(result.criticReview.candidate) !==
        canonicalSerialize(input.request.candidate)
    ) {
      throw new Error("critic report identity does not match its exact candidate");
    }
  }
  if (input.request.role === "qa-contract-researcher") {
    if (
      result.role !== "qa-contract-researcher" ||
      result.researchResult.kind !== input.request.researchStage.kind
    ) {
      throw new Error("research report identity does not match its dispatch");
    }
    if (
      input.request.researchStage.kind === "persona" &&
      (result.researchResult.kind !== "persona" ||
        result.researchResult.report.requestId !==
          input.request.researchRequest.requestId ||
        result.researchResult.report.persona !== input.request.researchStage.persona)
    ) {
      throw new Error("research persona identity does not match its dispatch");
    }
    if (
      input.request.researchStage.kind === "synthesis" &&
      (result.researchResult.kind !== "synthesis" ||
        result.researchResult.synthesis.requestId !==
          input.request.researchRequest.requestId)
    ) {
      throw new Error("research synthesis identity does not match its dispatch");
    }
  }
  return result;
}

export async function retainCheckpoint(input: {
  rootDirectory: string;
  request: AgentJobDispatchRequest;
  runId: string;
  requestDigest: string;
  runtimeLaunchBinding?: RuntimeLaunchBinding;
  retained: RetainedCheckpoint;
}): Promise<AgentJobDispatchResult> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  await claimRequest(input);
  const requestPath = path.join(directory, "request.json");
  const existing = JSON.parse(await readFile(requestPath, "utf8")) as {
    requestDigest?: unknown;
  };
  if (existing.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  await atomicWrite(
    path.join(directory, "checkpoint.json"),
    `${JSON.stringify(input.retained.checkpoint, null, 2)}\n`,
  );
  await atomicWrite(path.join(directory, "changes.patch"), input.retained.patch);
  const result = reconstructRetainedResult({
    request: input.request,
    runId: input.runId,
    checkpoint: input.retained.checkpoint,
    checkpointDigest: input.retained.checkpointDigest,
    patch: input.retained.patch,
  });
  await atomicWrite(
    path.join(directory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

function parseTerminalJsonObject(response: string): unknown {
  const trimmed = response.trim();
  const candidates: unknown[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") continue;
    try {
      const value = JSON.parse(trimmed.slice(index)) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        candidates.push(value);
      }
    } catch {
      // Only a complete object that consumes the final response suffix is
      // eligible. Progress prose and nested opening braces do not qualify.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      "Agent response must end with exactly one complete JSON object",
    );
  }
  return candidates[0];
}

export async function claimRequest(input: {
  rootDirectory: string;
  request: AgentJobDispatchRequest;
  runId: string;
  requestDigest: string;
  runtimeLaunchBinding?: RuntimeLaunchBinding;
}): Promise<RuntimeLaunchBinding> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const requestPath = path.join(directory, "request.json");
  try {
    const existing = JSON.parse(await readFile(requestPath, "utf8")) as {
      requestDigest?: unknown;
      runtimeLaunchBinding?: unknown;
    };
    if (existing.requestDigest !== input.requestDigest) {
      throw new Error("durable Agent Job identity drift");
    }
    if (existing.runtimeLaunchBinding === undefined) {
      throw new Error("unfinished Agent Job has no durable runtime binding");
    }
    const storedBinding = runtimeLaunchBindingSchema.parse(
      existing.runtimeLaunchBinding,
    );
    if (
      input.runtimeLaunchBinding !== undefined &&
      storedBinding.requirementDigest !== input.runtimeLaunchBinding.requirementDigest
    ) {
      throw new Error("durable Agent Job runtime requirement drift");
    }
    return storedBinding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const runtimeLaunchBinding = runtimeLaunchBindingSchema.parse(
      input.runtimeLaunchBinding,
    );
    await atomicWrite(
      requestPath,
      `${JSON.stringify(
        {
          requestDigest: input.requestDigest,
          request: input.request,
          runtimeLaunchBinding,
        },
        null,
        2,
      )}\n`,
    );
    return runtimeLaunchBinding;
  }
}

export interface AgentJobResourceBinding {
  readonly uid: string;
  readonly configDigest: string;
}

export interface AgentJobSecretReplacement extends AgentJobResourceBinding {
  readonly desiredConfigDigest: string;
  readonly resourceName?: string;
}

function parseAgentJobResourceBindings(value: unknown): Record<string, AgentJobResourceBinding> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("durable Agent Job resource bindings are invalid");
  }
  const bindings: Record<string, AgentJobResourceBinding> = {};
  for (const [key, binding] of Object.entries(value)) {
    if (!/^[A-Za-z]+\/[A-Za-z0-9.-]{1,253}$/.test(key) || binding === null ||
        typeof binding !== "object" || Array.isArray(binding) ||
        Object.keys(binding).some((field) => field !== "uid" && field !== "configDigest")) {
      throw new Error("durable Agent Job resource binding is invalid");
    }
    const candidate = binding as Record<string, unknown>;
    if (typeof candidate.uid !== "string" || candidate.uid.length < 1 ||
        candidate.uid.length > 256 || typeof candidate.configDigest !== "string" ||
        !SHA256.test(candidate.configDigest)) {
      throw new Error("durable Agent Job resource binding is invalid");
    }
    bindings[key] = { uid: candidate.uid, configDigest: candidate.configDigest };
  }
  return bindings;
}

function parseAgentJobSecretReplacements(value: unknown): Record<string, AgentJobSecretReplacement> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("durable Agent Job Secret replacements are invalid");
  }
  const replacements: Record<string, AgentJobSecretReplacement> = {};
  for (const [key, replacement] of Object.entries(value)) {
    if (!/^Secret\/[A-Za-z0-9.-]{1,253}$/.test(key) || replacement === null ||
        typeof replacement !== "object" || Array.isArray(replacement) ||
        Object.keys(replacement).some((field) => !["uid", "configDigest",
          "desiredConfigDigest", "resourceName"].includes(field))) {
      throw new Error("durable Agent Job Secret replacement is invalid");
    }
    const candidate = replacement as Record<string, unknown>;
    if (typeof candidate.uid !== "string" || candidate.uid.length < 1 ||
        candidate.uid.length > 256 || typeof candidate.configDigest !== "string" ||
        !SHA256.test(candidate.configDigest) ||
        typeof candidate.desiredConfigDigest !== "string" ||
        !SHA256.test(candidate.desiredConfigDigest) ||
        (candidate.resourceName !== undefined && (typeof candidate.resourceName !== "string" ||
          candidate.resourceName.length < 1 || candidate.resourceName.length > 253))) {
      throw new Error("durable Agent Job Secret replacement is invalid");
    }
    replacements[key] = {
      uid: candidate.uid,
      configDigest: candidate.configDigest,
      desiredConfigDigest: candidate.desiredConfigDigest,
      ...(candidate.resourceName === undefined ? {} : { resourceName: candidate.resourceName }),
    };
  }
  return replacements;
}

export async function readAgentJobResourceBindings(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
}): Promise<Readonly<Record<string, AgentJobResourceBinding>>> {
  const requestPath = path.join(input.rootDirectory, "agent-runs", input.runId, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as {
    requestDigest?: unknown;
    resourceBindings?: unknown;
  };
  if (retained.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  return parseAgentJobResourceBindings(retained.resourceBindings);
}

export async function readAgentJobSecretReplacements(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
}): Promise<Readonly<Record<string, AgentJobSecretReplacement>>> {
  const requestPath = path.join(input.rootDirectory, "agent-runs", input.runId, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as {
    requestDigest?: unknown;
    resourceReplacements?: unknown;
  };
  if (retained.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  return parseAgentJobSecretReplacements(retained.resourceReplacements);
}

export async function retainAgentJobSecretReplacement(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  resourceKey: string;
  replacement: AgentJobSecretReplacement;
}): Promise<void> {
  const requestPath = path.join(input.rootDirectory, "agent-runs", input.runId, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
  if (retained.requestDigest !== input.requestDigest) throw new Error("durable Agent Job identity drift");
  const bindings = parseAgentJobResourceBindings(retained.resourceBindings);
  const replacements = parseAgentJobSecretReplacements(retained.resourceReplacements);
  const parsed = parseAgentJobSecretReplacements({ [input.resourceKey]: input.replacement });
  const replacement = parsed[input.resourceKey]!;
  const binding = bindings[input.resourceKey];
  if (binding === undefined || binding.uid !== replacement.uid ||
      binding.configDigest !== replacement.configDigest) {
    throw new Error("durable Agent Job Secret replacement binding drift");
  }
  const existing = replacements[input.resourceKey];
  if (existing !== undefined && canonicalSerialize(existing) !== canonicalSerialize(replacement)) {
    throw new Error("durable Agent Job Secret replacement identity drift");
  }
  if (existing !== undefined) return;
  await atomicWrite(requestPath, `${JSON.stringify({ ...retained,
    resourceReplacements: { ...replacements, [input.resourceKey]: replacement },
  }, null, 2)}\n`);
}

export async function completeAgentJobSecretReplacement(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  resourceKey: string;
  replacement: AgentJobSecretReplacement;
  binding: AgentJobResourceBinding;
}): Promise<void> {
  const requestPath = path.join(input.rootDirectory, "agent-runs", input.runId, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
  if (retained.requestDigest !== input.requestDigest) throw new Error("durable Agent Job identity drift");
  const bindings = parseAgentJobResourceBindings(retained.resourceBindings);
  const replacements = parseAgentJobSecretReplacements(retained.resourceReplacements);
  const expected = parseAgentJobSecretReplacements({ [input.resourceKey]: input.replacement })[
    input.resourceKey]!;
  const replacement = replacements[input.resourceKey];
  if (replacement === undefined || canonicalSerialize(replacement) !== canonicalSerialize(expected)) {
    throw new Error("durable Agent Job Secret replacement identity drift");
  }
  const parsedBinding = parseAgentJobResourceBindings({ [input.resourceKey]: input.binding })[
    input.resourceKey]!;
  if (parsedBinding.configDigest !== replacement.desiredConfigDigest) {
    throw new Error("durable Agent Job Secret replacement configuration drift");
  }
  const current = bindings[input.resourceKey];
  if (current !== undefined && (current.uid !== replacement.uid ||
      current.configDigest !== replacement.configDigest)) {
    throw new Error("durable Agent Job Secret replacement binding drift");
  }
  delete replacements[input.resourceKey];
  await atomicWrite(requestPath, `${JSON.stringify({ ...retained,
    resourceBindings: { ...bindings, [input.resourceKey]: parsedBinding },
    resourceReplacements: replacements,
  }, null, 2)}\n`);
}

export async function retainAgentJobResourceBinding(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  resourceKey: string;
  binding: AgentJobResourceBinding;
}): Promise<void> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const requestPath = path.join(directory, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
  if (retained.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  const bindings = parseAgentJobResourceBindings(retained.resourceBindings);
  const parsed = parseAgentJobResourceBindings({ [input.resourceKey]: input.binding });
  const binding = parsed[input.resourceKey]!;
  const existing = bindings[input.resourceKey];
  if (existing !== undefined && (existing.uid !== binding.uid ||
      existing.configDigest !== binding.configDigest)) {
    throw new Error("durable Agent Job Kubernetes identity drift");
  }
  if (existing !== undefined) return;
  await atomicWrite(requestPath, `${JSON.stringify({
    ...retained,
    resourceBindings: { ...bindings, [input.resourceKey]: binding },
  }, null, 2)}\n`);
}

export async function removeAgentJobResourceBinding(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  resourceKey: string;
  binding: AgentJobResourceBinding;
}): Promise<void> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const requestPath = path.join(directory, "request.json");
  const retained = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
  if (retained.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  const bindings = parseAgentJobResourceBindings(retained.resourceBindings);
  const parsed = parseAgentJobResourceBindings({ [input.resourceKey]: input.binding });
  const binding = parsed[input.resourceKey]!;
  const existing = bindings[input.resourceKey];
  if (existing === undefined || existing.uid !== binding.uid ||
      existing.configDigest !== binding.configDigest) {
    throw new Error("durable Agent Job Kubernetes identity drift");
  }
  delete bindings[input.resourceKey];
  await atomicWrite(requestPath, `${JSON.stringify({
    ...retained,
    resourceBindings: bindings,
  }, null, 2)}\n`);
}

export async function readRetainedResult(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  request: AgentJobDispatchRequest;
}): Promise<AgentJobDispatchResult | null> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  try {
    const requestRecord = JSON.parse(
      await readFile(path.join(directory, "request.json"), "utf8"),
    ) as { requestDigest?: unknown; request?: unknown };
    const storedRequest = agentJobDispatchRequestSchema.parse(requestRecord.request);
    if (
      requestRecord.requestDigest !== input.requestDigest ||
      canonicalSerialize(storedRequest) !==
        canonicalSerialize(agentJobDispatchRequestSchema.parse(input.request))
    ) {
      throw new Error("durable Agent Job identity drift");
    }
    const result = agentJobDispatchResultSchema.parse(
      JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")),
    );
    const checkpoint = checkpointSchema.parse(
      JSON.parse(await readFile(path.join(directory, "checkpoint.json"), "utf8")),
    );
    const patch = await readFile(path.join(directory, "changes.patch"));
    const reconstructed = reconstructRetainedResult({
      request: input.request,
      runId: input.runId,
      checkpoint,
      checkpointDigest: result.checkpointDigest,
      patch,
    });
    if (canonicalSerialize(result) !== canonicalSerialize(reconstructed)) {
      throw new Error("retained Agent Job terminal evidence drifted");
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readCandidatePatch(input: {
  rootDirectory: string;
  request: AgentJobDispatchRequest;
}): Promise<
  | {
      readonly candidate: CandidateCheckpoint;
      readonly patch: Buffer;
    }
  | null
> {
  if (input.request.role === "qa-contract-researcher") return null;
  const candidate =
    input.request.role === "critic-agent"
      ? input.request.candidate
      : input.request.revision?.candidate;
  if (!candidate) return null;

  const directory = path.join(
    input.rootDirectory,
    "agent-runs",
    candidate.runId,
  );
  const retainedRequest = JSON.parse(
    await readFile(path.join(directory, "request.json"), "utf8"),
  ) as { request?: unknown };
  const sourceRequest = agentJobDispatchRequestSchema.parse(
    retainedRequest.request,
  );
  if (
    sourceRequest.role !== "coding-agent" ||
    sourceRequest.workItemId !== input.request.workItemId ||
    sourceRequest.workflowId !== input.request.workflowId ||
    sourceRequest.baseSha !== input.request.baseSha ||
    canonicalSerialize(sourceRequest.codingRequest) !==
      canonicalSerialize(input.request.codingRequest) ||
    sourceRequest.codingRound !== candidate.round
  ) {
    throw new Error("candidate source request identity drifted");
  }
  const result = agentJobDispatchResultSchema.parse(
    JSON.parse(
      await readFile(path.join(directory, "result.json"), "utf8"),
    ),
  );
  if (
    result.role !== "coding-agent" ||
    result.runId !== candidate.runId ||
    result.checkpointUri !== candidate.checkpoint.uri ||
    result.checkpointDigest !== candidate.checkpoint.digest ||
    result.checkpointSizeBytes !== candidate.checkpoint.sizeBytes ||
    result.patchUri !== candidate.patch.uri ||
    result.patchDigest !== candidate.patch.digest ||
    result.patchSizeBytes !== candidate.patch.sizeBytes ||
    result.codingOutcome === undefined ||
    canonicalSerialize(result.codingOutcome) !==
      canonicalSerialize(candidate.codingOutcome)
  ) {
    throw new Error("candidate result identity drifted");
  }
  const patch = await readFile(path.join(directory, "changes.patch"));
  const digest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
  if (
    digest !== candidate.patch.digest ||
    patch.length !== candidate.patch.sizeBytes
  ) {
    throw new Error("candidate patch bytes drifted");
  }
  return { candidate, patch };
}

export async function retainFailure(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  error: unknown;
  logs: string;
}): Promise<void> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  await atomicWrite(
    path.join(directory, "failure.json"),
    `${JSON.stringify(
      {
        requestDigest: input.requestDigest,
        error: message.slice(0, 2_000),
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await atomicWrite(
    path.join(directory, "session-gateway.log"),
    input.logs.slice(0, 4_000_000),
  );
}
