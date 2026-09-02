import { createHash } from "node:crypto";
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
  type GitHubBranchPublishCandidate,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import {
  decodeProviderResponseText,
  readProviderResponse,
} from "./provider-response.js";
import type { RepositoryAuthority } from "./repository-registry.js";
import {
  GITHUB_BRANCH_PUBLICATION_DEADLINE_MS,
  GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS,
  GITHUB_BRANCH_PUBLICATION_WRITE_TIMEOUT_MS,
  mapGitHubPublicationBounded,
  preflightGitHubBranchPublicationRequest,
} from "./github-branch-publication.js";

const MAX_GITHUB_JSON_BYTES = 1 * 1_024 * 1_024;
const GITHUB_PULL_REQUEST_RECONCILIATION_MAX_PAGES = 10;
const GITHUB_REVIEW_THREAD_RECONCILIATION_MAX_PAGES = 10;
export const GITHUB_MUTATION_WRITE_TIMEOUT_MS =
  GITHUB_BRANCH_PUBLICATION_WRITE_TIMEOUT_MS;

export class GitHubMutationPreflightNoEffectError extends Error {}
export class GitHubMutationProviderAmbiguousError extends Error {}

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
  return (await githubJsonResponse(authority, url, requestFetch, init, [200, 201, 202, 204])).body;
}

async function githubJsonResponse(
  authority: RepositoryAuthority,
  url: URL | string,
  requestFetch: typeof fetch,
  init: RequestInit = {},
  statuses: readonly number[] = [200],
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await readProviderResponse({
    fetch: requestFetch,
    url,
    init: {
      ...init,
      headers: { ...headers(authority), ...(init.headers ?? {}) },
    },
    maxBytes: MAX_GITHUB_JSON_BYTES,
    statuses,
    mediaTypes: ["json"],
    ...(init.method === undefined || init.method === "GET"
      ? {}
      : { timeoutMs: GITHUB_MUTATION_WRITE_TIMEOUT_MS }),
  });
  if (response.bytes.byteLength === 0) {
    return { status: response.status, body: null };
  }
  try {
    return {
      status: response.status,
      body: JSON.parse(decodeProviderResponseText(response.bytes)),
    };
  } catch (error) {
    throw new Error("GitHub mutation response is not valid JSON", { cause: error });
  }
}

const pullRequestResponse = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    draft: z.boolean().optional(),
    base: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    head: z.object({ ref: z.string().optional(), sha: z.string() }).passthrough(),
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

const gitReferenceResponse = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string(), type: z.string() }).passthrough(),
}).passthrough();
const gitCommitResponse = z.object({
  sha: z.string(),
  message: z.string(),
  tree: z.object({ sha: z.string() }).passthrough(),
  parents: z.array(z.object({ sha: z.string() }).passthrough()),
}).passthrough();
const gitTreeResponse = z.object({
  sha: z.string(),
  tree: z.array(z.object({
    path: z.string(),
    mode: z.string(),
    type: z.string(),
    sha: z.string(),
  }).passthrough()).max(100_000),
}).passthrough();
const recursiveGitTreeResponse = gitTreeResponse.extend({
  truncated: z.literal(false),
});
const gitBlobResponse = z.object({
  sha: z.string(),
  encoding: z.literal("base64"),
  content: z.string(),
}).passthrough();
const gitWriteResponse = z.object({ sha: z.string() }).passthrough();

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

async function exactCreatePublicationTree(input: {
  readonly authority: RepositoryAuthority;
  readonly request: Extract<GitHubMutationProviderRequest, { readonly operation: "branch_publish" }>;
  readonly candidate: GitHubBranchPublishCandidate;
  readonly observedTreeSha: string;
  readonly requestFetch: typeof fetch;
}): Promise<boolean> {
  const readTree = async (sha: string) => recursiveGitTreeResponse.parse(
    await githubJson(
      input.authority,
      apiUrl(input.authority, `/git/trees/${sha}?recursive=1`),
      input.requestFetch,
    ),
  );
  const baseCommit = gitCommitResponse.parse(await githubJson(
    input.authority,
    apiUrl(input.authority, `/git/commits/${input.request.input.expectedHeadSha}`),
    input.requestFetch,
  ));
  if (baseCommit.sha !== input.request.input.expectedHeadSha) return false;
  const baseTree = await readTree(baseCommit.tree.sha);
  if (baseTree.sha !== baseCommit.tree.sha) return false;
  const entries = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
  const prepared = await mapGitHubPublicationBounded(
    input.candidate.changes,
    async (change) => {
      const entry = entries.get(change.path);
      let mode = "100644";
      let content = change.newText;
      if (change.oldText.length === 0) {
        if (entry !== undefined) return null;
        const parts = change.path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
          const parent = entries.get(parts.slice(0, index).join("/"));
          if (parent !== undefined && parent.type !== "tree") return null;
        }
      } else {
        if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
          return null;
        }
        const blob = gitBlobResponse.parse(await githubJson(
          input.authority,
          apiUrl(input.authority, `/git/blobs/${entry.sha}`),
          input.requestFetch,
        ));
        if (blob.sha !== entry.sha) return null;
        const encoded = blob.content.replace(/\s/g, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          return null;
        }
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(encoded, "base64"),
          );
        } catch {
          return null;
        }
        const at = source.indexOf(change.oldText);
        if (at < 0 || at !== source.lastIndexOf(change.oldText)) return null;
        content = `${source.slice(0, at)}${change.newText}${source.slice(at + change.oldText.length)}`;
        if (content === source) return null;
        mode = entry.mode;
      }
      return { path: change.path, mode, content };
    },
  );
  if (prepared.some((change) => change === null)) return false;
  const expected = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
  for (const change of prepared) {
    if (change === null) return false;
    const parts = change.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const path = parts.slice(0, index).join("/");
      const entry = expected.get(path);
      if (entry !== undefined && entry.type !== "tree") return false;
      if (entry === undefined) {
        expected.set(path, {
          path, mode: "040000", type: "tree", sha: "",
        });
      }
    }
    expected.set(change.path, {
      path: change.path,
      mode: change.mode,
      type: "blob",
      sha: gitBlobSha(change.content),
    });
  }
  const observed = await readTree(input.observedTreeSha);
  if (observed.sha !== input.observedTreeSha) return false;
  const identity = (entry: {
    readonly path: string; readonly mode: string;
    readonly type: string; readonly sha: string;
  }) => `${entry.path}\0${entry.mode}\0${entry.type}\0${
    entry.type === "tree" ? "" : entry.sha
  }`;
  return [...expected.values()].map(identity).sort().join("\n") ===
    observed.tree.map(identity).sort().join("\n");
}

async function gitReference(
  authority: RepositoryAuthority,
  branchName: string,
  requestFetch: typeof fetch,
) {
  return gitReferenceResponse.parse(await githubJson(
    authority,
    apiUrl(authority, `/git/ref/heads/${branchName.split("/").map(encodeURIComponent).join("/")}`),
    requestFetch,
  ));
}

async function optionalGitReference(
  authority: RepositoryAuthority,
  branchName: string,
  requestFetch: typeof fetch,
) {
  const response = await githubJsonResponse(
    authority,
    apiUrl(authority, `/git/ref/heads/${encodeURIComponent(branchName)}`),
    requestFetch,
    {},
    [200, 404],
  );
  return response.status === 404 ? null : gitReferenceResponse.parse(response.body);
}

function providerEffectText(operationId: string): string {
  return `codeops-provider-effect:${operationId}`;
}

function occurrenceCount(value: string, needle: string): number {
  let count = 0;
  for (let at = value.indexOf(needle); at >= 0;
       at = value.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

async function requireMissingBranch(
  authority: RepositoryAuthority,
  branchName: string,
  requestFetch: typeof fetch,
): Promise<void> {
  const response = await githubJsonResponse(
    authority,
    apiUrl(authority, `/git/ref/heads/${branchName.split("/").map(encodeURIComponent).join("/")}`),
    requestFetch,
    {},
    [200, 404],
  );
  if (response.status !== 404) {
    throw new Error("GitHub publication branch already exists");
  }
}

async function treeEntry(
  authority: RepositoryAuthority,
  rootTreeSha: string,
  repositoryPath: string,
  requestFetch: typeof fetch,
): Promise<{ readonly mode: string; readonly sha: string }> {
  let treeSha = rootTreeSha;
  const parts = repositoryPath.split("/");
  for (const [index, part] of parts.entries()) {
    const tree = gitTreeResponse.parse(await githubJson(
      authority,
      apiUrl(authority, `/git/trees/${treeSha}`),
      requestFetch,
    ));
    const entry = tree.tree.find((candidate) => candidate.path === part);
    const final = index === parts.length - 1;
    if (entry === undefined || (final ? entry.type !== "blob" : entry.type !== "tree")) {
      throw new Error(`GitHub base tree does not contain the required ${final ? "file" : "directory"}`);
    }
    if (final) return { mode: entry.mode, sha: entry.sha };
    treeSha = entry.sha;
  }
  throw new Error("GitHub repository path is empty");
}

async function optionalTreeEntry(
  authority: RepositoryAuthority,
  rootTreeSha: string,
  repositoryPath: string,
  requestFetch: typeof fetch,
): Promise<{ readonly mode: string; readonly sha: string } | null> {
  let treeSha = rootTreeSha;
  const parts = repositoryPath.split("/");
  for (const [index, part] of parts.entries()) {
    const tree = gitTreeResponse.parse(await githubJson(
      authority,
      apiUrl(authority, `/git/trees/${treeSha}`),
      requestFetch,
    ));
    const entry = tree.tree.find((candidate) => candidate.path === part);
    if (entry === undefined) return null;
    const final = index === parts.length - 1;
    if (final) {
      if (entry.type !== "blob") {
        throw new Error("GitHub publication path is not a regular file");
      }
      return { mode: entry.mode, sha: entry.sha };
    }
    if (entry.type !== "tree") {
      throw new Error("GitHub publication parent path is not a directory");
    }
    treeSha = entry.sha;
  }
  throw new Error("GitHub repository path is empty");
}

function expectedPermissionOperation(request: GitHubMutationProviderRequest) {
  const target = (() => {
    switch (request.operation) {
      case "branch_publish":
        return { pullRequestNumber: null, targetId: request.input.branchName };
      case "pull_request_create":
        return { pullRequestNumber: null, targetId: request.input.headBranch };
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

function assertProviderDigests(
  request: GitHubMutationProviderRequest,
  candidate?: GitHubBranchPublishCandidate,
): void {
  const inputs: unknown[] = [request.input];
  if (request.operation === "branch_publish" && candidate !== undefined) {
    const { candidate: _candidate, ...metadata } = request.input;
    inputs.push({ ...metadata, changes: candidate.changes });
  }
  const matches = inputs.some((inputValue) => {
    const candidateRequest = { ...request, input: inputValue } as GitHubMutationProviderRequest;
    return request.payloadDigest === sha256CanonicalJsonDigest(inputValue) &&
      request.permissionDigest ===
        sha256CanonicalJsonDigest(expectedPermissionOperation(candidateRequest));
  });
  if (!matches) {
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
              pageInfo: z.object({
                hasPreviousPage: z.boolean(),
                startCursor: z.string().nullable(),
              }).passthrough(),
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
  before?: string,
) {
  return reviewThreadIdentityResponse.parse(
    await githubJson(authority, "https://api.github.com/graphql", requestFetch, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: [
          "query CodeOpsMutationThread($threadId: ID!, $before: String) {",
          "  node(id: $threadId) {",
          "    ... on PullRequestReviewThread {",
          "      id pullRequest { number headRefOid repository { nameWithOwner } }",
          "      comments(last: 100, before: $before) { nodes { databaseId url body } pageInfo { hasPreviousPage startCursor } }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { threadId, before: before ?? null },
      }),
    }),
  );
}

export function createGitHubMutationReconciler(input: {
  readonly resolve: (repository: string) => RepositoryAuthority;
  readonly loadBranchCandidate?: (
    request: Extract<GitHubMutationProviderRequest, { readonly operation: "branch_publish" }>,
  ) => Promise<GitHubBranchPublishCandidate>;
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
    const candidate = request.operation === "branch_publish" &&
        input.loadBranchCandidate !== undefined
      ? await input.loadBranchCandidate(request)
      : undefined;
    assertProviderDigests(request, candidate);
    if (!Number.isFinite(attemptedAt.getTime()) || !Number.isFinite(observedAt.getTime()) || observedAt < attemptedAt) {
      throw new Error("GitHub reconciliation time identity is invalid");
    }
    const authority = input.resolve(request.input.repository);
    const windowElapsed = observedAt.getTime() - attemptedAt.getTime() >= consistencyWindowMs;
    const result = await (async () => {
    switch (request.operation) {
      case "branch_publish": {
        if (candidate === undefined) {
          throw new Error("GitHub branch publication candidate is unavailable for reconciliation");
        }
        const current = await optionalGitReference(
          authority,
          request.input.branchName,
          requestFetch,
        );
        if (current === null) {
          return windowElapsed
            ? {
                state: "reconciled_not_observed",
                result: null,
                summary: "The branch is absent after the provider consistency window.",
              }
            : {
                state: "unknown",
                result: null,
                summary: "The branch is absent, but the provider consistency window has not elapsed.",
              };
        }
        const commit = gitCommitResponse.parse(await githubJson(
          authority,
          apiUrl(authority, `/git/commits/${current.object.sha}`),
          requestFetch,
        ));
        const renderedMessage = `${request.input.commitMessage}\n\n${
          providerEffectText(request.operationId)
        }`;
        const identitySatisfied =
          current.ref === `refs/heads/${request.input.branchName}` &&
          current.object.type === "commit" &&
          commit.sha === current.object.sha &&
          commit.parents.length === 1 &&
          commit.parents[0]?.sha === request.input.expectedHeadSha &&
          commit.message === renderedMessage &&
          occurrenceCount(commit.message, providerEffectText(request.operationId)) === 1;
        if (!identitySatisfied) {
          return { state: "unknown", result: null, summary: "The branch commit does not contain the exact operation identity and base parent." };
        }
        const treeSatisfied = await exactCreatePublicationTree({
          authority, request, candidate, observedTreeSha: commit.tree.sha,
          requestFetch,
        });
        if (!treeSatisfied) {
          return { state: "unknown", result: null, summary: "The branch commit tree does not match the exact staged candidate result." };
        }
        return {
          state: "reconciled_satisfied",
          result: githubMutationResultSchema.parse({
            version: "codeops.github-branch-publish-result/v1",
            repository: authority.repository,
            operationId: request.operationId,
            baseBranch: request.input.baseBranch,
            branchName: request.input.branchName,
            baseSha: request.input.expectedHeadSha,
            headSha: commit.sha,
            url: `https://github.com/${authority.repository}/tree/${request.input.branchName
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`,
          }),
          summary: "The exact branch commit marker, base parent, and staged candidate tree match.",
        };
      }
      case "pull_request_create": {
        const { owner } = repositoryParts(authority);
        const query = apiUrl(authority, "/pulls");
        query.searchParams.set("state", "all");
        query.searchParams.set("head", `${owner}:${request.input.headBranch}`);
        query.searchParams.set("base", request.input.baseBranch);
        query.searchParams.set("per_page", "100");
        const marker = `<!-- ${providerEffectText(request.operationId)} -->`;
        const renderedBody = `${request.input.body}\n\n${marker}`;
        const matching: z.infer<typeof pullRequestResponse>[] = [];
        let markerOccurrences = 0;
        for (
          let page = 1;
          page <= GITHUB_PULL_REQUEST_RECONCILIATION_MAX_PAGES;
          page += 1
        ) {
          query.searchParams.set("page", String(page));
          const pulls = z.array(pullRequestResponse).max(100).parse(
            await githubJson(authority, query, requestFetch),
          );
          for (const candidate of pulls) {
            const body = candidate.body ?? "";
            markerOccurrences += occurrenceCount(body, marker);
            if (body === renderedBody) matching.push(candidate);
          }
          if (pulls.length < 100) break;
          if (page === GITHUB_PULL_REQUEST_RECONCILIATION_MAX_PAGES) {
            throw new GitHubMutationProviderAmbiguousError(
              "pull-request reconciliation exceeded its bounded provider search",
            );
          }
        }
        if (markerOccurrences > 1 || matching.length > 1) {
          throw new GitHubMutationProviderAmbiguousError(
            "pull-request reconciliation found duplicate provider effect markers",
          );
        }
        const current = matching[0];
        if (
          current === undefined ||
          markerOccurrences !== 1 ||
          current.head.sha !== request.input.expectedHeadSha ||
          current.base.sha !== request.input.expectedBaseSha ||
          current.head.ref !== request.input.headBranch ||
          current.base.ref !== request.input.baseBranch ||
          current.title !== request.input.title ||
          current.body !== renderedBody ||
          (current.draft ?? false) !== request.input.draft
        ) {
          return { state: "unknown", result: null, summary: "No pull request has the exact operation marker and ref identities." };
        }
        return {
          state: "reconciled_satisfied",
          result: githubMutationResultSchema.parse({
            version: "codeops.github-pull-request-create-result/v1",
            repository: authority.repository,
            operationId: request.operationId,
            pullRequestNumber: current.number,
            headSha: current.head.sha,
            baseSha: current.base.sha,
            headBranch: current.head.ref,
            baseBranch: current.base.ref,
            title: current.title,
            body: request.input.body,
            draft: current.draft ?? false,
            url: current.html_url,
          }),
          summary: "The pull request has the exact operation marker and ref identities.",
        };
      }
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
        const marker = githubEffectMarker(request.operationId);
        const matching: Array<{
          readonly databaseId: number;
          readonly url: string;
          readonly body: string;
        }> = [];
        let markerOccurrences = 0;
        const renderedBody = `${request.input.body}\n\n${marker}`;
        let threadIdentity: {
          readonly number: number;
          readonly headRefOid: string;
        } | undefined;
        let before: string | undefined;
        for (
          let page = 1;
          page <= GITHUB_REVIEW_THREAD_RECONCILIATION_MAX_PAGES;
          page += 1
        ) {
          const current = await reviewThreadIdentity(
            authority,
            request.input.threadId,
            requestFetch,
            before,
          );
          const thread = current.data.node;
          if (
            current.errors !== undefined ||
            thread === null ||
            thread.comments === undefined ||
            thread.pullRequest.number !== request.input.pullRequestNumber ||
            thread.pullRequest.repository.nameWithOwner !== authority.repository ||
            (threadIdentity !== undefined &&
              (thread.pullRequest.number !== threadIdentity.number ||
                thread.pullRequest.headRefOid !== threadIdentity.headRefOid))
          ) {
            return { state: "unknown", result: null, summary: "The review-thread identity cannot be proved." };
          }
          threadIdentity = {
            number: thread.pullRequest.number,
            headRefOid: thread.pullRequest.headRefOid,
          };
          for (const entry of thread.comments.nodes) {
            if (entry === null) continue;
            markerOccurrences += occurrenceCount(entry.body, marker);
            if (entry.body === renderedBody) matching.push(entry);
          }
          if (!thread.comments.pageInfo.hasPreviousPage) break;
          if (
            page === GITHUB_REVIEW_THREAD_RECONCILIATION_MAX_PAGES ||
            thread.comments.pageInfo.startCursor === null
          ) {
            throw new GitHubMutationProviderAmbiguousError(
              "review-thread reconciliation exceeded its bounded provider search",
            );
          }
          before = thread.comments.pageInfo.startCursor;
        }
        if (markerOccurrences > 1 || matching.length > 1) {
          throw new GitHubMutationProviderAmbiguousError(
            "review-thread reconciliation found duplicate provider effect markers",
          );
        }
        const comment = matching[0];
        if (comment !== undefined && threadIdentity !== undefined &&
            markerOccurrences === 1 &&
            threadIdentity.headRefOid === request.input.expectedHeadSha) {
          return {
            state: "reconciled_satisfied",
            result: githubMutationResultSchema.parse({
              version: "codeops.github-review-thread-reply-result/v1",
              repository: authority.repository,
              operationId: request.operationId,
              pullRequestNumber: threadIdentity.number,
              headSha: threadIdentity.headRefOid,
              threadId: request.input.threadId,
              commentId: comment.databaseId,
              url: comment.url,
            }),
            summary: "The exact hidden operation marker is present in the review thread.",
          };
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
            body: z.string(),
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

export const GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS =
  GITHUB_BRANCH_PUBLICATION_DEADLINE_MS;

export function createGitHubMutationAdapter(input: {
  readonly resolve: (repository: string) => RepositoryAuthority;
  readonly loadBranchCandidate: (
    request: Extract<GitHubMutationProviderRequest, { readonly operation: "branch_publish" }>,
  ) => Promise<GitHubBranchPublishCandidate>;
  readonly fetch?: typeof fetch;
  readonly branchPublicationTimeoutMs?: number;
}): (request: GitHubMutationProviderRequest) => Promise<GitHubMutationResult> {
  const requestFetch = input.fetch ?? fetch;
  return async (rawRequest) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    const branchCandidate = request.operation === "branch_publish"
      ? await preflight(() => input.loadBranchCandidate(request))
      : undefined;
    assertProviderDigests(request, branchCandidate);
    const authority = input.resolve(request.input.repository);
    if (authority.repository !== request.input.repository) {
      throw new Error("GitHub mutation authority does not match the request");
    }
    repositoryParts(authority);

    switch (request.operation) {
      case "branch_publish": {
        await preflight(async () => preflightGitHubBranchPublicationRequest(
          request.input, branchCandidate!.changes,
        ));
        const publicationTimeoutMs = input.branchPublicationTimeoutMs ??
          GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS;
        if (
          !Number.isSafeInteger(publicationTimeoutMs) ||
          publicationTimeoutMs < 1 ||
          publicationTimeoutMs > GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS
        ) {
          throw new Error("GitHub branch publication timeout is invalid");
        }
        const publicationDeadline = Date.now() + publicationTimeoutMs;
        const publicationJsonResponse = async (
          path: string,
          init: RequestInit = {},
          statuses: readonly number[] = [200, 201, 202, 204],
        ): Promise<{ readonly status: number; readonly body: unknown }> => {
          const remainingMs = publicationDeadline - Date.now();
          if (remainingMs < 1) {
            throw new DOMException(
              "GitHub branch publication deadline exceeded",
              "TimeoutError",
            );
          }
          const operationTimeoutMs = init.method === undefined || init.method === "GET"
            ? GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS
            : GITHUB_MUTATION_WRITE_TIMEOUT_MS;
          const response = await readProviderResponse({
            fetch: requestFetch,
            url: apiUrl(authority, path),
            init: {
              ...init,
              headers: { ...headers(authority), ...(init.headers ?? {}) },
            },
            maxBytes: MAX_GITHUB_JSON_BYTES,
            statuses,
            mediaTypes: ["json"],
            timeoutMs: Math.min(operationTimeoutMs, remainingMs),
          });
          if (response.bytes.byteLength === 0) {
            return { status: response.status, body: null };
          }
          try {
            return {
              status: response.status,
              body: JSON.parse(decodeProviderResponseText(response.bytes)),
            };
          } catch (error) {
            throw new Error("GitHub mutation response is not valid JSON", { cause: error });
          }
        };
        const publicationJson = async (
          path: string,
          init: RequestInit = {},
        ): Promise<unknown> => (await publicationJsonResponse(path, init)).body;
        const { publishGitHubBranch } = await import("./github-branch-publication.js");
        const headSha = await publishGitHubBranch({
          request,
          preflight,
          effectText: providerEffectText,
          changes: branchCandidate!.changes,
          provider: {
            readBranch: async (branchName, allowMissing = false) => {
              const response = await publicationJsonResponse(
                `/git/ref/heads/${branchName.split("/").map(encodeURIComponent).join("/")}`,
                {},
                allowMissing ? [200, 404] : [200],
              );
              return response.status === 404
                ? null
                : gitReferenceResponse.parse(response.body);
            },
            readCommit: async (sha) => gitCommitResponse.parse(
              await publicationJson(`/git/commits/${sha}`),
            ),
            readTree: async (sha) => gitTreeResponse.parse(
              await publicationJson(`/git/trees/${sha}`),
            ),
            readBlob: async (sha) => gitBlobResponse.parse(
              await publicationJson(`/git/blobs/${sha}`),
            ),
            createBlob: async (content) => gitWriteResponse.parse(
              await publicationJson("/git/blobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content, encoding: "utf-8" }),
              }),
            ).sha,
            createTree: async (baseTreeSha, tree) => gitWriteResponse.parse(
              await publicationJson("/git/trees", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base_tree: baseTreeSha, tree }),
              }),
            ).sha,
            createCommit: async (message, tree, parent) => gitWriteResponse.parse(
              await publicationJson("/git/commits", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message, tree, parents: [parent] }),
              }),
            ).sha,
            createBranch: async (branchName, sha) => {
              await publicationJson("/git/refs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
              });
            },
          },
        });
        return githubMutationResultSchema.parse({
          version: "codeops.github-branch-publish-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          baseBranch: request.input.baseBranch,
          branchName: request.input.branchName,
          baseSha: request.input.expectedHeadSha,
          headSha,
          url: `https://github.com/${authority.repository}/tree/${request.input.branchName
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
        });
      }
      case "pull_request_create": {
        await preflight(async () => {
          const head = await gitReference(authority, request.input.headBranch, requestFetch);
          const base = await gitReference(authority, request.input.baseBranch, requestFetch);
          if (
            head.ref !== `refs/heads/${request.input.headBranch}` ||
            base.ref !== `refs/heads/${request.input.baseBranch}` ||
            head.object.type !== "commit" ||
            base.object.type !== "commit" ||
            head.object.sha !== request.input.expectedHeadSha ||
            base.object.sha !== request.input.expectedBaseSha
          ) {
            throw new Error("GitHub pull-request refs changed before creation");
          }
          const { owner } = repositoryParts(authority);
          const query = apiUrl(authority, "/pulls");
          query.searchParams.set("state", "all");
          query.searchParams.set("head", `${owner}:${request.input.headBranch}`);
          query.searchParams.set("base", request.input.baseBranch);
          query.searchParams.set("per_page", "2");
          const existing = z.array(pullRequestResponse).max(2).parse(
            await githubJson(authority, query, requestFetch),
          );
          if (existing.length > 1) {
            throw new GitHubMutationProviderAmbiguousError(
              "more than one pull request matches the exact head and base refs",
            );
          }
          if (existing.length !== 0) {
            throw new Error("GitHub pull request already exists for the exact branches");
          }
        });
        const marker = `<!-- ${providerEffectText(request.operationId)} -->`;
        const created = pullRequestResponse.parse(await githubJson(
          authority,
          apiUrl(authority, "/pulls"),
          requestFetch,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: request.input.title,
              body: `${request.input.body}\n\n${marker}`,
              head: request.input.headBranch,
              base: request.input.baseBranch,
              draft: request.input.draft,
            }),
          },
        ));
        const after = await pullRequest(authority, created.number, requestFetch);
        if (
          after.number !== created.number ||
          after.head.sha !== request.input.expectedHeadSha ||
          after.base.sha !== request.input.expectedBaseSha ||
          after.head.ref !== request.input.headBranch ||
          after.base.ref !== request.input.baseBranch ||
          after.title !== request.input.title ||
          after.body !== `${request.input.body}\n\n${marker}` ||
          (after.draft ?? false) !== request.input.draft
        ) {
          throw new Error("GitHub pull-request identity changed during creation");
        }
        return githubMutationResultSchema.parse({
          version: "codeops.github-pull-request-create-result/v1",
          repository: authority.repository,
          operationId: request.operationId,
          pullRequestNumber: after.number,
          headSha: after.head.sha,
          baseSha: after.base.sha,
          headBranch: after.head.ref,
          baseBranch: after.base.ref,
          title: after.title,
          body: request.input.body,
          draft: after.draft ?? false,
          url: after.html_url,
        });
      }
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
                  "    comment { databaseId url body pullRequest { number headRefOid repository { nameWithOwner } } }",
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
          || comment.body !== `${request.input.body}\n\n${githubEffectMarker(request.operationId)}`
          || occurrenceCount(comment.body, githubEffectMarker(request.operationId)) !== 1
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
