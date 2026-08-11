import {
  contractVersions,
  githubPullRequestStackLinkSchema,
  githubPullRequestStackSnapshotSchema,
  type GitHubPullRequestStackLink,
  type GitHubPullRequestStackSnapshot,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const branch = z.string().min(1).max(200);

const pullRequestSchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    merged_at: z.string().datetime({ offset: true }).nullable(),
    head: z
      .object({
        ref: branch,
        sha: gitSha,
      })
      .passthrough(),
    base: z
      .object({
        ref: branch,
        sha: gitSha,
      })
      .passthrough(),
    stack: z
      .object({
        number: z.number().int().positive().max(10_000_000),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const stackSchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    base: z.object({ ref: branch }).passthrough(),
    open: z.boolean(),
    pull_requests: z.array(pullRequestSchema).min(2).max(100),
  })
  .passthrough();

const minimalStackSchema = z
  .object({
    number: z.number().int().positive().max(10_000_000),
  })
  .passthrough();

function repositoryIdentity(repositoryUrl: string): {
  owner: string;
  name: string;
} {
  const repository = new URL(repositoryUrl);
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
    throw new Error("GitHub stack operation requires an exact HTTPS repository");
  }
  return { owner: match[1]!, name: match[2]! };
}

function token(value: string): string {
  if (value.length < 16 || /\s/.test(value)) {
    throw new Error("GitHub stack token is invalid");
  }
  return value;
}

function headers(value: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token(value)}`,
    "Content-Type": "application/json",
    "User-Agent": "codeops-control-gateway",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function normalizeStack(
  repository: string,
  value: unknown,
): GitHubPullRequestStackSnapshot {
  const stack = stackSchema.parse(value);
  return githubPullRequestStackSnapshotSchema.parse({
    version: contractVersions.githubPullRequestStackSnapshot,
    repository,
    number: stack.number,
    baseRef: stack.base.ref,
    open: stack.open,
    pullRequests: stack.pull_requests.map((pullRequest) => ({
      number: pullRequest.number,
      state: pullRequest.state,
      draft: pullRequest.draft,
      mergedAt: pullRequest.merged_at,
      head: pullRequest.head,
      base: pullRequest.base,
    })),
  });
}

async function request(input: {
  fetch: typeof fetch;
  token: string;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<Response> {
  return input.fetch(input.url, {
    method: input.method ?? "GET",
    redirect: "error",
    headers: headers(input.token),
    ...(input.body === undefined
      ? {}
      : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function loadGitHubPullRequestStack(input: {
  repositoryUrl: string;
  repositoryToken: string;
  stackNumber: number;
  fetch?: typeof fetch;
}): Promise<GitHubPullRequestStackSnapshot> {
  const repository = repositoryIdentity(input.repositoryUrl);
  const stackNumber = z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .parse(input.stackNumber);
  const response = await request({
    fetch: input.fetch ?? fetch,
    token: input.repositoryToken,
    url: `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/stacks/${stackNumber}`,
  });
  if (!response.ok) {
    throw new Error(`GitHub stack read failed with ${response.status}`);
  }
  return normalizeStack(
    `${repository.owner}/${repository.name}`,
    await response.json(),
  );
}

async function loadPullRequest(input: {
  fetch: typeof fetch;
  token: string;
  owner: string;
  name: string;
  number: number;
}): Promise<z.infer<typeof pullRequestSchema>> {
  const response = await request({
    fetch: input.fetch,
    token: input.token,
    url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/pulls/${input.number}`,
  });
  if (!response.ok) {
    throw new Error(`GitHub pull-request read failed with ${response.status}`);
  }
  return pullRequestSchema.parse(await response.json());
}

function verifyExactPullRequest(
  actual: z.infer<typeof pullRequestSchema>,
  expected: GitHubPullRequestStackLink["parent"],
): void {
  if (
    actual.number !== expected.number ||
    actual.state !== "open" ||
    actual.merged_at !== null ||
    actual.head.sha !== expected.headSha ||
    actual.head.ref !== expected.headRef ||
    actual.base.ref !== expected.baseRef
  ) {
    throw new Error("GitHub stack pull-request identity drifted");
  }
}

function verifyLinkedSnapshot(input: {
  snapshot: GitHubPullRequestStackSnapshot;
  link: GitHubPullRequestStackLink;
}): GitHubPullRequestStackSnapshot {
  const parentIndex = input.snapshot.pullRequests.findIndex(
    (entry) => entry.number === input.link.parent.number,
  );
  const childIndex = input.snapshot.pullRequests.findIndex(
    (entry) => entry.number === input.link.child.number,
  );
  if (parentIndex < 0 || childIndex !== parentIndex + 1) {
    throw new Error("GitHub stack did not retain the requested adjacent topology");
  }
  const parent = input.snapshot.pullRequests[parentIndex]!;
  const child = input.snapshot.pullRequests[childIndex]!;
  if (
    parent.head.sha !== input.link.parent.headSha ||
    parent.head.ref !== input.link.parent.headRef ||
    parent.base.ref !== input.link.parent.baseRef ||
    child.head.sha !== input.link.child.headSha ||
    child.head.ref !== input.link.child.headRef ||
    child.base.ref !== input.link.child.baseRef
  ) {
    throw new Error("GitHub stack response drifted from the exact requested heads");
  }
  return input.snapshot;
}

async function loadStackContaining(input: {
  fetch: typeof fetch;
  token: string;
  owner: string;
  name: string;
  pullRequestNumber: number;
}): Promise<number | null> {
  const response = await request({
    fetch: input.fetch,
    token: input.token,
    url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/stacks?pull_request=${input.pullRequestNumber}&per_page=2`,
  });
  if (!response.ok) {
    throw new Error(`GitHub stack membership read failed with ${response.status}`);
  }
  const stacks = z.array(minimalStackSchema).max(2).parse(await response.json());
  if (stacks.length > 1) {
    throw new Error("GitHub pull request belongs to multiple native stacks");
  }
  return stacks[0]?.number ?? null;
}

export async function linkGitHubPullRequestStack(input: {
  link: GitHubPullRequestStackLink;
  repositoryUrl: string;
  repositoryWriteToken: string;
  fetch?: typeof fetch;
}): Promise<GitHubPullRequestStackSnapshot> {
  const link = githubPullRequestStackLinkSchema.parse(input.link);
  const repository = repositoryIdentity(input.repositoryUrl);
  if (
    link.repository.owner !== repository.owner ||
    link.repository.name !== repository.name
  ) {
    throw new Error("GitHub stack link is outside the configured repository");
  }
  const requestFetch = input.fetch ?? fetch;
  const repositoryName = `${repository.owner}/${repository.name}`;
  const [parent, child] = await Promise.all([
    loadPullRequest({
      fetch: requestFetch,
      token: input.repositoryWriteToken,
      ...repository,
      number: link.parent.number,
    }),
    loadPullRequest({
      fetch: requestFetch,
      token: input.repositoryWriteToken,
      ...repository,
      number: link.child.number,
    }),
  ]);
  verifyExactPullRequest(parent, link.parent);
  verifyExactPullRequest(child, link.child);

  const [parentStack, childStack] = await Promise.all([
    loadStackContaining({
      fetch: requestFetch,
      token: input.repositoryWriteToken,
      ...repository,
      pullRequestNumber: link.parent.number,
    }),
    loadStackContaining({
      fetch: requestFetch,
      token: input.repositoryWriteToken,
      ...repository,
      pullRequestNumber: link.child.number,
    }),
  ]);
  if (childStack !== null) {
    if (parentStack !== childStack) {
      throw new Error("GitHub stack child already belongs to another topology");
    }
    return verifyLinkedSnapshot({
      snapshot: await loadGitHubPullRequestStack({
        repositoryUrl: input.repositoryUrl,
        repositoryToken: input.repositoryWriteToken,
        stackNumber: childStack,
        fetch: requestFetch,
      }),
      link,
    });
  }

  let url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/stacks`;
  let body: Readonly<{ pull_requests: readonly number[] }> = {
    pull_requests: [link.parent.number, link.child.number],
  };
  if (parentStack !== null) {
    const existing = await loadGitHubPullRequestStack({
      repositoryUrl: input.repositoryUrl,
      repositoryToken: input.repositoryWriteToken,
      stackNumber: parentStack,
      fetch: requestFetch,
    });
    if (
      existing.pullRequests.at(-1)?.number !== link.parent.number ||
      existing.pullRequests.at(-1)?.head.sha !== link.parent.headSha
    ) {
      throw new Error(
        "GitHub stack parent is not the exact current top; sibling fan-out must remain branch-only",
      );
    }
    url = `${url}/${parentStack}/add`;
    body = { pull_requests: [link.child.number] };
  }

  const response = await request({
    fetch: requestFetch,
    token: input.repositoryWriteToken,
    url,
    method: "POST",
    body,
  });
  if (!response.ok) {
    if (response.status !== 422) {
      throw new Error(`GitHub stack link failed with ${response.status}`);
    }
    const racedStack = await loadStackContaining({
      fetch: requestFetch,
      token: input.repositoryWriteToken,
      ...repository,
      pullRequestNumber: link.child.number,
    });
    if (racedStack === null) {
      throw new Error("GitHub stack link validation failed");
    }
    return verifyLinkedSnapshot({
      snapshot: await loadGitHubPullRequestStack({
        repositoryUrl: input.repositoryUrl,
        repositoryToken: input.repositoryWriteToken,
        stackNumber: racedStack,
        fetch: requestFetch,
      }),
      link,
    });
  }
  return verifyLinkedSnapshot({
    snapshot: normalizeStack(repositoryName, await response.json()),
    link,
  });
}
