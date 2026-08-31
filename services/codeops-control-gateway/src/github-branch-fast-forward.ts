import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubMutationProviderRequestSchema,
  githubMutationReconciliationResultSchema,
  githubMutationResultSchema,
  sessionPermissionOperationSchema,
  sha256CanonicalJsonDigest,
  type GitHubMutationProviderRequest,
  type GitHubMutationReconciliationResult,
  type GitHubBranchPublishCandidate,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { createGitHubMutationAdapter as createBaseAdapter, createGitHubMutationReconciler as createBaseReconciler, GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS, GITHUB_MUTATION_WRITE_TIMEOUT_MS, GitHubMutationPreflightNoEffectError } from "./github-mutations-adapter.js";
import {
  GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS,
  mapGitHubPublicationBounded,
  preflightGitHubBranchPublicationRequest,
} from "./github-branch-publication.js";
import { decodeProviderResponseText, readProviderResponse } from "./provider-response.js";
import type { RepositoryAuthority } from "./repository-registry.js";

type Request = GitHubMutationProviderRequest & { operation: "branch_publish" };
type Json = (path: string, init?: RequestInit) => Promise<unknown>;
const ref = z.object({ ref: z.string(), object: z.object({ sha: z.string(), type: z.string() }).passthrough() }).passthrough();
const commit = z.object({ sha: z.string(), message: z.string(), tree: z.object({ sha: z.string() }).passthrough(), parents: z.array(z.object({ sha: z.string() }).passthrough()).max(2) }).passthrough();
const tree = z.object({ sha: z.string(), truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }).passthrough()).max(100_000) }).passthrough();
const blob = z.object({ sha: z.string(), encoding: z.literal("base64"), content: z.string() }).passthrough();
const created = z.object({ data: z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: z.string(), message: z.string(), tree: z.object({ oid: z.string() }), parents: z.object({ nodes: z.array(z.object({ oid: z.string() })).max(2) }) }).passthrough() }).nullable() }), errors: z.array(z.unknown()).optional() }).passthrough();
const marker = (id: string) => `codeops-provider-effect:${id}`;

function message(request: Request) {
  const [headline, ...lines] = request.input.commitMessage.split("\n");
  const body = [...lines, ...(lines.length === 0 ? [] : [""]), marker(request.operationId)].join("\n");
  return { headline: headline!, body, text: `${headline}\n\n${body}` };
}
function blobSha(content: string) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
function provider(json: Json) {
  const trees = new Map<string, Promise<z.infer<typeof tree>>>();
  return {
    branch: async (name: string) => ref.parse(await json(`/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`)),
    commit: async (sha: string) => commit.parse(await json(`/git/commits/${sha}`)),
    tree: (sha: string) => {
      let value = trees.get(sha);
      if (value === undefined) {
        value = json(`/git/trees/${sha}?recursive=1`).then((body) => tree.parse(body));
        trees.set(sha, value);
      }
      return value;
    },
    blob: async (sha: string) => blob.parse(await json(`/git/blobs/${sha}`)),
  };
}

async function prepare(request: Request, changes: GitHubBranchPublishCandidate["changes"], prior: z.infer<typeof commit>, p: ReturnType<typeof provider>) {
  const root = await p.tree(prior.tree.sha);
  if (root.sha !== prior.tree.sha) throw new Error("GitHub publication tree identity changed");
  const entries = new Map(root.tree.map((entry) => [entry.path, entry]));
  return mapGitHubPublicationBounded(changes, async (change) => {
    const entry = entries.get(change.path);
    let mode = "100644", content = change.newText;
    if (change.oldText.length === 0) {
      if (entry !== undefined) throw new Error("GitHub new-file publication path already exists");
      const parts = change.path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const parent = entries.get(parts.slice(0, index).join("/"));
        if (parent !== undefined && parent.type !== "tree") throw new Error("GitHub publication parent path is not a directory");
      }
    } else {
      if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("GitHub publication supports existing regular files only");
      const current = await p.blob(entry.sha);
      if (current.sha !== entry.sha) throw new Error("GitHub publication blob identity changed");
      const encoded = current.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("GitHub publication blob is not canonical base64");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
      const at = source.indexOf(change.oldText);
      if (at < 0 || at !== source.lastIndexOf(change.oldText)) throw new Error("GitHub publication old text must match exactly once");
      content = `${source.slice(0, at)}${change.newText}${source.slice(at + change.oldText.length)}`;
      if (content === source) throw new Error("GitHub publication change must modify the file");
      mode = entry.mode;
    }
    return { path: change.path, mode, content };
  });
}

async function exactTree(p: ReturnType<typeof provider>, parentSha: string, candidateSha: string, changes: readonly { path: string; mode: string; content: string }[]) {
  const [parent, candidate] = await mapGitHubPublicationBounded([parentSha, candidateSha], (sha) => p.tree(sha));
  if (parent?.sha !== parentSha || candidate?.sha !== candidateSha) return false;
  const expected = new Map(parent.tree.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    const parts = change.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const path = parts.slice(0, index).join("/"), entry = expected.get(path);
      if (entry !== undefined && entry.type !== "tree") return false;
      if (entry === undefined) expected.set(path, { path, mode: "040000", type: "tree", sha: "" });
    }
    expected.set(change.path, { path: change.path, mode: change.mode, type: "blob", sha: blobSha(change.content) });
  }
  const id = (entry: { path: string; mode: string; type: string; sha: string }) => `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.type === "tree" ? "" : entry.sha}`;
  return [...expected.values()].map(id).sort().join("\n") === candidate.tree.map(id).sort().join("\n");
}

async function replayMatches(request: Request, candidate: GitHubBranchPublishCandidate, currentSha: string, p: ReturnType<typeof provider>) {
  const priorSha = request.input.expectedBranchHeadSha!, priorEffect = request.input.expectedBranchHeadEffectId!;
  const [prior, current] = await mapGitHubPublicationBounded([priorSha, currentSha], (sha) => p.commit(sha));
  if (prior?.sha !== priorSha || !prior.message.split(/\r?\n/).includes(marker(priorEffect)) || current?.sha !== currentSha || current.parents.length !== 1 || current.parents[0]?.sha !== priorSha || current.message !== message(request).text) return false;
  const changes = await prepare(request, candidate.changes, prior, p);
  return exactTree(p, prior.tree.sha, current.tree.sha, changes);
}

export async function publishGitHubFastForward(input: { request: Request; candidate: GitHubBranchPublishCandidate; json: Json; preflight: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const { request } = input, priorSha = request.input.expectedBranchHeadSha!, priorEffect = request.input.expectedBranchHeadEffectId!, p = provider(input.json);
  const reads: readonly (() => Promise<unknown>)[] = [
    () => p.branch(request.input.baseBranch), () => p.branch(request.input.branchName),
    () => p.commit(request.input.expectedHeadSha), () => p.commit(priorSha),
  ];
  const [baseRef, targetRef, baseCommit, prior] = await input.preflight(() => mapGitHubPublicationBounded(reads, (read) => read())) as [z.infer<typeof ref>, z.infer<typeof ref>, z.infer<typeof commit>, z.infer<typeof commit>];
  if (baseRef.ref !== `refs/heads/${request.input.baseBranch}` || targetRef.ref !== `refs/heads/${request.input.branchName}` || baseRef.object.type !== "commit" || targetRef.object.type !== "commit" || baseRef.object.sha !== request.input.expectedHeadSha || baseCommit.sha !== request.input.expectedHeadSha || prior.sha !== priorSha || !prior.message.split(/\r?\n/).includes(marker(priorEffect))) throw new Error("GitHub publication base, target, or durable branch identity does not match");
  if (targetRef.object.sha !== priorSha) {
    if (!(await input.preflight(() => replayMatches(request, input.candidate, targetRef.object.sha, p)))) throw new Error("GitHub publication branch does not match the exact replay");
    return targetRef.object.sha;
  }
  const changes = await input.preflight(() => prepare(request, input.candidate.changes, prior, p));
  const commitMessage = message(request);
  const response = created.parse(await input.json("https://api.github.com/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "mutation CodeOpsCreateCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid message tree { oid } parents(first: 2) { nodes { oid } } } } }", variables: { input: { branch: { repositoryNameWithOwner: request.input.repository, branchName: request.input.branchName }, expectedHeadOid: priorSha, message: { headline: commitMessage.headline, body: commitMessage.body }, fileChanges: { additions: changes.map(({ path, content }) => ({ path, contents: Buffer.from(content).toString("base64") })) } } } }) }));
  const value = response.data.createCommitOnBranch?.commit;
  if (response.errors !== undefined || value === undefined) throw new Error("GitHub atomic target-branch publication failed");
  if (value.oid === priorSha || value.message !== commitMessage.text || value.parents.nodes.length !== 1 || value.parents.nodes[0]?.oid !== priorSha) throw new Error("GitHub atomic target-branch publication returned an invalid commit");
  if (!(await exactTree(p, prior.tree.sha, value.tree.oid, changes))) throw new Error("GitHub publication tree mismatch");
  const after = await p.branch(request.input.branchName);
  if (after.ref !== `refs/heads/${request.input.branchName}` || after.object.type !== "commit" || after.object.sha !== value.oid) throw new Error("GitHub publication branch changed after its atomic update");
  return value.oid;
}

function authorityParts(authority: RepositoryAuthority) {
  const url = new URL(authority.repositoryUrl), match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/);
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !match || `${match[1]}/${match[2]}` !== authority.repository || authority.writeToken.length < 16 || authority.writeToken.length > 4_096 || /\s/.test(authority.writeToken)) throw new Error("GitHub mutation authority is invalid");
  return { owner: match[1]!, name: match[2]! };
}
function api(authority: RepositoryAuthority, path: string) { const { owner, name } = authorityParts(authority); return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`; }
function remote(authority: RepositoryAuthority, requestFetch: typeof fetch): Json {
  return async (path, init = {}) => {
    const response = await readProviderResponse({ fetch: requestFetch, url: api(authority, path), init: { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${authority.writeToken}`, "User-Agent": "codeops-control-gateway", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) } }, maxBytes: 1_024 * 1_024, statuses: [200], mediaTypes: ["json"] });
    return JSON.parse(decodeProviderResponseText(response.bytes));
  };
}
function requireDigests(request: Request, candidate: GitHubBranchPublishCandidate) {
  const { candidate: _candidate, ...metadata } = request.input;
  const inputs = [request.input, { ...metadata, changes: candidate.changes }];
  if (!inputs.some((value) => {
    const permission = sessionPermissionOperationSchema.parse({ kind: "github_mutation", repository: request.input.repository, operation: request.operation, pullRequestNumber: null, targetId: request.input.branchName, expectedHeadSha: request.input.expectedHeadSha, payloadJson: canonicalJsonText(value) });
    return request.payloadDigest === sha256CanonicalJsonDigest(value) && request.permissionDigest === sha256CanonicalJsonDigest(permission);
  })) throw new Error("GitHub mutation payload and durable permission digests do not match");
}

export function createGitHubMutationReconciler(input: { resolve: (repository: string) => RepositoryAuthority; loadBranchCandidate: (request: Request) => Promise<GitHubBranchPublishCandidate>; fetch?: typeof fetch; consistencyWindowMs?: number }): (request: GitHubMutationProviderRequest, attemptedAt: Date, observedAt?: Date) => Promise<GitHubMutationReconciliationResult> {
  const base = createBaseReconciler(input), requestFetch = input.fetch ?? fetch, window = input.consistencyWindowMs ?? 60_000;
  return async (raw, attemptedAt, observedAt = new Date()) => {
    const request = githubMutationProviderRequestSchema.parse(raw);
    if (request.operation !== "branch_publish" || request.input.mode !== "fast_forward") return base(request, attemptedAt, observedAt);
    if (!Number.isFinite(attemptedAt.getTime()) || !Number.isFinite(observedAt.getTime()) || observedAt < attemptedAt) throw new Error("GitHub reconciliation time identity is invalid");
    const candidate = await input.loadBranchCandidate(request);
    requireDigests(request, candidate);
    const authority = input.resolve(request.input.repository), p = provider(remote(authority, requestFetch));
    try {
      const current = await p.branch(request.input.branchName);
      if (current.ref === `refs/heads/${request.input.branchName}` && current.object.type === "commit" && current.object.sha === request.input.expectedBranchHeadSha) {
        const elapsed = observedAt.getTime() - attemptedAt.getTime() >= window;
        return githubMutationReconciliationResultSchema.parse({ version: "codeops.github-mutation-reconciliation-result/v1", state: elapsed ? "reconciled_not_observed" : "unknown", result: null, summary: elapsed ? "The exact prior branch head remains after the provider consistency window." : "The exact prior branch head remains within the provider consistency window." });
      }
      const satisfied = current.ref === `refs/heads/${request.input.branchName}` && current.object.type === "commit" && await replayMatches(request, candidate, current.object.sha, p);
      return githubMutationReconciliationResultSchema.parse({ version: "codeops.github-mutation-reconciliation-result/v1", state: satisfied ? "reconciled_satisfied" : "unknown", result: satisfied ? githubMutationResultSchema.parse({ version: "codeops.github-branch-publish-result/v1", repository: authority.repository, operationId: request.operationId, baseBranch: request.input.baseBranch, branchName: request.input.branchName, baseSha: request.input.expectedHeadSha, headSha: current.object.sha, url: `https://github.com/${authority.repository}/tree/${request.input.branchName.split("/").map(encodeURIComponent).join("/")}` }) : null, summary: satisfied ? "The exact atomic branch commit, prior parent, message, and complete tree match." : "The branch does not contain the exact requested atomic commit and tree." });
    } catch (error) {
      if (error instanceof GitHubMutationPreflightNoEffectError) throw error;
      return githubMutationReconciliationResultSchema.parse({ version: "codeops.github-mutation-reconciliation-result/v1", state: "unknown", result: null, summary: "The fast-forward branch identity cannot be proved." });
    }
  };
}

export function createGitHubMutationAdapter(input: { resolve: (repository: string) => RepositoryAuthority; loadBranchCandidate: (request: Request) => Promise<GitHubBranchPublishCandidate>; fetch?: typeof fetch; branchPublicationTimeoutMs?: number }) {
  const base = createBaseAdapter(input), requestFetch = input.fetch ?? fetch;
  return async (raw: GitHubMutationProviderRequest) => {
    const request = githubMutationProviderRequestSchema.parse(raw);
    if (request.operation !== "branch_publish" || request.input.mode !== "fast_forward") return base(request);
    const preflight = async <T>(operation: () => Promise<T>) => { try { return await operation(); } catch (error) { throw new GitHubMutationPreflightNoEffectError(`GitHub mutation preflight proved that no remote effect occurred: ${error instanceof Error ? error.message : "unknown preflight failure"}`, { cause: error }); } };
    const candidate = await preflight(() => input.loadBranchCandidate(request));
    requireDigests(request, candidate);
    await preflight(async () => preflightGitHubBranchPublicationRequest(request.input, candidate.changes));
    const authority = input.resolve(request.input.repository);
    if (authority.repository !== request.input.repository) throw new Error("GitHub mutation authority does not match the request");
    authorityParts(authority);
    const timeout = input.branchPublicationTimeoutMs ?? GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > GITHUB_BRANCH_PUBLICATION_TIMEOUT_MS) throw new Error("GitHub branch publication timeout is invalid");
    const deadline = Date.now() + timeout;
    const json: Json = async (path, init = {}) => {
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new DOMException("GitHub branch publication deadline exceeded", "TimeoutError");
      const response = await readProviderResponse({ fetch: requestFetch, url: path === "https://api.github.com/graphql" ? path : api(authority, path), init: { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${authority.writeToken}`, "User-Agent": "codeops-control-gateway", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) } }, maxBytes: 1_024 * 1_024, statuses: [200], mediaTypes: ["json"], timeoutMs: Math.min(init.method === undefined || init.method === "GET" ? GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS : GITHUB_MUTATION_WRITE_TIMEOUT_MS, remaining) });
      return JSON.parse(decodeProviderResponseText(response.bytes));
    };
    const headSha = await publishGitHubFastForward({ request, candidate, json, preflight });
    return githubMutationResultSchema.parse({ version: "codeops.github-branch-publish-result/v1", repository: authority.repository, operationId: request.operationId, baseBranch: request.input.baseBranch, branchName: request.input.branchName, baseSha: request.input.expectedHeadSha, headSha, url: `https://github.com/${authority.repository}/tree/${request.input.branchName.split("/").map(encodeURIComponent).join("/")}` });
  };
}
