import type { AgentJobDispatchRequest } from "@renoconcierge/codeops-contracts";

const REPOSITORY_IDENTITY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface RepositoryAuthority {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly readToken: string;
  readonly writeToken: string;
}

export interface RepositoryRegistry {
  readonly repositories: readonly string[];
  resolve(repository: string): RepositoryAuthority;
}

function parseRepositoryUrl(value: string): string {
  const repositoryUrl = new URL(value);
  const match = repositoryUrl.pathname.match(
    /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/,
  );
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.hostname !== "github.com" ||
    repositoryUrl.username !== "" ||
    repositoryUrl.password !== "" ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== "" ||
    match === null
  ) {
    throw new Error("repository registry requires an exact GitHub HTTPS URL");
  }
  return `${match[1]}/${match[2]}`;
}

function validateCredential(value: string, label: string): string {
  if (value.length < 16 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error(`repository registry ${label} is invalid`);
  }
  return value;
}

export function createRepositoryRegistry(
  entries: readonly RepositoryAuthority[],
): RepositoryRegistry {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error("repository registry must contain between 1 and 100 repositories");
  }
  const byRepository = new Map<string, RepositoryAuthority>();
  const credentials = new Set<string>();
  for (const entry of entries) {
    if (!REPOSITORY_IDENTITY.test(entry.repository)) {
      throw new Error("repository registry identity is invalid");
    }
    if (parseRepositoryUrl(entry.repositoryUrl) !== entry.repository) {
      throw new Error("repository registry URL does not match its identity");
    }
    if (byRepository.has(entry.repository)) {
      throw new Error("repository registry identities must be unique");
    }
    const readToken = validateCredential(entry.readToken, "read token");
    const writeToken = validateCredential(entry.writeToken, "write token");
    if (
      readToken === writeToken ||
      credentials.has(readToken) ||
      credentials.has(writeToken)
    ) {
      throw new Error("repository registry credentials must be repository-scoped");
    }
    credentials.add(readToken);
    credentials.add(writeToken);
    byRepository.set(entry.repository, {
      repository: entry.repository,
      repositoryUrl: entry.repositoryUrl,
      readToken,
      writeToken,
    });
  }
  return {
    repositories: [...byRepository.keys()],
    resolve(repository) {
      const authority = byRepository.get(repository);
      if (authority === undefined) {
        throw new Error("repository is not admitted by the repository registry");
      }
      return authority;
    },
  };
}

export function dispatchRepositoryIdentity(
  request: AgentJobDispatchRequest,
): string {
  const repository =
    request.role === "qa-contract-researcher"
      ? request.researchRequest.repository
      : request.codingRequest.workItem.repository;
  return `${repository.owner}/${repository.name}`;
}
