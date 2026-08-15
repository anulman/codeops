import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubReadProviderRequestSchema,
  githubReadResultSchema,
  sessionRuntimeGitHubReadRequestSchema,
  type GitHubReadProviderRequest,
  type GitHubReadResult,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import {
  ClaimedDispatchAuthorityConflictError,
  ClaimedDispatchAuthorityNotFoundError,
  loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource,
} from "./claimed-dispatch-authority.js";

export class SessionRuntimeGitHubReadNotFoundError extends Error {}
export class SessionRuntimeGitHubReadConflictError extends Error {}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function authorizeSessionRuntimeGitHubRead(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<GitHubReadProviderRequest> {
  const request = sessionRuntimeGitHubReadRequestSchema.parse(input.request);
  let authority;
  try {
    authority = await loadClaimedDispatchAuthority(client, {
      dispatchId: input.dispatchId,
      workerId: input.workerId,
      claimToken: request.claimToken,
      now: input.now,
    });
    selectClaimedWorkspaceSource(authority, {
      repository: request.input.repository,
    });
  } catch (error) {
    if (error instanceof ClaimedDispatchAuthorityNotFoundError) {
      throw new SessionRuntimeGitHubReadNotFoundError(
        "runtime dispatch was not found",
      );
    }
    if (error instanceof ClaimedDispatchAuthorityConflictError) {
      throw new SessionRuntimeGitHubReadConflictError(error.message);
    }
    throw error;
  }
  const dispatch = authority.dispatch;
  const expectedOperationId = `githubread-${createHash("sha256")
    .update(canonicalJsonText({
      dispatchId: dispatch.dispatchId,
      operation: request.operation,
      input: request.input,
    }))
    .digest("hex")}`;
  if (request.operationId !== expectedOperationId) {
    throw new SessionRuntimeGitHubReadConflictError(
      "GitHub read operation identity is invalid",
    );
  }
  return githubReadProviderRequestSchema.parse({
    version: "codeops.github-read-provider-request/v1",
    operation: request.operation,
    operationId: request.operationId,
    input: request.input,
    payloadDigest: digest(canonicalJsonText(request.input)),
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      principalDigest: digest(dispatch.principalId),
    },
  });
}

export function createGitHubReadProviderClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): (request: GitHubReadProviderRequest) => Promise<GitHubReadResult> {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    !origin.hostname.endsWith("-control-gateway") ||
    origin.port !== "8080" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("GitHub read provider origin must be the internal control gateway");
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub read provider token is invalid");
  }
  return async (rawRequest) => {
    const request = githubReadProviderRequestSchema.parse(rawRequest);
    const [owner, name] = request.input.repository.split("/");
    const response = await (input.fetch ?? fetch)(
      new URL(
        `/v1/repositories/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/github-reads`,
        origin,
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub read provider returned HTTP ${response.status}`);
    }
    return githubReadResultSchema.parse(await response.json());
  };
}
