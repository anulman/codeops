import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  sessionCommandSchema,
  sessionRuntimeDispatchSchema,
  sessionRuntimePermissionSubmissionSchema,
  sessionRuntimeWorkItemCommentRequestSchema,
  sessionRuntimeWorkItemCreateRequestSchema,
  sessionRuntimeWorkItemGetRequestSchema,
  sessionRuntimeWorkItemRelateRequestSchema,
  sessionRuntimeWorkItemSearchRequestSchema,
  sessionRuntimeWorkItemUpdateRequestSchema,
  workItemCommentResultSchema,
  workItemCreateResultSchema,
  workItemProjectionSchema,
  workItemProviderCommentRequestSchema,
  workItemProviderCreateRequestSchema,
  workItemProviderGetRequestSchema,
  workItemProviderRelateRequestSchema,
  workItemProviderSearchRequestSchema,
  workItemProviderUpdateRequestSchema,
  workItemRelateResultSchema,
  workItemSearchResultSchema,
  workItemUpdateResultSchema,
  type SessionRuntimeDispatch,
  type WorkItemCommentResult,
  type WorkItemCreateResult,
  type WorkItemProjection,
  type WorkItemProviderCommentRequest,
  type WorkItemProviderCreateRequest,
  type WorkItemProviderGetRequest,
  type WorkItemProviderRelateRequest,
  type WorkItemProviderSearchRequest,
  type WorkItemProviderUpdateRequest,
  type WorkItemRelateResult,
  type WorkItemSearchResult,
  type WorkItemUpdateResult,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class SessionRuntimeWorkItemNotFoundError extends Error {}
export class SessionRuntimeWorkItemConflictError extends Error {}

interface ClaimRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly request_json: unknown;
  readonly command_json: unknown;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function assertWorkItemPermissionIdentity(
  permission: ReturnType<typeof sessionRuntimePermissionSubmissionSchema.parse>,
  dispatch: SessionRuntimeDispatch,
  operation: "create" | "comment" | "update" | "relate",
  input: Record<string, unknown>,
): void {
  const rendered = permission.request.operation;
  const expectedOperationId = `workitem-${createHash("sha256")
    .update(canonicalJsonText({ dispatchId: dispatch.dispatchId, operation, workItem: input }))
    .digest("hex")}`;
  const expectedDigest = digest(canonicalJsonText(rendered));
  if (
    permission.acpSessionId !== "codeops-work-items" ||
    permission.request.requestId !== expectedOperationId ||
    permission.request.operationDigest !== expectedDigest ||
    rendered.kind !== "work_item" ||
    rendered.operation !== operation ||
    rendered.repository !== input.repository ||
    rendered.targetWorkItemId !== ("workItemId" in input ? input.workItemId : null) ||
    rendered.payloadJson !== canonicalJsonText(input)
  ) {
    throw new SessionRuntimeWorkItemConflictError(
      `work-item ${operation} permission does not bind the exact operation`,
    );
  }
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
    throw new SessionRuntimeWorkItemConflictError(
      "work-item repository is outside the exact workspace source scope",
    );
  }
}

export async function authorizeSessionRuntimeWorkItemCreate(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<WorkItemProviderCreateRequest> {
  if (!workerPattern.test(input.workerId)) {
    throw new SessionRuntimeWorkItemConflictError("runtime worker identity is invalid");
  }
  const request = sessionRuntimeWorkItemCreateRequestSchema.parse(input.request);
  const result = await client.query<ClaimRow>(
    `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            permission.request_json, decision.command_json
       FROM codeops.session_runtime_outbox AS outbox
       LEFT JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = outbox.dispatch_id
        AND permission.request_id = $2
       LEFT JOIN LATERAL (
         SELECT command_json
           FROM codeops.session_commands
          WHERE session_id = permission.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = permission.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId, request.operationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SessionRuntimeWorkItemNotFoundError("runtime dispatch was not found");
  }
  const now = (input.now ?? (() => new Date()))().getTime();
  if (
    row.status !== "claimed" ||
    row.claim_token !== request.claimToken ||
    row.claimed_by !== input.workerId ||
    Date.parse(String(row.claim_expires_at)) <= now
  ) {
    throw new SessionRuntimeWorkItemConflictError(
      "work-item create does not hold the exact live dispatch claim",
    );
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (
    dispatch.dispatchId !== input.dispatchId ||
    dispatch.command.type !== "prompt"
  ) {
    throw new SessionRuntimeWorkItemConflictError(
      "only the exact claimed prompt may create a work item",
    );
  }
  assertRepositoryScope(dispatch, request.input.repository);
  if (request.input.mode === "direct") {
    if (row.request_json === null || row.command_json === null) {
      throw new SessionRuntimeWorkItemConflictError(
        "direct work-item creation requires one decided permission",
      );
    }
    const permission = sessionRuntimePermissionSubmissionSchema.parse(
      row.request_json,
    );
    const decision = sessionCommandSchema.parse(row.command_json);
    assertWorkItemPermissionIdentity(permission, dispatch, "create", request.input);
    if (
      permission.request.requestId !== request.operationId ||
      permission.claimToken !== request.claimToken ||
      decision.type !== "respond_permission" ||
      decision.permissionRequestId !== request.operationId ||
      decision.decision.outcome !== "selected" ||
      decision.decision.optionId !== "allow-once"
    ) {
      throw new SessionRuntimeWorkItemConflictError(
        "direct work-item permission does not authorize this operation",
      );
    }
  }
  const payload = canonicalJsonText(request.input);
  return workItemProviderCreateRequestSchema.parse({
    version: "codeops.work-item-provider-create-request/v1",
    provider: "plane",
    operationId: request.operationId,
    payloadDigest: digest(payload),
    repository: request.input.repository,
    mode: request.input.mode,
    title: request.input.title,
    description: request.input.description,
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      principalDigest: digest(dispatch.principalId),
    },
  });
}

type WorkItemOperation = "get" | "search" | "comment" | "update" | "relate";

async function authorizeSessionRuntimeWorkItemOperation(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
  operation: WorkItemOperation,
): Promise<{
  readonly dispatch: SessionRuntimeDispatch;
  readonly request: {
    readonly claimToken: string;
    readonly operationId: string;
    readonly input: Readonly<Record<string, unknown>> & { readonly repository: string };
  };
}> {
  if (!workerPattern.test(input.workerId)) {
    throw new SessionRuntimeWorkItemConflictError("runtime worker identity is invalid");
  }
  const schemas = {
    get: sessionRuntimeWorkItemGetRequestSchema,
    search: sessionRuntimeWorkItemSearchRequestSchema,
    comment: sessionRuntimeWorkItemCommentRequestSchema,
    update: sessionRuntimeWorkItemUpdateRequestSchema,
    relate: sessionRuntimeWorkItemRelateRequestSchema,
  } as const;
  const request = schemas[operation].parse(input.request);
  const result = await client.query<ClaimRow>(
    `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            permission.request_json, decision.command_json
       FROM codeops.session_runtime_outbox AS outbox
       LEFT JOIN codeops.session_runtime_permission_requests AS permission
         ON permission.dispatch_id = outbox.dispatch_id
        AND permission.request_id = $2
       LEFT JOIN LATERAL (
         SELECT command_json
           FROM codeops.session_commands
          WHERE session_id = permission.session_id
            AND command_json->>'type' = 'respond_permission'
            AND command_json->>'permissionRequestId' = permission.request_id
          ORDER BY committed_at ASC, command_id ASC
          LIMIT 1
       ) AS decision ON TRUE
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId, request.operationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SessionRuntimeWorkItemNotFoundError("runtime dispatch was not found");
  }
  const now = (input.now ?? (() => new Date()))().getTime();
  if (
    row.status !== "claimed" ||
    row.claim_token !== request.claimToken ||
    row.claimed_by !== input.workerId ||
    Date.parse(String(row.claim_expires_at)) <= now
  ) {
    throw new SessionRuntimeWorkItemConflictError(
      `work-item ${operation} does not hold the exact live dispatch claim`,
    );
  }
  const dispatch = sessionRuntimeDispatchSchema.parse(row.dispatch_json);
  if (dispatch.dispatchId !== input.dispatchId || dispatch.command.type !== "prompt") {
    throw new SessionRuntimeWorkItemConflictError(
      `only the exact claimed prompt may ${operation} a work item`,
    );
  }
  assertRepositoryScope(dispatch, request.input.repository);
  if (["comment", "update", "relate"].includes(operation)) {
    if (row.request_json === null || row.command_json === null) {
      throw new SessionRuntimeWorkItemConflictError(
        `work-item ${operation} requires one decided permission`,
      );
    }
    const permission = sessionRuntimePermissionSubmissionSchema.parse(row.request_json);
    const decision = sessionCommandSchema.parse(row.command_json);
    assertWorkItemPermissionIdentity(
      permission,
      dispatch,
      operation as "comment" | "update" | "relate",
      request.input,
    );
    if (
      permission.request.requestId !== request.operationId ||
      permission.claimToken !== request.claimToken ||
      decision.type !== "respond_permission" ||
      decision.permissionRequestId !== request.operationId ||
      decision.decision.outcome !== "selected" ||
      decision.decision.optionId !== "allow-once"
    ) {
      throw new SessionRuntimeWorkItemConflictError(
        `work-item ${operation} permission does not authorize this operation`,
      );
    }
  }
  return { dispatch, request };
}

function providerEnvelope(
  dispatch: SessionRuntimeDispatch,
  request: { readonly operationId: string; readonly input: unknown },
) {
  return {
    provider: "plane",
    operationId: request.operationId,
    payloadDigest: digest(canonicalJsonText(request.input)),
    provenance: {
      sessionId: dispatch.command.sessionId,
      dispatchId: dispatch.dispatchId,
      principalDigest: digest(dispatch.principalId),
    },
  };
}

export async function authorizeSessionRuntimeWorkItemGet(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeWorkItemCreate>[1],
): Promise<WorkItemProviderGetRequest> {
  const { dispatch, request } = await authorizeSessionRuntimeWorkItemOperation(
    client, input, "get",
  );
  return workItemProviderGetRequestSchema.parse({
    version: "codeops.work-item-provider-get-request/v1",
    ...providerEnvelope(dispatch, request),
    ...request.input,
  });
}

export async function authorizeSessionRuntimeWorkItemSearch(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeWorkItemCreate>[1],
): Promise<WorkItemProviderSearchRequest> {
  const { dispatch, request } = await authorizeSessionRuntimeWorkItemOperation(
    client, input, "search",
  );
  return workItemProviderSearchRequestSchema.parse({
    version: "codeops.work-item-provider-search-request/v1",
    ...providerEnvelope(dispatch, request),
    ...request.input,
  });
}

export async function authorizeSessionRuntimeWorkItemComment(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeWorkItemCreate>[1],
): Promise<WorkItemProviderCommentRequest> {
  const { dispatch, request } = await authorizeSessionRuntimeWorkItemOperation(
    client, input, "comment",
  );
  return workItemProviderCommentRequestSchema.parse({
    version: "codeops.work-item-provider-comment-request/v1",
    ...providerEnvelope(dispatch, request),
    ...request.input,
  });
}

export async function authorizeSessionRuntimeWorkItemUpdate(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeWorkItemCreate>[1],
): Promise<WorkItemProviderUpdateRequest> {
  const { dispatch, request } = await authorizeSessionRuntimeWorkItemOperation(
    client, input, "update",
  );
  return workItemProviderUpdateRequestSchema.parse({
    version: "codeops.work-item-provider-update-request/v1",
    ...providerEnvelope(dispatch, request),
    ...request.input,
  });
}

export async function authorizeSessionRuntimeWorkItemRelate(
  client: TransactionClient,
  input: Parameters<typeof authorizeSessionRuntimeWorkItemCreate>[1],
): Promise<WorkItemProviderRelateRequest> {
  const { dispatch, request } = await authorizeSessionRuntimeWorkItemOperation(
    client, input, "relate",
  );
  return workItemProviderRelateRequestSchema.parse({
    version: "codeops.work-item-provider-relate-request/v1",
    ...providerEnvelope(dispatch, request),
    ...request.input,
  });
}

export function createWorkItemProviderClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): (request: WorkItemProviderCreateRequest) => Promise<WorkItemCreateResult> {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    !origin.hostname.endsWith("-github-controller") ||
    origin.port !== "8080" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("work-item provider origin must be the internal controller");
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("work-item provider token is invalid");
  }
  return async (request) => {
    const response = await (input.fetch ?? fetch)(new URL("/v1/work-items", origin), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(workItemProviderCreateRequestSchema.parse(request)),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`work-item provider returned HTTP ${response.status}`);
    }
    return workItemCreateResultSchema.parse(await response.json());
  };
}

export function createWorkItemProviderClients(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): {
  readonly create: (request: WorkItemProviderCreateRequest) => Promise<WorkItemCreateResult>;
  readonly get: (request: WorkItemProviderGetRequest) => Promise<WorkItemProjection>;
  readonly search: (request: WorkItemProviderSearchRequest) => Promise<WorkItemSearchResult>;
  readonly comment: (request: WorkItemProviderCommentRequest) => Promise<WorkItemCommentResult>;
  readonly update: (request: WorkItemProviderUpdateRequest) => Promise<WorkItemUpdateResult>;
  readonly relate: (request: WorkItemProviderRelateRequest) => Promise<WorkItemRelateResult>;
} {
  const create = createWorkItemProviderClient(input);
  const origin = new URL(input.origin);
  async function post(path: string, request: unknown): Promise<unknown> {
    const response = await (input.fetch ?? fetch)(new URL(path, origin), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`work-item provider returned HTTP ${response.status}`);
    }
    return response.json();
  }
  return {
    create,
    get: async (request) => workItemProjectionSchema.parse(
      await post("/v1/work-items/get", workItemProviderGetRequestSchema.parse(request)),
    ),
    search: async (request) => workItemSearchResultSchema.parse(
      await post("/v1/work-items/search", workItemProviderSearchRequestSchema.parse(request)),
    ),
    comment: async (request) => workItemCommentResultSchema.parse(
      await post("/v1/work-items/comment", workItemProviderCommentRequestSchema.parse(request)),
    ),
    update: async (request) => workItemUpdateResultSchema.parse(
      await post("/v1/work-items/update", workItemProviderUpdateRequestSchema.parse(request)),
    ),
    relate: async (request) => workItemRelateResultSchema.parse(
      await post("/v1/work-items/relate", workItemProviderRelateRequestSchema.parse(request)),
    ),
  };
}
