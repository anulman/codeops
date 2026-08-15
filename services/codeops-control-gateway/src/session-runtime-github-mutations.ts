import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubMutationProviderRequestSchema,
  githubMutationResultSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionPermissionOperationSchema,
  sessionRuntimeGitHubMutationRequestSchema,
  sessionRuntimePermissionSubmissionSchema,
  type GitHubMutationProviderRequest,
  type GitHubMutationResult,
  type SessionRuntimeGitHubMutationRequest,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";
import {
  ClaimedDispatchAuthorityConflictError,
  ClaimedDispatchAuthorityNotFoundError,
  loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource,
  type ClaimedDispatchAuthority,
} from "./claimed-dispatch-authority.js";

export class SessionRuntimeGitHubMutationNotFoundError extends Error {}
export class SessionRuntimeGitHubMutationConflictError extends Error {}

interface MutationAuthorizationRow extends Record<string, unknown> {
  readonly request_json: unknown;
  readonly command_json: unknown;
  readonly result_json: unknown;
}

interface StoredMutationRow extends Record<string, unknown> {
  readonly dispatch_id: unknown;
  readonly payload_digest: unknown;
  readonly permission_digest: unknown;
  readonly status: unknown;
  readonly result_json: unknown;
}

export type SessionRuntimeGitHubMutationAuthorization =
  | {
      readonly disposition: "authorized";
      readonly request: GitHubMutationProviderRequest;
    }
  | {
      readonly disposition: "replayed";
      readonly result: GitHubMutationResult;
    };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadMutationAuthority(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly repository: string;
    readonly now: Date;
  },
): Promise<ClaimedDispatchAuthority> {
  try {
    const authority = await loadClaimedDispatchAuthority(client, {
      dispatchId: input.dispatchId,
      workerId: input.workerId,
      claimToken: input.claimToken,
      now: () => input.now,
    });
    selectClaimedWorkspaceSource(authority, { repository: input.repository });
    return authority;
  } catch (error) {
    if (error instanceof ClaimedDispatchAuthorityNotFoundError) {
      throw new SessionRuntimeGitHubMutationNotFoundError(
        "runtime dispatch was not found",
      );
    }
    if (error instanceof ClaimedDispatchAuthorityConflictError) {
      throw new SessionRuntimeGitHubMutationConflictError(error.message);
    }
    throw error;
  }
}

function permissionTarget(request: SessionRuntimeGitHubMutationRequest): {
  readonly pullRequestNumber: number | null;
  readonly targetId: string | null;
} {
  switch (request.operation) {
    case "pull_request_update_branch":
    case "pull_request_update":
      return { pullRequestNumber: request.input.pullRequestNumber, targetId: null };
    case "review_thread_reply":
      return {
        pullRequestNumber: request.input.pullRequestNumber,
        targetId: request.input.threadId,
      };
    case "check_rerun":
      return { pullRequestNumber: null, targetId: String(request.input.checkRunId) };
  }
}

function expectedPermissionOperation(request: SessionRuntimeGitHubMutationRequest) {
  return sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository: request.input.repository,
    operation: request.operation,
    ...permissionTarget(request),
    expectedHeadSha: request.input.expectedHeadSha,
    payloadJson: canonicalJsonText(request.input),
  });
}

export async function authorizeSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<SessionRuntimeGitHubMutationAuthorization> {
  const request = sessionRuntimeGitHubMutationRequestSchema.parse(input.request);
  const dispatch = (await loadMutationAuthority(client, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: request.claimToken,
    repository: request.input.repository,
    now: (input.now ?? (() => new Date()))(),
  })).dispatch;
  const expectedOperationId = `githubmutation-${createHash("sha256")
    .update(canonicalJsonText({
      dispatchId: dispatch.dispatchId,
      operation: request.operation,
      input: request.input,
    }))
    .digest("hex")}`;
  if (request.operationId !== expectedOperationId) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation operation identity is invalid",
    );
  }
  const operation = expectedPermissionOperation(request);
  const operationDigest = digest(canonicalJsonText(operation));
  const expectedRequestId = `permission-${createHash("sha256")
    .update(canonicalJsonText(operation))
    .update("\0")
    .update(dispatch.dispatchId)
    .update("\0")
    .update(request.operationId)
    .digest("hex")}`;
  const result = await client.query<MutationAuthorizationRow>(
    `SELECT permission.request_json, decision.command_json,
            decision.result_json
       FROM codeops.session_runtime_outbox AS outbox
       LEFT JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = outbox.dispatch_id
        AND permission.request_id = $2
       LEFT JOIN LATERAL (
         SELECT command_json, result_json
           FROM codeops.session_commands
          WHERE session_id = permission.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = permission.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId, expectedRequestId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SessionRuntimeGitHubMutationNotFoundError(
      "runtime dispatch was not found",
    );
  }

  if (row.request_json === null || row.command_json === null || row.result_json === null) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation requires one durable permission decision",
    );
  }
  const permission = sessionRuntimePermissionSubmissionSchema.parse(row.request_json);
  const command = sessionCommandSchema.parse(row.command_json);
  const commandResult = sessionCommandResultSchema.parse(row.result_json);
  if (
    permission.claimToken !== request.claimToken ||
    permission.acpSessionId !== "codeops-github" ||
    permission.toolCallId !== request.operationId ||
    permission.request.requestId !== expectedRequestId ||
    permission.request.operationDigest !== operationDigest ||
    canonicalJsonText(permission.request.operation) !== canonicalJsonText(operation) ||
    canonicalJsonText(permission.options) !== canonicalJsonText([
      { optionId: "allow-once", acpOptionId: "allow-once" },
      { optionId: "deny", acpOptionId: "deny" },
    ]) ||
    command.type !== "respond_permission" ||
    command.sessionId !== dispatch.command.sessionId ||
    command.permissionRequestId !== expectedRequestId ||
    command.decision.outcome !== "selected" ||
    command.decision.optionId !== "allow-once" ||
    commandResult.sessionId !== command.sessionId ||
    commandResult.generation !== command.generation ||
    commandResult.leaseId !== command.leaseId ||
    commandResult.idempotencyKey !== command.idempotencyKey ||
    commandResult.type !== command.type ||
    commandResult.disposition !== "committed"
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "durable permission does not authorize this exact GitHub mutation",
    );
  }

  const payloadDigest = digest(canonicalJsonText(request.input));
  const providerRequest = githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operation: request.operation,
    operationId: request.operationId,
    input: request.input,
    payloadDigest,
    permissionDigest: operationDigest,
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      principalDigest: digest(dispatch.principalId),
    },
  });
  const inserted = await client.query(
    `INSERT INTO codeops.session_runtime_github_mutations
       (operation_id, dispatch_id, payload_digest, permission_digest, status)
     VALUES ($1, $2, $3, $4, 'started')
     ON CONFLICT DO NOTHING`,
    [request.operationId, dispatch.dispatchId, payloadDigest, operationDigest],
  );
  if (inserted.rowCount !== 1) {
    const stored = await client.query<StoredMutationRow>(
      `SELECT dispatch_id, payload_digest, permission_digest, status, result_json
         FROM codeops.session_runtime_github_mutations
        WHERE operation_id = $1`,
      [request.operationId],
    );
    const replay = stored.rows[0];
    if (
      replay === undefined ||
      replay.dispatch_id !== dispatch.dispatchId ||
      replay.payload_digest !== payloadDigest ||
      replay.permission_digest !== operationDigest
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation operation conflicts with its immutable stored identity",
      );
    }
    if (replay.status !== "completed" || replay.result_json === null) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "GitHub mutation outcome is not known and cannot be retried",
      );
    }
    const parsedReplay = githubMutationResultSchema.safeParse(replay.result_json);
    if (!parsedReplay.success) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "stored GitHub mutation result is invalid",
      );
    }
    const replayed = parsedReplay.data;
    if (
      replayed.operationId !== request.operationId ||
      replayed.repository !== request.input.repository
    ) {
      throw new SessionRuntimeGitHubMutationConflictError(
        "stored GitHub mutation result conflicts with its operation identity",
      );
    }
    return { disposition: "replayed", result: replayed };
  }
  return { disposition: "authorized", request: providerRequest };
}

export async function completeSessionRuntimeGitHubMutation(
  client: TransactionClient,
  input: {
    readonly request: GitHubMutationProviderRequest;
    readonly result: unknown;
    readonly now?: () => Date;
  },
): Promise<GitHubMutationResult> {
  const request = githubMutationProviderRequestSchema.parse(input.request);
  const result = githubMutationResultSchema.parse(input.result);
  if (
    result.operationId !== request.operationId ||
    result.repository !== request.input.repository
  ) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation result identity does not match its consumed permission",
    );
  }
  const updated = await client.query(
    `UPDATE codeops.session_runtime_github_mutations
        SET status = 'completed', result_json = $1::jsonb,
            completed_at = $2::timestamptz
      WHERE operation_id = $3 AND dispatch_id = $4
        AND payload_digest = $5 AND permission_digest = $6
        AND status = 'started' AND result_json IS NULL`,
    [
      canonicalJsonText(result),
      (input.now ?? (() => new Date()))().toISOString(),
      request.operationId,
      request.provenance.dispatchId,
      request.payloadDigest,
      request.permissionDigest,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new SessionRuntimeGitHubMutationConflictError(
      "GitHub mutation completion does not match one started operation",
    );
  }
  return result;
}

export function createGitHubMutationProviderClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): (request: GitHubMutationProviderRequest) => Promise<GitHubMutationResult> {
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
    throw new Error(
      "GitHub mutation provider origin must be the internal control gateway",
    );
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("GitHub mutation provider token is invalid");
  }
  return async (rawRequest) => {
    const request = githubMutationProviderRequestSchema.parse(rawRequest);
    const [owner, name] = request.input.repository.split("/");
    const response = await (input.fetch ?? fetch)(
      new URL(
        `/v1/repositories/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/github-mutations`,
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
      throw new Error(`GitHub mutation provider returned HTTP ${response.status}`);
    }
    return githubMutationResultSchema.parse(await response.json());
  };
}
