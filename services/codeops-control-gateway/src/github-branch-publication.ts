export const GITHUB_BRANCH_PUBLICATION_CONCURRENCY = 4;
export const GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS = 30_000;
export const GITHUB_BRANCH_PUBLICATION_WRITE_TIMEOUT_MS = 120_000;
export const GITHUB_BRANCH_PUBLICATION_DEADLINE_MS = 230_000;
export const GITHUB_BRANCH_PUBLICATION_BODY_BYTES = 4_194_304;
export const GITHUB_BRANCH_PUBLICATION_CHANGED_PATHS = 20;
export const GITHUB_BRANCH_PUBLICATION_READ_WAVE_MS = 10_000;
export const GITHUB_BRANCH_PUBLICATION_WRITE_WAVE_MS = 30_000;
export const GITHUB_BRANCH_PUBLICATION_SAFETY_MARGIN_MS = 20_000;

export type GitHubBranchPublicationRequest = {
  readonly operationId: string;
  readonly input: {
    readonly repository?: string;
    readonly mode?: "create" | "fast_forward";
    readonly expectedHeadSha: string;
    readonly baseBranch: string;
    readonly branchName: string;
    readonly commitMessage: string;
    readonly candidate: {
      readonly manifestId: string; readonly digest: string;
      readonly sizeBytes: number; readonly chunkCount: number;
    };
  };
};

type GitHubBranchPublicationChange = {
  readonly path: string; readonly oldText: string; readonly newText: string;
};

function invalidRequestCounts(): Error {
  return new Error("GitHub branch publication request counts are invalid");
}

export function estimateGitHubBranchPublicationDeadline(input: {
  readonly readPhases: readonly number[];
  readonly writePhases: readonly number[];
}): number {
  const phases = [...input.readPhases, ...input.writePhases];
  if (phases.some((requests) =>
    !Number.isSafeInteger(requests) || requests < 0
  )) {
    throw invalidRequestCounts();
  }
  const waves = (requests: number) => Math.ceil(
    requests / GITHUB_BRANCH_PUBLICATION_CONCURRENCY,
  );
  const readWaves = input.readPhases.reduce(
    (total, requests) => total + waves(requests),
    0,
  );
  const writeWaves = input.writePhases.reduce(
    (total, requests) => total + waves(requests),
    0,
  );
  if (!Number.isSafeInteger(readWaves) || !Number.isSafeInteger(writeWaves)) {
    throw invalidRequestCounts();
  }
  const estimatedDurationMs =
    readWaves * GITHUB_BRANCH_PUBLICATION_READ_WAVE_MS +
    writeWaves * GITHUB_BRANCH_PUBLICATION_WRITE_WAVE_MS +
    GITHUB_BRANCH_PUBLICATION_SAFETY_MARGIN_MS;
  if (!Number.isSafeInteger(estimatedDurationMs)) {
    throw invalidRequestCounts();
  }
  return estimatedDurationMs;
}

function createTreeReadPhases(
  changes: readonly GitHubBranchPublicationChange[],
): readonly number[] {
  const pathsByDepth: Set<string>[] = [];
  for (const change of changes) {
    const parts = change.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const paths = pathsByDepth[index] ?? new Set<string>();
      paths.add(parts.slice(0, index).join("/"));
      pathsByDepth[index] = paths;
    }
  }
  return pathsByDepth.map((paths) => paths.size);
}

export type GitHubBranchPublicationPlan = {
  readonly path: "create" | "fast_forward" | "replay";
  readonly readRequests: number;
  readonly writeRequests: number;
  readonly readPhases: readonly number[];
  readonly writePhases: readonly number[];
  readonly estimatedDurationMs: number;
};

export function publicationPlan(input: Omit<GitHubBranchPublicationPlan,
  "readRequests" | "writeRequests" | "estimatedDurationMs"
>): GitHubBranchPublicationPlan {
  const readRequests = input.readPhases.reduce((total, value) => total + value, 0);
  const writeRequests = input.writePhases.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(readRequests) || !Number.isSafeInteger(writeRequests)) {
    throw invalidRequestCounts();
  }
  return {
    ...input,
    readRequests,
    writeRequests,
    estimatedDurationMs: estimateGitHubBranchPublicationDeadline(input),
  };
}

export function preflightGitHubBranchPublicationRequest(
  input: GitHubBranchPublicationRequest["input"],
  changes: readonly GitHubBranchPublicationChange[],
): {
  readonly changedPaths: number;
  readonly serializedBytes: number;
  readonly plans: readonly GitHubBranchPublicationPlan[];
  readonly estimatedDurationMs: number;
} {
  const paths = new Set(changes.map(({ path }) => path));
  if (
    paths.size !== changes.length ||
    paths.size < 1 ||
    paths.size > GITHUB_BRANCH_PUBLICATION_CHANGED_PATHS
  ) {
    throw new Error(
      "GitHub branch publication requires 1 to 20 unique changed paths",
    );
  }
  const serializedBytes = input.candidate.sizeBytes;
  if (serializedBytes > 4_194_304) throw new Error(
    "GitHub branch publication candidate exceeds 4194304 bytes",
  );

  const existingFiles = changes.filter(
    ({ oldText }) => oldText.length > 0,
  ).length;
  const fastForward = input.mode === "fast_forward";
  const plans = fastForward
    ? [
      publicationPlan({
        path: "fast_forward",
        // Four identity reads; prior tree; existing blobs; result tree; ref.
        readPhases: [4, 1, existingFiles, 1, 1],
        writePhases: [1],
      }),
      publicationPlan({
        path: "replay",
        // Four identity reads; two commits; prior tree; blobs; result tree.
        readPhases: [4, 2, 1, existingFiles, 1],
        writePhases: [],
      }),
    ]
    : [publicationPlan({
      path: "create",
      // Initial identities; cached directory levels; blobs; final ref.
      readPhases: [3, ...createTreeReadPhases(changes), existingFiles, 1],
      // Parallel blobs, followed by sequential tree, commit, and branch writes.
      writePhases: [changes.length, 1, 1, 1],
    })];
  const rejected = plans.find(({ estimatedDurationMs }) =>
    estimatedDurationMs > GITHUB_BRANCH_PUBLICATION_DEADLINE_MS
  );
  if (rejected !== undefined) {
    throw new Error(
      `GitHub branch publication ${rejected.path} estimate exceeds the 230000 ms request deadline`,
    );
  }
  const estimatedDurationMs = Math.max(...plans.map((plan) => plan.estimatedDurationMs));
  return {
    changedPaths: paths.size,
    serializedBytes,
    plans,
    estimatedDurationMs,
  };
}

type GitReference = {
  readonly ref: string;
  readonly object: { readonly sha: string; readonly type: string };
};

type GitCommit = {
  readonly sha: string;
  readonly tree: { readonly sha: string };
};

type GitTree = {
  readonly sha: string;
  readonly tree: readonly {
    readonly path: string;
    readonly mode: string;
    readonly type: string;
    readonly sha: string;
  }[];
};

type GitBlob = {
  readonly sha: string;
  readonly content: string;
};

export type GitHubBranchPublicationProvider = {
  readonly readBranch: (
    branchName: string,
    allowMissing?: boolean,
  ) => Promise<GitReference | null>;
  readonly readCommit: (sha: string) => Promise<GitCommit>;
  readonly readTree: (sha: string) => Promise<GitTree>;
  readonly readBlob: (sha: string) => Promise<GitBlob>;
  readonly createBlob: (content: string) => Promise<string>;
  readonly createTree: (
    baseTreeSha: string,
    updates: readonly {
      readonly path: string;
      readonly mode: string;
      readonly type: "blob";
      readonly sha: string;
    }[],
  ) => Promise<string>;
  readonly createCommit: (
    message: string,
    treeSha: string,
    parentSha: string,
  ) => Promise<string>;
  readonly createBranch: (branchName: string, sha: string) => Promise<void>;
};

export async function mapGitHubPublicationBounded<T, U>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const outcomes: U[] = [];
  let nextIndex = 0;
  let firstFailure: unknown;
  let failed = false;
  await Promise.all(Array.from(
    { length: Math.min(GITHUB_BRANCH_PUBLICATION_CONCURRENCY, values.length) },
    async () => {
      while (!failed && nextIndex < values.length) {
        const index = nextIndex++;
        try {
          outcomes[index] = await operation(values[index]!, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstFailure = error;
          }
        }
      }
    },
  ));
  if (failed) throw firstFailure;
  return outcomes;
}

async function findTreeEntry(
  rootTreeSha: string,
  repositoryPath: string,
  readTree: (treeSha: string) => Promise<GitTree>,
  optional: boolean,
): Promise<{ readonly mode: string; readonly sha: string } | null> {
  let treeSha = rootTreeSha;
  const parts = repositoryPath.split("/");
  for (const [index, part] of parts.entries()) {
    const tree = await readTree(treeSha);
    const entry = tree.tree.find((candidate) => candidate.path === part);
    if (entry === undefined && optional) return null;
    const final = index === parts.length - 1;
    if (entry === undefined || (final ? entry.type !== "blob" : entry.type !== "tree")) {
      throw new Error(
        optional
          ? `GitHub publication ${final ? "path is not a regular file" : "parent path is not a directory"}`
          : `GitHub base tree does not contain the required ${final ? "file" : "directory"}`,
      );
    }
    if (final) return { mode: entry.mode, sha: entry.sha };
    treeSha = entry.sha;
  }
  throw new Error("GitHub repository path is empty");
}

export async function publishGitHubBranch(input: {
  readonly request: GitHubBranchPublicationRequest;
  readonly provider: GitHubBranchPublicationProvider;
  readonly preflight: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly effectText: (operationId: string) => string;
  readonly changes: readonly GitHubBranchPublicationChange[];
}): Promise<string> {
  const { provider, request } = input;
  const baseCommit = await input.preflight(async () => {
    const reads: readonly (() => Promise<unknown>)[] = [
      () => provider.readBranch(request.input.baseBranch),
      async () => {
        if (await provider.readBranch(request.input.branchName, true) !== null) {
          throw new Error("GitHub publication branch already exists");
        }
      },
      () => provider.readCommit(request.input.expectedHeadSha),
    ];
    const [rawCurrent, , rawCommit] = await mapGitHubPublicationBounded(
      reads,
      (read) => read(),
    );
    const current = rawCurrent as GitReference;
    const commit = rawCommit as GitCommit;
    if (
      current.ref !== `refs/heads/${request.input.baseBranch}` ||
      current.object.type !== "commit" ||
      current.object.sha !== request.input.expectedHeadSha
    ) {
      throw new Error("GitHub base branch changed before publication");
    }
    if (commit.sha !== request.input.expectedHeadSha) {
      throw new Error("GitHub base commit identity changed before publication");
    }
    return commit;
  });

  const treeReads = new Map<string, Promise<GitTree>>();
  const readTree = (treeSha: string): Promise<GitTree> => {
    let read = treeReads.get(treeSha);
    if (read === undefined) {
      read = (async () => {
        const tree = await provider.readTree(treeSha);
        if (tree.sha !== treeSha) {
          throw new Error("GitHub base tree identity changed before publication");
        }
        return tree;
      })();
      treeReads.set(treeSha, read);
    }
    return read;
  };

  const prepared = await input.preflight(() => mapGitHubPublicationBounded(
    input.changes,
    async (change): Promise<{
      readonly path: string;
      readonly mode: string;
      readonly content: string;
    }> => {
      if (change.oldText.length === 0) {
        const entry = await findTreeEntry(
          baseCommit.tree.sha,
          change.path,
          readTree,
          true,
        );
        if (entry !== null) {
          throw new Error("GitHub new-file publication path already exists");
        }
        return { path: change.path, mode: "100644", content: change.newText };
      }
      const entry = await findTreeEntry(
        baseCommit.tree.sha,
        change.path,
        readTree,
        false,
      );
      if (entry === null || !new Set(["100644", "100755"]).has(entry.mode)) {
        throw new Error("GitHub publication supports regular files only");
      }
      const blob = await provider.readBlob(entry.sha);
      if (blob.sha !== entry.sha) {
        throw new Error("GitHub base blob identity changed before publication");
      }
      const encoded = blob.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error("GitHub base blob content is not canonical base64");
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(encoded, "base64"),
      );
      const first = source.indexOf(change.oldText);
      if (first < 0 || first !== source.lastIndexOf(change.oldText)) {
        throw new Error("GitHub publication old text must match exactly once");
      }
      const content = `${source.slice(0, first)}${change.newText}${source.slice(first + change.oldText.length)}`;
      if (content === source) {
        throw new Error("GitHub publication change must modify the file");
      }
      return { path: change.path, mode: entry.mode, content };
    },
  ));

  const treeUpdates = await mapGitHubPublicationBounded(
    prepared,
    async (change) => ({
      path: change.path,
      mode: change.mode,
      type: "blob" as const,
      sha: await provider.createBlob(change.content),
    }),
  );
  const treeSha = await provider.createTree(baseCommit.tree.sha, treeUpdates);
  const commitSha = await provider.createCommit(
    `${request.input.commitMessage}\n\n${input.effectText(request.operationId)}`,
    treeSha,
    request.input.expectedHeadSha,
  );
  await provider.createBranch(request.input.branchName, commitSha);
  const after = await provider.readBranch(request.input.branchName);
  if (
    after === null ||
    after.ref !== `refs/heads/${request.input.branchName}` ||
    after.object.type !== "commit" ||
    after.object.sha !== commitSha ||
    after.object.sha === request.input.expectedHeadSha
  ) {
    throw new Error("GitHub publication branch identity changed during creation");
  }
  return after.object.sha;
}
