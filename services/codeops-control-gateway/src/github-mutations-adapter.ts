import {
  canonicalJsonText,
  githubMutationProviderRequestSchema,
  githubMutationReconciliationResultSchema,
  githubMutationResultSchema,
  sessionPermissionOperationSchema,
  sha256CanonicalJsonDigest,
  type GitHubMutationProviderRequest,
  type GitHubMutationResult,
  type GitHubMutationReconciliationResult,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "./provider-response.js";
import type { RepositoryAuthority } from "./repository-registry.js";

const MAX_GITHUB_JSON_BYTES = 1 * 1_024 * 1_024;

export class GitHubMutationPreflightNoEffectError extends Error {}

export function githubEffectMarker(operationId: string): string {
  if (!/^githubmutation-[0-9a-f]{64}$/.test(operationId)) {
    throw new Error("GitHub effect marker operation identity is invalid");
  }
  return `<!-- codeops-provider-effect:${operationId} -->`;
}

async function preflight<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new GitHubMutationPreflightNoEffectError(
      `GitHub mutation preflight proved that no remote effect occurred: ${
        error instanceof Error ? error.message : "unknown preflight failure"
      }`,
      { cause: error },
    );
  }
}

function repositoryParts(authority: RepositoryAuthority): {
  readonly owner: string;
  readonly name: string;
} {
  const url = new URL(authority.repositoryUrl);
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    match === null ||
    `${match[1]}/${match[2]}` !== authority.repository ||
    authority.writeToken.length < 16 ||
    authority.writeToken.length > 4_096 ||
    /\s/.test(authority.writeToken)
  ) {
    throw new Error("GitHub mutation authority is invalid");
  }
  return { owner: match[1]!, name: match[2]! };
}

function apiUrl(authority: RepositoryAuthority, path: string): URL {
  const { owner, name } = repositoryParts(authority);
  return new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`,
    "https://api.github.com",
  );
}

function headers(authority: RepositoryAuthority): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${authority.writeToken}`,
    "User-Agent": "codeops-control-gateway",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson(
  authority: RepositoryAuthority,
  url: URL | string,
  requestFetch: typeof fetch,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await readProviderResponse({
    fetch: requestFetch,
    url,
    init: {
      ...init,
      headers: { ...headers(authority), ...(init.headers ?? {}) },
    },
    maxBytes: MAX_GITHUB_JSON_BYTES,
    statuses: [200, 201, 202, 204],
    mediaTypes: ["json"],
  });
  if (response.bytes.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(decodeProviderResponseText(response.bytes));
  } catch (error) {
    throw new Error("GitHub mutation response is not valid JSON", { cause: error });
  }
}

const pullRequestResponse = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    base: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    head: z.object({ sha: z.string() }).passthrough(),
    html_url: z.string(),
  })
  .passthrough();

async function pullRequest(
  authority: RepositoryAuthority,
  number: number,
  requestFetch: typeof fetch,
) {
  return pullRequestResponse.parse(
    await githubJson(authority, apiUrl(authority, `/pulls/${number}`), requestFetch),
  );
}

function expectedPermissionOperation(request: GitHubMutationProviderRequest) {
  const target = (() => {
    switch (request.operation) {
      case "pull_request_update_branch":
      case "pull_request_update":
        return {
          pullRequestNumber: request.input.pullRequestNumber,
          targetId: null,
        };
      case "review_thread_reply":
        return {
          pullRequestNumber: request.input.pullRequestNumber,
          targetId: request.input.threadId,
        };
      case "check_rerun":
        return {
          pullRequestNumber: null,
          targetId: String(request.input.checkRunId),
        };
    }
  })();
  return sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository: request.input.repository,
    operation: request.operation,
    ...target,
    expectedHeadSha: request.input.expectedHeadSha,
    payloadJson: canonicalJsonText(request.input),
  });
}

function assertProviderDigests(request: GitHubMutationProviderRequest): void {
  if (
    request.payloadDigest !== sha256CanonicalJsonDigest(request.input) ||
    request.permissionDigest !==
      sha256CanonicalJsonDigest(expectedPermissionOperation(request))
  ) {
    throw new Error(
      "GitHub mutation payload and durable permission digests do not match",
    );
  }
}

const reviewThreadIdentityResponse = z
  .object({
    data: z.object({
      node: z
        .object({
          id: z.string(),
          pullRequest: z.object({
            number: z.number().int().positive(),
            headRefOid: z.string(),
            repository: z.object({ nameWithOwner: z.string() }).passthrough(),
          }).passthrough(),
          comments: z
            .object({
              nodes: z.array(z.object({
                databaseId: z.number().int().positive(),
                url: z.string(),
                body: z.string(),
              }).passthrough().nullable()).max(100),
              pageInfo: z.object({ hasPreviousPage: z.boolean() }).passthrough(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .nullable(),
    }).passthrough(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

async function reviewThreadIdentity(
  authority: RepositoryAuthority,
  threadId: string,
  requestFetch: typeof fetch,
) {
  return reviewThreadIdentityResponse.parse(
    await githubJson(authority, "https://api.github.com/graphql", requestFetch, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: [
          "query CodeOpsMutationThread($threadId: ID!) {",
          "  node(id: $threadId) {",
          "    ... on PullRequestReviewThread {",
          "      id pullRequest { number headRefOid repository { nameWithOwner } }",
          "      comments(last: 100) { nodes { databaseId url body } pageInfo { hasPreviousPage } }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { threadId },
      }),
    }),
  );
}

export function createGitHubMutationReconciler(input: {
  readonly resolve: (repository: string) => RepositoryAuthority;
  readonly fetch?: typeof fetch;
  readonly consistencyWindowMs?: number;
}): (
  request: GitHubMutationProviderRequest,
  attemptedAt: Date,
  observedAt?: Date,
) => Promise<GitHubMutationReconciliationResult> {
  const requestFetch = input.fetch ?? fetch;
  const consistencyWindowMs = input.consistencyWindowMs ?? 60_000;
  if (!Number.isSafeInteger(consistencyWindowMs) || consistencyWindowMs < 1_000 || consistencyWindowMs > 300_000) {
    throw new Error("GitHub reconciliation consistency window is invalid");
  }
  return async (rawRequest, attemptedAt, observedAt = new Date()) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    assertProviderDigests(request);
    if (!Number.isFinite(attemptedAt.getTime()) || !Number.isFinite(observedAt.getTime()) || observedAt < attemptedAt) {
      throw new Error("GitHub reconciliation time identity is invalid");
    }
    const authority = input.resolve(request.input.repository);
    const windowElapsed = observedAt.getTime() - attemptedAt.getTime() >= consistencyWindowMs;
    const result = await (async () => {
    switch (request.operation) {
      case "pull_request_update": {
        const current = await pullRequest(authority, request.input.pullRequestNumber, requestFetch);
        const satisfied =
          current.number === request.input.pullRequestNumber &&
          current.head.sha === request.input.expectedHeadSha &&
          (request.input.title === undefined || current.title === request.input.title) &&
          (request.input.body === undefined || (current.body ?? "") === request.input.body) &&
          (request.input.baseBranch === undefined || current.base.ref === request.input.baseBranch);
        if (!satisfied) {
          return {
            state: "unknown",
            result: null,
            summary: "The requested pull-request fields are not all present; the exact prior metadata was not retained.",
          };
        }
        const result = githubMutationResultSchema.parse({
          version: "codeops.github-pull-request-update-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          pullRequestNumber: current.number,
          headSha: current.head.sha,
          baseSha: current.base.sha,
          title: current.title,
          body: current.body ?? "",
          baseBranch: current.base.ref,
          url: current.html_url,
        });
        return {
          state: "reconciled_satisfied",
          result,
          summary: "The exact pull-request identity and every requested field match.",
        };
      }
      case "review_thread_reply": {
        const current = await reviewThreadIdentity(authority, request.input.threadId, requestFetch);
        const thread = current.data.node;
        if (
          current.errors !== undefined ||
          thread === null ||
          thread.pullRequest.number !== request.input.pullRequestNumber ||
          thread.pullRequest.repository.nameWithOwner !== authority.repository
        ) {
          return { state: "unknown", result: null, summary: "The review-thread identity cannot be proved." };
        }
        const marker = githubEffectMarker(request.operationId);
        const comment = thread.comments?.nodes.find((entry) =>
          entry?.body.split(/\r?\n/).includes(marker),
        ) ?? null;
        if (comment !== null) {
          return {
            state: "reconciled_satisfied",
            result: githubMutationResultSchema.parse({
              version: "codeops.github-review-thread-reply-result/v1",
              repository: authority.repository,
              operationId: request.operationId,
              pullRequestNumber: thread.pullRequest.number,
              headSha: thread.pullRequest.headRefOid,
              threadId: request.input.threadId,
              commentId: comment.databaseId,
              url: comment.url,
            }),
            summary: "The exact hidden operation marker is present in the review thread.",
          };
        }
        if (thread.comments?.pageInfo.hasPreviousPage !== false) {
          return { state: "unknown", result: null, summary: "The bounded review-thread page cannot prove that the operation marker is absent." };
        }
        return windowElapsed
          ? { state: "reconciled_not_observed", result: null, summary: "The exact operation marker is absent after the provider consistency window." }
          : { state: "unknown", result: null, summary: "The provider consistency window has not elapsed." };
      }
      case "pull_request_update_branch": {
        const current = await pullRequest(authority, request.input.pullRequestNumber, requestFetch);
        if (current.head.sha === request.input.expectedHeadSha && windowElapsed) {
          return { state: "reconciled_not_observed", result: null, summary: "The exact prior pull-request head remains after the provider consistency window." };
        }
        return { state: "unknown", result: null, summary: "A pull-request head change cannot be attributed to this operation." };
      }
      case "check_rerun":
        await githubJson(
          authority,
          apiUrl(authority, `/check-runs/${request.input.checkRunId}`),
          requestFetch,
        );
        return { state: "unknown", result: null, summary: "The check-run evidence cannot attribute a rerun to this operation." };
    }
    })();
    return githubMutationReconciliationResultSchema.parse({
      version: "codeops.github-mutation-reconciliation-result/v1",
      ...result,
    });
  };
}

const reviewReplyResponse = z
  .object({
    data: z.object({
      addPullRequestReviewThreadReply: z
        .object({
          comment: z.object({
            databaseId: z.number().int().positive(),
            url: z.string(),
            pullRequest: z.object({
              number: z.number().int().positive(),
              headRefOid: z.string(),
              repository: z.object({ nameWithOwner: z.string() }).passthrough(),
            }).passthrough(),
          }).passthrough(),
        })
        .passthrough()
        .nullable(),
    }).passthrough(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

const checkRunResponse = z
  .object({
    id: z.number().int().positive(),
    head_sha: z.string(),
  })
  .passthrough();

export function createGitHubMutationAdapter(input: {
  readonly resolve: (repository: string) => RepositoryAuthority;
  readonly fetch?: typeof fetch;
}): (request: GitHubMutationProviderRequest) => Promise<GitHubMutationResult> {
  const requestFetch = input.fetch ?? fetch;
  return async (rawRequest) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    assertProviderDigests(request);
    const authority = input.resolve(request.input.repository);
    if (authority.repository !== request.input.repository) {
      throw new Error("GitHub mutation authority does not match the request");
    }
    repositoryParts(authority);

    switch (request.operation) {
      case "pull_request_update_branch": {
        await preflight(async () => {
          const value = await pullRequest(
            authority,
            request.input.pullRequestNumber,
            requestFetch,
          );
          if (
            value.number !== request.input.pullRequestNumber ||
            value.head.sha !== request.input.expectedHeadSha
          ) {
            throw new Error("GitHub pull-request head changed before update-branch");
          }
          return value;
        });
        await githubJson(
          authority,
          apiUrl(authority, `/pulls/${request.input.pullRequestNumber}/update-branch`),
          requestFetch,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expected_head_sha: request.input.expectedHeadSha,
            }),
          },
        );
        const after = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        return githubMutationResultSchema.parse({
          version: "codeops.github-pull-request-update-branch-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          pullRequestNumber: after.number,
          previousHeadSha: request.input.expectedHeadSha,
          headSha: after.head.sha,
          url: after.html_url,
        });
      }
      case "pull_request_update": {
        await preflight(async () => {
          const value = await pullRequest(
            authority,
            request.input.pullRequestNumber,
            requestFetch,
          );
          if (
            value.number !== request.input.pullRequestNumber ||
            value.head.sha !== request.input.expectedHeadSha ||
            value.base.sha !== request.input.expectedBaseSha
          ) {
            throw new Error("GitHub pull-request identity changed before update");
          }
          return value;
        });
        const patch = {
          ...(request.input.title === undefined
            ? {}
            : { title: request.input.title }),
          ...(request.input.body === undefined ? {} : { body: request.input.body }),
          ...(request.input.baseBranch === undefined
            ? {}
            : { base: request.input.baseBranch }),
        };
        await githubJson(
          authority,
          apiUrl(authority, `/pulls/${request.input.pullRequestNumber}`),
          requestFetch,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        const after = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        if (
          after.number !== request.input.pullRequestNumber ||
          after.head.sha !== request.input.expectedHeadSha ||
          (request.input.baseBranch === undefined &&
            after.base.sha !== request.input.expectedBaseSha) ||
          (request.input.title !== undefined &&
            after.title !== request.input.title) ||
          (request.input.body !== undefined &&
            (after.body ?? "") !== request.input.body) ||
          (request.input.baseBranch !== undefined &&
            after.base.ref !== request.input.baseBranch)
        ) {
          throw new Error("GitHub pull-request identity changed during update");
        }
        return githubMutationResultSchema.parse({
          version: "codeops.github-pull-request-update-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          pullRequestNumber: after.number,
          headSha: after.head.sha,
          baseSha: after.base.sha,
          title: after.title,
          body: after.body ?? "",
          baseBranch: after.base.ref,
          url: after.html_url,
        });
      }
      case "review_thread_reply": {
        await preflight(async () => {
          const value = await reviewThreadIdentity(
            authority,
            request.input.threadId,
            requestFetch,
          );
          const thread = value.data.node;
          if (
            value.errors !== undefined ||
            thread === null ||
            thread.id !== request.input.threadId ||
            thread.pullRequest.number !== request.input.pullRequestNumber ||
            thread.pullRequest.headRefOid !== request.input.expectedHeadSha ||
            thread.pullRequest.repository.nameWithOwner !== authority.repository
          ) {
            throw new Error("GitHub review-thread identity changed before reply");
          }
          return value;
        });
        const reply = reviewReplyResponse.parse(
          await githubJson(
            authority,
            "https://api.github.com/graphql",
            requestFetch,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: [
                  "mutation CodeOpsMutationReply($threadId: ID!, $body: String!) {",
                  "  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {",
                  "    comment { databaseId url pullRequest { number headRefOid repository { nameWithOwner } } }",
                  "  }",
                  "}",
                ].join("\n"),
                variables: {
                  threadId: request.input.threadId,
                  body: `${request.input.body}\n\n${githubEffectMarker(request.operationId)}`,
                },
              }),
            },
          ),
        );
        const comment = reply.data.addPullRequestReviewThreadReply?.comment;
        if (
          reply.errors !== undefined ||
          comment === undefined ||
          comment.pullRequest.number !== request.input.pullRequestNumber ||
          comment.pullRequest.headRefOid !== request.input.expectedHeadSha ||
          comment.pullRequest.repository.nameWithOwner !== authority.repository
        ) {
          throw new Error("GitHub review-thread identity changed during reply");
        }
        return githubMutationResultSchema.parse({
          version: "codeops.github-review-thread-reply-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          pullRequestNumber: comment.pullRequest.number,
          headSha: comment.pullRequest.headRefOid,
          threadId: request.input.threadId,
          commentId: comment.databaseId,
          url: comment.url,
        });
      }
      case "check_rerun": {
        await preflight(async () => {
          const value = checkRunResponse.parse(
            await githubJson(
              authority,
              apiUrl(authority, `/check-runs/${request.input.checkRunId}`),
              requestFetch,
            ),
          );
          if (
            value.id !== request.input.checkRunId ||
            value.head_sha !== request.input.expectedHeadSha
          ) {
            throw new Error("GitHub check identity changed before rerun");
          }
          return value;
        });
        await githubJson(
          authority,
          apiUrl(authority, `/check-runs/${request.input.checkRunId}/rerequest`),
          requestFetch,
          { method: "POST" },
        );
        const after = checkRunResponse.parse(
          await githubJson(
            authority,
            apiUrl(authority, `/check-runs/${request.input.checkRunId}`),
            requestFetch,
          ),
        );
        if (
          after.id !== request.input.checkRunId ||
          after.head_sha !== request.input.expectedHeadSha
        ) {
          throw new Error("GitHub check identity changed during rerun");
        }
        return githubMutationResultSchema.parse({
          version: "codeops.github-check-rerun-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          headSha: after.head_sha,
          checkRunId: after.id,
          accepted: true,
        });
      }
    }
  };
}
