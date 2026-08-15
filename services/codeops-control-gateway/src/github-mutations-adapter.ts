import {
  canonicalJsonText,
  githubMutationProviderRequestSchema,
  githubMutationResultSchema,
  sessionPermissionOperationSchema,
  sha256CanonicalJsonDigest,
  type GitHubMutationProviderRequest,
  type GitHubMutationResult,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "./provider-response.js";
import type { RepositoryAuthority } from "./repository-registry.js";

const MAX_GITHUB_JSON_BYTES = 1 * 1_024 * 1_024;

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
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { threadId },
      }),
    }),
  );
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
        const before = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        if (
          before.number !== request.input.pullRequestNumber ||
          before.head.sha !== request.input.expectedHeadSha
        ) {
          throw new Error("GitHub pull-request head changed before update-branch");
        }
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
        const before = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        if (
          before.number !== request.input.pullRequestNumber ||
          before.head.sha !== request.input.expectedHeadSha ||
          before.base.sha !== request.input.expectedBaseSha
        ) {
          throw new Error("GitHub pull-request identity changed before update");
        }
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
        const before = await reviewThreadIdentity(
          authority,
          request.input.threadId,
          requestFetch,
        );
        const thread = before.data.node;
        if (
          before.errors !== undefined ||
          thread === null ||
          thread.id !== request.input.threadId ||
          thread.pullRequest.number !== request.input.pullRequestNumber ||
          thread.pullRequest.headRefOid !== request.input.expectedHeadSha ||
          thread.pullRequest.repository.nameWithOwner !== authority.repository
        ) {
          throw new Error("GitHub review-thread identity changed before reply");
        }
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
                  body: request.input.body,
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
        const before = checkRunResponse.parse(
          await githubJson(
            authority,
            apiUrl(authority, `/check-runs/${request.input.checkRunId}`),
            requestFetch,
          ),
        );
        if (
          before.id !== request.input.checkRunId ||
          before.head_sha !== request.input.expectedHeadSha
        ) {
          throw new Error("GitHub check identity changed before rerun");
        }
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
