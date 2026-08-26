export const GITHUB_BRANCH_PUBLICATION_CONCURRENCY = 4;

export type GitHubBranchPublicationRequest = {
  readonly operationId: string;
  readonly input: {
    readonly expectedHeadSha: string;
    readonly baseBranch: string;
    readonly branchName: string;
    readonly commitMessage: string;
    readonly changes: readonly {
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
    }[];
  };
};

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
    request.input.changes,
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
