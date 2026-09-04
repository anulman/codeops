import {
  canonicalJsonText,
  isWorkspaceSessionIdentity,
  runtimeBindingSchema,
  sessionIdentitySchema,
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
  readonly session_id: unknown;
  readonly session_identity_json: unknown;
  readonly runtime_binding_json: unknown;
  readonly owner_runtime_binding_json: unknown;
  readonly runtime_claim_protocol: unknown;
  readonly legacy_runtime_worker_compatible: unknown;
}

export interface ClaimedDispatchAuthority {
  readonly dispatch: SessionRuntimeDispatch;
  readonly snapshot: SessionSnapshot;
  readonly workerId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly runtimeBinding?: ReturnType<typeof runtimeBindingSchema.parse>;
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
  const runtimeBinding = runtimeBindingSchema.safeParse(row.runtime_binding_json);
  const ownerRuntimeBinding = runtimeBindingSchema.safeParse(
    row.owner_runtime_binding_json,
  );
  const boundV2 = row.runtime_claim_protocol === "bound-v2" &&
    runtimeBinding.success && ownerRuntimeBinding.success &&
    canonicalJsonText(runtimeBinding.data) ===
      canonicalJsonText(ownerRuntimeBinding.data);
  const migrationOwnedLegacy =
    row.runtime_claim_protocol === "legacy-unproven-v1" &&
    row.runtime_binding_json == null &&
    row.legacy_runtime_worker_compatible === true;
  if (!boundV2 && !migrationOwnedLegacy) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch lacks bound-v2 or migration-owned legacy proof",
    );
  }
  const parsedDispatch = sessionRuntimeDispatchSchema.safeParse(row.dispatch_json);
  if (!parsedDispatch.success) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch identity is invalid",
    );
  }
  const dispatch = deepFreeze(parsedDispatch.data);
  const sessionIdentity = sessionIdentitySchema.safeParse(row.session_identity_json);
  if (
    row.session_id !== dispatch.command.sessionId ||
    !sessionIdentity.success ||
    canonicalJsonText(sessionIdentity.data) !==
      canonicalJsonText(dispatch.snapshot.identity)
  ) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch no longer belongs to the immutable session lineage",
    );
  }
  if (row.owner_principal_id !== dispatch.principalId) {
    throw new ClaimedDispatchAuthorityConflictError(
      "claimed dispatch principal does not own the session",
    );
  }
  if (
    dispatch.dispatchId !== input.dispatchId ||
    !["prompt", "resume"].includes(dispatch.command.type)
  ) {
    throw new ClaimedDispatchAuthorityConflictError(
      "authority belongs only to the exact claimed prompt or resume dispatch",
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
    ...(runtimeBinding.success ? { runtimeBinding: runtimeBinding.data } : {}),
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
            outbox.runtime_binding_json, outbox.runtime_claim_protocol,
            codeops.session_runtime_owner_binding(outbox.session_id)
              AS owner_runtime_binding_json,
            session.session_id, session.snapshot_json->'identity'
              AS session_identity_json, session.owner_principal_id,
            session.legacy_runtime_worker_compatible
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

export function assertBrokeredProviderEffects(
  authority: ClaimedDispatchAuthority,
): void {
  if (
    authority.runtimeBinding !== undefined &&
    !authority.runtimeBinding.selectedProfile.authority.brokeredProviderEffects
  ) {
    throw new ClaimedDispatchAuthorityConflictError(
      "selected runtime profile denies brokered provider effects",
    );
  }
}
