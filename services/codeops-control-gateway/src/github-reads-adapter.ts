import {
  githubReadProviderRequestSchema,
  githubReadResultSchema,
  type GitHubReadProviderRequest,
  type GitHubReadResult,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const MAX_UPSTREAM_TEXT_BYTES = 2 * 1_024 * 1_024;

interface GitHubReadAuthority {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly readToken: string;
}

function repositoryParts(authority: GitHubReadAuthority): {
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
    authority.readToken.length < 16 ||
    authority.readToken.length > 4_096 ||
    /\s/.test(authority.readToken)
  ) {
    throw new Error("GitHub read authority is invalid");
  }
  return { owner: match[1]!, name: match[2]! };
}

function apiUrl(
  authority: GitHubReadAuthority,
  path: string,
  query?: Readonly<Record<string, string>>,
): URL {
  const { owner, name } = repositoryParts(authority);
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`,
    "https://api.github.com",
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function headers(authority: GitHubReadAuthority, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${authority.readToken}`,
    "User-Agent": "codeops-control-gateway",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson(
  authority: GitHubReadAuthority,
  url: URL | string,
  requestFetch: typeof fetch,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await requestFetch(url, {
    ...init,
    redirect: "error",
    headers: { ...headers(authority), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub read failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<{
  readonly content: string;
  readonly contentBytes: number;
  readonly sourceBytes: number;
  readonly truncated: boolean;
}> {
  if (!response.ok) {
    throw new Error(`GitHub text read failed with HTTP ${response.status}`);
  }
  const source = Buffer.from(await response.arrayBuffer());
  if (source.byteLength > MAX_UPSTREAM_TEXT_BYTES) {
    throw new Error("GitHub text response exceeds 2 MiB");
  }
  let content = source.subarray(0, Math.min(source.byteLength, maxBytes)).toString("utf8");
  while (Buffer.byteLength(content) > maxBytes) content = content.slice(0, -1);
  const contentBytes = Buffer.byteLength(content);
  return {
    content,
    contentBytes,
    sourceBytes: source.byteLength,
    truncated: contentBytes < source.byteLength,
  };
}

const pullRequestResponse = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    draft: z.boolean(),
    user: z.object({ login: z.string() }).passthrough().nullable(),
    base: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    head: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    updated_at: z.string(),
    html_url: z.string(),
  })
  .passthrough();

async function pullRequest(
  authority: GitHubReadAuthority,
  number: number,
  requestFetch: typeof fetch,
) {
  return pullRequestResponse.parse(
    await githubJson(
      authority,
      apiUrl(authority, `/pulls/${number}`),
      requestFetch,
    ),
  );
}

export function createGitHubReadAdapter(input: {
  readonly resolve: (repository: string) => GitHubReadAuthority;
  readonly fetch?: typeof fetch;
}): (request: GitHubReadProviderRequest) => Promise<GitHubReadResult> {
  const requestFetch = input.fetch ?? fetch;
  return async (rawRequest) => {
    const request = githubReadProviderRequestSchema.parse(rawRequest);
    const authority = input.resolve(request.input.repository);
    if (authority.repository !== request.input.repository) {
      throw new Error("GitHub read authority does not match the request");
    }

    switch (request.operation) {
      case "pull_request_get": {
        const result = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        return githubReadResultSchema.parse({
          version: "codeops.github-pull-request-snapshot/v1",
          repository: authority.repository,
          pullRequestNumber: result.number,
          title: result.title,
          body: result.body ?? "",
          state: result.state,
          merged: result.merged,
          draft: result.draft,
          authorLogin: result.user?.login ?? null,
          baseBranch: result.base.ref,
          baseSha: result.base.sha,
          headBranch: result.head.ref,
          headSha: result.head.sha,
          updatedAt: result.updated_at,
          url: result.html_url,
        });
      }
      case "pull_request_diff": {
        const identity = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        if (identity.head.sha !== request.input.expectedHeadSha) {
          throw new Error("GitHub pull-request head changed before diff read");
        }
        const response = await requestFetch(
          apiUrl(authority, `/pulls/${request.input.pullRequestNumber}`),
          {
            redirect: "error",
            headers: headers(authority, "application/vnd.github.diff"),
            signal: AbortSignal.timeout(30_000),
          },
        );
        const diff = await boundedText(response, request.input.maxBytes);
        const confirmedIdentity = await pullRequest(
          authority,
          request.input.pullRequestNumber,
          requestFetch,
        );
        if (confirmedIdentity.head.sha !== request.input.expectedHeadSha) {
          throw new Error("GitHub pull-request head changed during diff read");
        }
        return githubReadResultSchema.parse({
          version: "codeops.github-pull-request-diff-result/v1",
          repository: authority.repository,
          pullRequestNumber: request.input.pullRequestNumber,
          headSha: request.input.expectedHeadSha,
          ...diff,
        });
      }
      case "review_threads": {
        const { owner, name } = repositoryParts(authority);
        const body = z
          .object({
            data: z.object({
              repository: z.object({
                pullRequest: z
                  .object({
                    headRefOid: z.string(),
                    reviewThreads: z.object({
                      nodes: z.array(z.object({
                        id: z.string(),
                        isResolved: z.boolean(),
                        path: z.string().nullable(),
                        line: z.number().int().positive().nullable(),
                        originalLine: z.number().int().positive().nullable(),
                        comments: z.object({
                          nodes: z.array(z.object({
                            databaseId: z.number().int().positive(),
                            author: z.object({ login: z.string() }).nullable(),
                            body: z.string(),
                            createdAt: z.string(),
                            url: z.string(),
                          }).passthrough()).max(100),
                          pageInfo: z.object({ hasNextPage: z.boolean() }).passthrough(),
                        }).passthrough(),
                      }).passthrough()).max(100),
                      pageInfo: z.object({ hasNextPage: z.boolean() }).passthrough(),
                    }).passthrough(),
                  })
                  .passthrough()
                  .nullable(),
              }).passthrough().nullable(),
            }).passthrough(),
            errors: z.array(z.unknown()).optional(),
          })
          .passthrough()
          .parse(await githubJson(authority, "https://api.github.com/graphql", requestFetch, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: [
                "query CodeOpsGitHubReadThreads($owner: String!, $name: String!, $number: Int!, $limit: Int!) {",
                "  repository(owner: $owner, name: $name) {",
                "    pullRequest(number: $number) {",
                "      headRefOid",
                "      reviewThreads(first: $limit) {",
                "        nodes { id isResolved path line originalLine comments(first: 100) { nodes { databaseId author { login } body createdAt url } pageInfo { hasNextPage } } }",
                "        pageInfo { hasNextPage }",
                "      }",
                "    }",
                "  }",
                "}",
              ].join("\n"),
              variables: {
                owner,
                name,
                number: request.input.pullRequestNumber,
                limit: request.input.limit,
              },
            }),
          }));
        const pull = body.data.repository?.pullRequest ?? null;
        if (
          body.errors !== undefined ||
          pull === null ||
          pull.headRefOid !== request.input.expectedHeadSha ||
          pull.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasNextPage)
        ) {
          throw new Error("GitHub review-thread identity or bound is invalid");
        }
        return githubReadResultSchema.parse({
          version: "codeops.github-review-threads-result/v1",
          repository: authority.repository,
          pullRequestNumber: request.input.pullRequestNumber,
          headSha: request.input.expectedHeadSha,
          threads: pull.reviewThreads.nodes.map((thread) => ({
            threadId: thread.id,
            resolved: thread.isResolved,
            path: thread.path,
            line: thread.line,
            originalLine: thread.originalLine,
            comments: thread.comments.nodes.map((comment) => ({
              commentId: comment.databaseId,
              authorLogin: comment.author?.login ?? null,
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url,
            })),
          })),
          truncated: pull.reviewThreads.pageInfo.hasNextPage,
        });
      }
      case "checks": {
        const body = z.object({
          total_count: z.number().int().nonnegative(),
          check_runs: z.array(z.object({
            id: z.number().int().positive(),
            name: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
            head_sha: z.string(),
            started_at: z.string().nullable(),
            completed_at: z.string().nullable(),
            details_url: z.string().nullable(),
          }).passthrough()).max(100),
        }).passthrough().parse(await githubJson(
          authority,
          apiUrl(authority, `/commits/${request.input.headSha}/check-runs`, { per_page: "100" }),
          requestFetch,
        ));
        if (body.check_runs.some((check) => check.head_sha !== request.input.headSha)) {
          throw new Error("GitHub checks drifted from the requested head");
        }
        return githubReadResultSchema.parse({
          version: "codeops.github-checks-result/v1",
          repository: authority.repository,
          headSha: request.input.headSha,
          checks: body.check_runs.map((check) => ({
            checkRunId: check.id,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            startedAt: check.started_at,
            completedAt: check.completed_at,
            detailsUrl: check.details_url,
          })),
          truncated: body.total_count > body.check_runs.length,
        });
      }
      case "check_logs": {
        const identity = z.object({
          id: z.literal(request.input.checkRunId),
          head_sha: z.literal(request.input.headSha),
        }).passthrough().parse(await githubJson(
          authority,
          apiUrl(authority, `/check-runs/${request.input.checkRunId}`),
          requestFetch,
        ));
        void identity;
        let response = await requestFetch(
          apiUrl(authority, `/check-runs/${request.input.checkRunId}/logs`),
          {
            redirect: "manual",
            headers: headers(authority),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (location === null) throw new Error("GitHub check-log redirect is missing");
          const redirect = new URL(location);
          if (redirect.protocol !== "https:" || redirect.username || redirect.password) {
            throw new Error("GitHub check-log redirect is unsafe");
          }
          response = await requestFetch(redirect, {
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
        }
        return githubReadResultSchema.parse({
          version: "codeops.github-check-logs-result/v1",
          repository: authority.repository,
          headSha: request.input.headSha,
          checkRunId: request.input.checkRunId,
          ...(await boundedText(response, request.input.maxBytes)),
        });
      }
      case "protected_branch": {
        const body = z.object({
          name: z.literal(request.input.branch),
          protected: z.literal(true),
          commit: z.object({ sha: z.string() }).passthrough(),
        }).passthrough().parse(await githubJson(
          authority,
          apiUrl(authority, `/branches/${encodeURIComponent(request.input.branch)}`),
          requestFetch,
        ));
        return githubReadResultSchema.parse({
          version: "codeops.github-protected-branch-result/v1",
          repository: authority.repository,
          branch: body.name,
          headSha: body.commit.sha,
          protected: body.protected,
        });
      }
      case "search": {
        const isPullRequest = request.input.kind === "pull_requests";
        const q = `${request.input.query} repo:${authority.repository} ${isPullRequest ? "is:pr" : "is:issue"}`;
        const body = z.object({
          total_count: z.number().int().nonnegative(),
          incomplete_results: z.boolean(),
          items: z.array(z.object({
            number: z.number().int().positive(),
            title: z.string(),
            body: z.string().nullable(),
            state: z.enum(["open", "closed"]),
            draft: z.boolean().optional(),
            user: z.object({ login: z.string() }).nullable(),
            updated_at: z.string(),
            html_url: z.string(),
            pull_request: z.unknown().optional(),
          }).passthrough()).max(50),
        }).passthrough().parse(await githubJson(
          authority,
          new URL(`/search/issues?q=${encodeURIComponent(q)}&per_page=${request.input.limit}`, "https://api.github.com"),
          requestFetch,
        ));
        if (body.items.some((item) => (item.pull_request !== undefined) !== isPullRequest)) {
          throw new Error("GitHub search result kind drifted from the query");
        }
        return githubReadResultSchema.parse({
          version: "codeops.github-search-result/v1",
          repository: authority.repository,
          kind: request.input.kind,
          query: request.input.query,
          items: body.items.map((item) => ({
            kind: isPullRequest ? "pull_request" : "issue",
            number: item.number,
            title: item.title,
            excerpt: (item.body ?? "").slice(0, 2_000),
            state: item.state,
            draft: isPullRequest ? (item.draft ?? false) : null,
            authorLogin: item.user?.login ?? null,
            updatedAt: item.updated_at,
            url: item.html_url,
          })),
          truncated:
            body.incomplete_results || body.total_count > body.items.length,
        });
      }
    }
  };
}
