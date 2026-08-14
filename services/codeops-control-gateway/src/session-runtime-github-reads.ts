import { createHash } from "node:crypto";
import {
  githubReadProviderRequestSchema,
  githubReadResultSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimeGitHubReadRequestSchema,
  type GitHubReadProviderRequest,
  type GitHubReadResult,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class SessionRuntimeGitHubReadNotFoundError extends Error {}
export class SessionRuntimeGitHubReadConflictError extends Error {}

interface ClaimRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertRepositoryScope(
  dispatch: SessionRuntimeDispatch,
  repository: string,
): void {
  if (
    !("version" in dispatch.snapshot.identity) ||
    !dispatch.snapshot.identity.workspace.sources.some(
      (source) => source.repository === repository,
    )
  ) {
    throw new SessionRuntimeGitHubReadConflictError(
      "GitHub repository is outside the exact workspace source scope",
    );
  }
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
  if (!workerPattern.test(input.workerId)) {
    throw new SessionRuntimeGitHubReadConflictError(
      "runtime worker identity is invalid",
    );
  }
  const request = sessionRuntimeGitHubReadRequestSchema.parse(input.request);
  const result = await client.query<ClaimRow>(
    `SELECT dispatch_json, status, claim_token, claimed_by, claim_expires_at
       FROM codeops.session_runtime_outbox
      WHERE dispatch_id = $1`,
    [input.dispatchId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SessionRuntimeGitHubReadNotFoundError(
      "runtime dispatch was not found",
    );
  }
  const now = (input.now ?? (() => new Date()))().getTime();
  if (
    row.status !== "claimed" ||
    row.claim_token !== request.claimToken ||
    row.claimed_by !== input.workerId ||
    Date.parse(String(row.claim_expires_at)) <= now
  ) {
    throw new SessionRuntimeGitHubReadConflictError(
      "GitHub read does not hold the exact live dispatch claim",
    );
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (dispatch.dispatchId !== input.dispatchId || dispatch.command.type !== "prompt") {
    throw new SessionRuntimeGitHubReadConflictError(
      "only the exact claimed prompt may read GitHub",
    );
  }
  assertRepositoryScope(dispatch, request.input.repository);
  const expectedOperationId = `githubread-${createHash("sha256")
    .update(canonical({
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
    payloadDigest: digest(canonical(request.input)),
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
