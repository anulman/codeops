import {
  canonicalJsonText,
  isWorkspaceSessionIdentity,
  sessionRuntimeDispatchSchema,
  sessionSnapshotSchema,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import type { TransactionClient } from "./session-broker-repository.js";

const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class ClaimedDispatchAuthorityNotFoundError extends Error {}
export class ClaimedDispatchAuthorityConflictError extends Error {}

export interface ClaimedDispatchRow extends Record<string, unknown> {
  readonly dispatch_json: unknown;
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly owner_principal_id: unknown;
}

export interface ClaimedDispatchAuthority {
  readonly dispatch: SessionRuntimeDispatch;
  readonly snapshot: SessionSnapshot;
  readonly workerId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

export interface ClaimedWorkspaceSourceAuthority {
  readonly catalogKey: string;
  readonly repository: string;
  readonly checkoutPath: string;
  readonly requestedRef: string;
  readonly resolvedSha: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function validateClaimedDispatchAuthority(
  row: ClaimedDispatchRow,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly now: Date;
    readonly sessionSnapshot?: unknown;
  },
): ClaimedDispatchAuthority {
  if (!workerPattern.test(input.workerId)) {
    throw new ClaimedDispatchAuthorityConflictError(
      "runtime worker must be a bounded audit identity",
    );
  }
  const now = input.now.getTime();
  const claimExpiresAt = String(row.claim_expires_at);
  const claimExpiry = Date.parse(claimExpiresAt);
  if (
    row.status !== "claimed" ||
    row.claim_token !== input.claimToken ||
    row.claimed_by !== input.workerId ||
    !Number.isFinite(claimExpiry) ||
    claimExpiry <= now
  ) {
    throw new ClaimedDispatchAuthorityConflictError(
      "request does not hold the exact live dispatch claim",
    );
  }
  const parsedDispatch = sessionRuntimeDispatchSchema.safeParse(row.dispatch_json);
  if (!parsedDispatch.success) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch identity is invalid",
    );
  }
  const dispatch = deepFreeze(parsedDispatch.data);
  if (row.owner_principal_id !== dispatch.principalId) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch principal does not own the session",
    );
  }
  if (dispatch.dispatchId !== input.dispatchId || dispatch.command.type !== "prompt") {
    throw new ClaimedDispatchAuthorityConflictError(
      "authority belongs only to the exact claimed prompt dispatch",
    );
  }
  const snapshot = dispatch.snapshot;
  if (input.sessionSnapshot !== undefined) {
    const parsedSnapshot = sessionSnapshotSchema.safeParse(input.sessionSnapshot);
    if (!parsedSnapshot.success ||
        canonicalJsonText(parsedSnapshot.data) !== canonicalJsonText(snapshot)) {
      throw new ClaimedDispatchAuthorityConflictError(
        "claimed dispatch no longer binds the immutable session snapshot",
      );
    }
  }
  return Object.freeze({
    dispatch,
    snapshot,
    workerId: input.workerId,
    claimToken: input.claimToken,
    claimExpiresAt,
  });
}

export async function loadClaimedDispatchAuthority(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly now?: () => Date;
  },
): Promise<ClaimedDispatchAuthority> {
  const result = await client.query<ClaimedDispatchRow>(
    `SELECT outbox.dispatch_json, outbox.status, outbox.claim_token,
            outbox.claimed_by, outbox.claim_expires_at,
            session.owner_principal_id
       FROM codeops.session_runtime_outbox AS outbox
       JOIN codeops.sessions AS session
         ON session.session_id = outbox.session_id
      WHERE outbox.dispatch_id = $1`,
    [input.dispatchId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ClaimedDispatchAuthorityNotFoundError(
      `runtime dispatch ${input.dispatchId} was not found`,
    );
  }
  return validateClaimedDispatchAuthority(row, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: input.claimToken,
    now: (input.now ?? (() => new Date()))(),
  });
}

export function selectClaimedWorkspaceSource(
  authority: ClaimedDispatchAuthority,
  input: {
    readonly repository: string;
    readonly resolvedSha?: string;
  },
): ClaimedWorkspaceSourceAuthority {
  if (!isWorkspaceSessionIdentity(authority.snapshot.identity)) {
    throw new ClaimedDispatchAuthorityConflictError(
      "provider authority requires an exact workspace source",
    );
  }
  const source = authority.snapshot.identity.workspace.sources.find(
    (candidate) => candidate.repository === input.repository,
  );
  if (source === undefined ||
      (input.resolvedSha !== undefined && source.resolvedSha !== input.resolvedSha)) {
    throw new ClaimedDispatchAuthorityConflictError(
      "provider authority does not bind the exact workspace source",
    );
  }
  return Object.freeze({ ...source });
}
